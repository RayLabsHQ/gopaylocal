import { describe, it, expect, vi } from "vitest";
import {
  VPN_DATASET_KEY,
  VPN_SOURCES,
  buildVpnDataset,
  checkSectionChange,
  countKeys,
  createFetchText,
  decodeDataset,
  encodeDataset,
  lookupIp,
  mergeRanges,
  parseCidr,
  parseIPv4,
  parseIPv6,
  parseIp,
  parseList,
  sectionToRanges,
  subtractRanges,
  summarizeDataset,
  toWranglerBulkJson,
  validateSource,
  type KeyRange,
  type VpnDataset,
} from "./vpn-dataset";
import { datasetFrom, fetchFrom, smallBodies, smallSources, v4Lines } from "./vpn-test-helpers";

const r = (start: number | bigint, end: number | bigint): KeyRange => ({ start: BigInt(start), end: BigInt(end) });
const ip4 = (s: string) => {
  const p = parseIp(s);
  if (!p) throw new Error(`bad ip ${s}`);
  return p;
};

// ── IPv4 / IPv6 parsing ─────────────────────────────────────────────────────────────

describe("parseIPv4", () => {
  it("parses boundaries", () => {
    expect(parseIPv4("0.0.0.0")).toBe(0);
    expect(parseIPv4("255.255.255.255")).toBe(4294967295);
    expect(parseIPv4("1.2.3.4")).toBe(0x01020304);
    expect(parseIPv4("192.168.0.1")).toBe(3232235521);
  });

  it.each(["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.256", "01.2.3.4", "1.2.3.04", "1..3.4", ".1.2.3",
    "1.2.3.", "1.2.3.4 ", " 1.2.3.4", "a.b.c.d", "1.2.3.-4", "1.2.3.4/24", "1234.1.1.1"])(
    "rejects %j",
    (s) => {
      expect(parseIPv4(s)).toBeNull();
    },
  );
});

describe("parseIPv6", () => {
  it("parses full, compressed and embedded-IPv4 forms", () => {
    expect(parseIPv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("2001:db8::1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("fe80::")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("64:ff9b::192.0.2.33")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x0221]);
    expect(parseIPv6("FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF")).toEqual(Array(8).fill(0xffff));
  });

  it.each(["", ":", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1::2::3", "1:::2", "12345::", "g::1", ":1::",
    "1::2:", "fe80::1%eth0", "::ffff:1.2.3", "::ffff:256.1.1.1", "1.2.3.4", "1:2:3:4:5:6:7:8::"])(
    "rejects %j",
    (s) => {
      expect(parseIPv6(s)).toBeNull();
    },
  );
});

describe("parseIp", () => {
  it("returns IPv4 for dotted quads and IPv4-mapped IPv6", () => {
    expect(parseIp("1.2.3.4")).toEqual({ family: 4, v4: 0x01020304 });
    expect(parseIp("::ffff:1.2.3.4")).toEqual({ family: 4, v4: 0x01020304 });
  });

  it("keeps only the /64 of an IPv6 address", () => {
    expect(parseIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toEqual({ family: 6, hi: 0x20010db8, lo: 0x00010002 });
    expect(parseIp("ffff:ffff:ffff:ffff::")).toEqual({ family: 6, hi: 0xffffffff, lo: 0xffffffff });
  });

  it("returns null for garbage instead of throwing", () => {
    for (const s of ["", "unknown", "1.2.3.4, 5.6.7.8", "::g", "1.2.3.4:443"]) expect(parseIp(s)).toBeNull();
  });
});

// ── CIDR parsing ────────────────────────────────────────────────────────────────────

describe("parseCidr", () => {
  it("computes inclusive IPv4 ranges at boundaries", () => {
    expect(parseCidr("10.0.0.0/8")).toMatchObject({ family: 4, prefix: 8, start: 167772160n, end: 184549375n });
    expect(parseCidr("1.2.3.4")).toMatchObject({ family: 4, prefix: 32, start: 0x01020304n, end: 0x01020304n });
    expect(parseCidr("1.2.3.4/32")).toMatchObject({ start: 0x01020304n, end: 0x01020304n });
    expect(parseCidr("0.0.0.0/0")).toMatchObject({ start: 0n, end: 4294967295n });
    expect(parseCidr("255.255.255.0/24")).toMatchObject({ start: 4294967040n, end: 4294967295n });
  });

  it("rejects set host bits (typical of a truncated line) and bad prefixes", () => {
    for (const s of ["10.0.0.1/24", "64.0.0.1/2", "1.2.3.4/33", "1.2.3.0/024", "1.2.3.0/", "1.2.3.0/a", "1.2.3.0/-1",
      "2001:db8::1/64", "2001:db8::/129", "garbage/24", "1.2.3.0/24/1"]) {
      expect(parseCidr(s), s).toBeNull();
    }
  });

  it("maps IPv6 onto /64 keys, widening longer prefixes to their /64", () => {
    const k = 0x20010db800000000n;
    expect(parseCidr("2001:db8::/32")).toMatchObject({ family: 6, prefix: 32, start: k, end: k | 0xffffffffn });
    expect(parseCidr("2001:db8::/64")).toMatchObject({ start: k, end: k });
    expect(parseCidr("2001:db8::1")).toMatchObject({ prefix: 128, start: k, end: k });
    expect(parseCidr("2001:db8:0:0:8000::/65")).toMatchObject({ start: k, end: k });
    expect(parseCidr("2001:db8:0:1::/63")).toBeNull(); // host bit set within the /63
    expect(parseCidr("2001:db8:0:2::/63")).toMatchObject({ start: k | 2n, end: k | 3n });
    expect(parseCidr("::/0")).toMatchObject({ start: 0n, end: (1n << 64n) - 1n });
  });
});

// ── Range maths ─────────────────────────────────────────────────────────────────────

describe("mergeRanges", () => {
  it("sorts, merges overlaps and adjacency, keeps gaps", () => {
    expect(mergeRanges([r(10, 20), r(0, 5), r(21, 30), r(6, 8), r(40, 50), r(45, 47)])).toEqual([
      r(0, 8),
      r(10, 30),
      r(40, 50),
    ]);
  });

  it("handles empty input, single ranges and full containment", () => {
    expect(mergeRanges([])).toEqual([]);
    expect(mergeRanges([r(5, 5)])).toEqual([r(5, 5)]);
    expect(mergeRanges([r(0, 100), r(10, 20), r(50, 60)])).toEqual([r(0, 100)]);
  });

  it("does not mutate its input", () => {
    const input = [r(5, 6), r(1, 2)];
    mergeRanges(input);
    expect(input).toEqual([r(5, 6), r(1, 2)]);
  });

  it("merges at the top of the IPv4 space", () => {
    expect(mergeRanges([r(4294967040, 4294967295), r(4294966784, 4294967039)])).toEqual([r(4294966784, 4294967295)]);
  });
});

describe("subtractRanges", () => {
  it("punches holes, trims edges and drops fully covered ranges", () => {
    expect(subtractRanges([r(0, 100)], [r(10, 20), r(30, 40)])).toEqual([r(0, 9), r(21, 29), r(41, 100)]);
    expect(subtractRanges([r(0, 100)], [r(0, 10)])).toEqual([r(11, 100)]);
    expect(subtractRanges([r(0, 100)], [r(90, 200)])).toEqual([r(0, 89)]);
    expect(subtractRanges([r(0, 100)], [r(0, 100)])).toEqual([]);
    expect(subtractRanges([r(10, 20)], [r(0, 1000)])).toEqual([]);
  });

  it("handles one removal spanning several base ranges", () => {
    expect(subtractRanges([r(0, 10), r(20, 30), r(40, 50)], [r(5, 45)])).toEqual([r(0, 4), r(46, 50)]);
  });

  it("is a no-op with nothing to remove or no overlap", () => {
    expect(subtractRanges([r(0, 10)], [])).toEqual([r(0, 10)]);
    expect(subtractRanges([r(0, 10)], [r(20, 30)])).toEqual([r(0, 10)]);
    expect(subtractRanges([], [r(0, 10)])).toEqual([]);
  });
});

// ── List parsing ────────────────────────────────────────────────────────────────────

describe("parseList", () => {
  it("parses CIDRs and bare IPs, skipping blanks, comments and CRLF", () => {
    const res = parseList("# header\r\n1.2.3.0/24\r\n\r\n5.6.7.8 # inline\n2001:db8::/32\n", "lines");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.list.entries).toBe(3);
    expect(mergeRanges(res.list.v4)).toEqual([r(0x01020300, 0x010203ff), r(0x05060708, 0x05060708)]);
    expect(res.list.v6).toHaveLength(1);
  });

  it("reads the first CSV column", () => {
    const res = parseList("172.224.226.0/27,GB,GB-EN,London,\n2a02:26f7::/48,US,US-CA,,\n", "csv-first-column");
    expect(res.ok && res.list.entries).toBe(2);
  });

  it("fails the whole list on one malformed line, naming it", () => {
    const res = parseList("1.2.3.0/24\n<html>oops</html>\n5.6.7.0/24\n", "lines");
    expect(res).toEqual({ ok: false, error: expect.stringContaining("line 2") });
  });

  it("rejects a truncated last line", () => {
    const res = parseList("1.2.3.0/24\n64.0.0.0/2", "lines"); // "/24" cut to "/2"
    expect(res.ok).toBe(false);
  });

  it("refuses prefixes broader than /8 (IPv4) and /16 (IPv6)", () => {
    expect(parseList("0.0.0.0/0\n", "lines")).toEqual({ ok: false, error: expect.stringContaining("broader") });
    expect(parseList("0.0.0.0/7\n", "lines").ok).toBe(false);
    expect(parseList("3.0.0.0/8\n", "lines").ok).toBe(true);
    expect(parseList("2000::/3\n", "lines").ok).toBe(false);
    expect(parseList("2001::/16\n", "lines").ok).toBe(true);
  });

  it("coalesces sorted input while parsing without changing the result", () => {
    const lines = v4Lines(1000, 24, "20.0.0.0");
    const sorted = parseList(lines.join("\n"), "lines");
    const shuffled = parseList([...lines].reverse().join("\n"), "lines");
    expect(sorted.ok && shuffled.ok).toBe(true);
    if (!sorted.ok || !shuffled.ok) return;
    expect(sorted.list.v4.length).toBe(1); // coalesced on the fly
    expect(mergeRanges(sorted.list.v4)).toEqual(mergeRanges(shuffled.list.v4));
  });
});

// ── Binary encoding ─────────────────────────────────────────────────────────────────

function sample(): VpnDataset {
  return datasetFrom(
    {
      "tor/4": ["198.51.100.7", "198.51.100.9"],
      "vpn/4": ["10.1.0.0/24", "10.3.0.0/16"],
      "datacenter/4": ["20.0.0.0/16", "255.255.255.0/24"],
      "vpn/6": ["2001:db8:aa::/48", "2a00::/16"],
    },
    1_731_900_000,
  );
}

describe("encodeDataset / decodeDataset", () => {
  it("round-trips sections, ranges and generatedAt", () => {
    const ds = sample();
    const decoded = decodeDataset(encodeDataset(ds));
    expect(decoded).not.toBeNull();
    expect(decoded!.generatedAt).toBe(1_731_900_000);
    expect(decoded!.sections.map((s) => `${s.category}/${s.family}`)).toEqual(["tor/4", "vpn/4", "datacenter/4", "vpn/6"]);
    for (let i = 0; i < ds.sections.length; i++) {
      expect(sectionToRanges(decoded!.sections[i]!)).toEqual(sectionToRanges(ds.sections[i]!));
    }
  });

  it("accepts an ArrayBuffer and a Uint8Array view with an offset", () => {
    const bytes = encodeDataset(sample());
    expect(decodeDataset(bytes.slice().buffer)).not.toBeNull();
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    expect(decodeDataset(padded.subarray(3))).not.toBeNull();
  });

  it("round-trips an empty dataset", () => {
    expect(decodeDataset(encodeDataset({ generatedAt: 1, sections: [] }))).toEqual({ generatedAt: 1, sections: [] });
  });

  it("rejects truncated, padded, wrong-magic and wrong-version blobs", () => {
    const bytes = encodeDataset(sample());
    expect(decodeDataset(bytes.slice(0, bytes.length - 4))).toBeNull();
    expect(decodeDataset(new Uint8Array([...bytes, 0, 0, 0, 0]))).toBeNull();
    expect(decodeDataset(new Uint8Array(0))).toBeNull();
    expect(decodeDataset(new TextEncoder().encode("10.20.30.40,10.20.30.41"))).toBeNull(); // old format
    const badMagic = bytes.slice();
    badMagic[0] = 0x58;
    expect(decodeDataset(badMagic)).toBeNull();
    const badVersion = bytes.slice();
    badVersion[4] = 2;
    expect(decodeDataset(badVersion)).toBeNull();
  });

  it("rejects unknown families/categories, duplicate sections and unsorted ranges", () => {
    const bytes = encodeDataset(sample());
    const badFamily = bytes.slice();
    badFamily[16] = 5;
    expect(decodeDataset(badFamily)).toBeNull();
    const badCategory = bytes.slice();
    badCategory[17] = 9;
    expect(decodeDataset(badCategory)).toBeNull();

    const dup = datasetFrom({ "vpn/4": ["10.0.0.0/24"] });
    dup.sections.push(dup.sections[0]!);
    expect(decodeDataset(encodeDataset(dup))).toBeNull();

    const unsorted = datasetFrom({ "vpn/4": ["10.0.0.0/24", "11.0.0.0/24"] });
    unsorted.sections[0]!.starts.reverse();
    unsorted.sections[0]!.ends.reverse();
    expect(decodeDataset(encodeDataset(unsorted))).toBeNull();

    const inverted = datasetFrom({ "vpn/4": ["10.0.0.0/24"] });
    inverted.sections[0]!.ends[0] = 0;
    expect(decodeDataset(encodeDataset(inverted))).toBeNull();
  });

  it("simulated UTF-8 mangling of the binary value is rejected, not misread", () => {
    const bytes = encodeDataset(sample());
    const mangled = new TextEncoder().encode(new TextDecoder().decode(bytes));
    expect(decodeDataset(mangled)).toBeNull();
  });
});

// ── Lookup ──────────────────────────────────────────────────────────────────────────

describe("lookupIp", () => {
  const ds = decodeDataset(encodeDataset(sample()))!;

  it("hits the first and last address of a range and misses one either side", () => {
    expect(lookupIp(ds, ip4("10.1.0.0"))).toBe("vpn");
    expect(lookupIp(ds, ip4("10.1.0.255"))).toBe("vpn");
    expect(lookupIp(ds, ip4("10.0.255.255"))).toBeNull();
    expect(lookupIp(ds, ip4("10.1.1.0"))).toBeNull();
    expect(lookupIp(ds, ip4("10.3.255.255"))).toBe("vpn");
    expect(lookupIp(ds, ip4("10.4.0.0"))).toBeNull();
  });

  it("matches /32 entries exactly", () => {
    expect(lookupIp(ds, ip4("198.51.100.7"))).toBe("tor");
    expect(lookupIp(ds, ip4("198.51.100.8"))).toBeNull();
    expect(lookupIp(ds, ip4("198.51.100.9"))).toBe("tor");
  });

  it("handles the extremes of the IPv4 space", () => {
    expect(lookupIp(ds, ip4("255.255.255.255"))).toBe("datacenter");
    expect(lookupIp(ds, ip4("0.0.0.0"))).toBeNull();
  });

  it("looks IPv6 up by /64 and never crosses families", () => {
    expect(lookupIp(ds, ip4("2001:db8:aa:ffff:1:2:3:4"))).toBe("vpn");
    expect(lookupIp(ds, ip4("2001:db8:ab::1"))).toBeNull();
    expect(lookupIp(ds, ip4("2a00:ffff:ffff:ffff:ffff::1"))).toBe("vpn");
    expect(lookupIp(ds, ip4("2a01::1"))).toBeNull();
    expect(lookupIp(ds, ip4("::ffff:10.1.0.5"))).toBe("vpn"); // IPv4-mapped uses the IPv4 tables
  });

  it("reports categories in priority order (tor before vpn before datacenter)", () => {
    const overlapping = datasetFrom({ "datacenter/4": ["10.0.0.0/8"], "tor/4": ["10.0.0.1"], "vpn/4": ["10.0.0.0/24"] });
    expect(lookupIp(overlapping, ip4("10.0.0.1"))).toBe("tor");
    expect(lookupIp(overlapping, ip4("10.0.0.2"))).toBe("vpn");
    expect(lookupIp(overlapping, ip4("10.9.9.9"))).toBe("datacenter");
  });

  it("finds every range in a large section (binary search correctness)", () => {
    const big = datasetFrom({ "datacenter/4": v4Lines(5000, 24, "20.0.0.0").filter((_, i) => i % 2 === 0) });
    for (let i = 0; i < 5000; i += 7) {
      const n = 0x14000000 + i * 256 + 17;
      const p = { family: 4 as const, v4: n };
      expect(lookupIp(big, p)).toBe(i % 2 === 0 ? "datacenter" : null);
    }
  });
});

// ── Source validation and the refresh guard ─────────────────────────────────────────

describe("validateSource (real source specs)", () => {
  const dcSpec = VPN_SOURCES["x4b-datacenter-v4"];
  const dcBody = `${v4Lines(12_000, 16, "1.0.0.0").join("\n")}\n`; // 786M addresses, 12K lines

  it("accepts a plausible datacenter list", () => {
    const v = validateSource(dcSpec, { status: 200, text: dcBody });
    expect(v.ok).toBe(true);
  });

  it("rejects non-2xx, empty and truncated downloads", () => {
    expect(validateSource(dcSpec, { status: 503, text: dcBody })).toEqual({ ok: false, reason: "HTTP 503" });
    expect(validateSource(dcSpec, { status: 200, text: "" }).ok).toBe(false);
    const truncatedMidLine = dcBody.slice(0, Math.floor(dcBody.length * 0.6) + 3);
    expect(validateSource(dcSpec, { status: 200, text: truncatedMidLine }).ok).toBe(false);
    const truncatedAtLine = `${v4Lines(5_000, 16, "1.0.0.0").join("\n")}\n`;
    expect(validateSource(dcSpec, { status: 200, text: truncatedAtLine })).toEqual({
      ok: false,
      reason: expect.stringContaining("too small"),
    });
  });

  it("rejects an HTML error page served with 200", () => {
    const html = `<!doctype html><title>Rate limited</title>${" ".repeat(200_000)}`;
    expect(validateSource(dcSpec, { status: 200, text: html })).toEqual({ ok: false, reason: expect.stringContaining("malformed") });
  });

  it("rejects a list that would cover too much of the internet", () => {
    const huge = `${v4Lines(14_000, 16, "1.0.0.0").join("\n")}\n`; // 917M addresses
    expect(validateSource(dcSpec, { status: 200, text: huge })).toEqual({ ok: false, reason: expect.stringContaining("too many") });
    expect(validateSource(dcSpec, { status: 200, text: `${dcBody}0.0.0.0/0\n` }).ok).toBe(false);
  });

  it("rejects the wrong address family", () => {
    const spec = VPN_SOURCES["x4b-vpn-v6"];
    const body = `${Array.from({ length: 200 }, (_, i) => `2001:db8:${i.toString(16)}::/48`).join("\n")}\n1.2.3.0/24\n`;
    expect(validateSource(spec, { status: 200, text: body })).toEqual({ ok: false, reason: expect.stringContaining("IPv4") });
  });

  it("rejects too few entries", () => {
    const spec = VPN_SOURCES["tor-exits"];
    const body = `${Array.from({ length: 100 }, (_, i) => `198.51.100.${i}`).join("\n")}\n${"#".repeat(3000)}\n`;
    expect(validateSource(spec, { status: 200, text: body })).toEqual({ ok: false, reason: expect.stringContaining("too few entries") });
  });
});

describe("checkSectionChange", () => {
  const prev = [r(0, 999)];
  it("allows a first build and normal drift", () => {
    expect(checkSectionChange([r(0, 9)], undefined)).toBeNull();
    expect(checkSectionChange([r(0, 899)], prev)).toBeNull();
    expect(checkSectionChange([r(0, 1499)], prev)).toBeNull();
  });

  it("refuses empty, halved and doubled coverage", () => {
    expect(checkSectionChange([], prev)).toMatch(/empty/);
    expect(checkSectionChange([], undefined)).toMatch(/empty/);
    expect(checkSectionChange([r(0, 400)], prev)).toMatch(/shrank/);
    expect(checkSectionChange([r(0, 2500)], prev)).toMatch(/grew/);
  });

  it("refuses a collapse in range count even if coverage looks similar", () => {
    const many = Array.from({ length: 10 }, (_, i) => r(i * 100, i * 100 + 49));
    expect(checkSectionChange([r(0, 499)], many)).toMatch(/range count/);
  });

  it("compares IPv6-sized counts exactly", () => {
    const big = [r(0n, (1n << 63n) - 1n)];
    expect(checkSectionChange([r(0n, (1n << 61n) - 1n)], big)).toMatch(/shrank/);
  });
});

// ── Dataset build with mocked downloads ─────────────────────────────────────────────

describe("buildVpnDataset", () => {
  const sources = smallSources();
  const fetchTextFor = (bodies: Parameters<typeof fetchFrom>[0]) => createFetchText(fetchFrom(bodies));

  it("builds every section, subtracting Private Relay and the VPN list from datacenter", async () => {
    const res = await buildVpnDataset({ fetchText: fetchTextFor(smallBodies()), previous: null, now: 1_731_900_000_000, sources });
    expect(res.sources.every((s) => s.ok)).toBe(true);
    expect(res.updatedSections).toBe(4);
    expect(res.dataset.generatedAt).toBe(1_731_900_000);
    expect(res.sections.find((s) => s.category === "tor" && s.family === 6)?.status).toBe("empty");

    const ds = res.dataset;
    expect(lookupIp(ds, ip4("10.1.0.9"))).toBe("vpn");
    expect(lookupIp(ds, ip4("20.0.1.1"))).toBe("datacenter");
    expect(lookupIp(ds, ip4("198.51.100.8"))).toBe("tor");
    expect(lookupIp(ds, ip4("30.0.0.5"))).toBeNull(); // Private Relay hole in the datacenter list
    expect(lookupIp(ds, ip4("30.0.0.200"))).toBe("datacenter");
    expect(lookupIp(ds, ip4("2001:db8:aa:1::5"))).toBeNull(); // Private Relay hole in the VPN v6 list
    expect(lookupIp(ds, ip4("2001:db8:aa:2::5"))).toBe("vpn");
    // VPN ranges are not stored twice.
    const dc = ds.sections.find((s) => s.category === "datacenter")!;
    expect(sectionToRanges(dc).some((x) => x.start <= 0x0a010000n && x.end >= 0x0a010000n)).toBe(false);
  });

  it("keeps the previous section when a source it depends on fails, and rebuilds the rest", async () => {
    const first = await buildVpnDataset({ fetchText: fetchTextFor(smallBodies()), previous: null, now: 1e12, sources });
    const bodies: Parameters<typeof fetchFrom>[0] = { ...smallBodies(), "https://test/dc4": "10.1.0.0/24\n<html>" };
    const second = await buildVpnDataset({ fetchText: fetchTextFor(bodies), previous: first.dataset, now: 2e12, sources });

    expect(second.sources.find((s) => s.id === "x4b-datacenter-v4")).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
    expect(second.sections.find((s) => s.category === "datacenter")).toMatchObject({ status: "kept" });
    expect(second.sections.find((s) => s.category === "vpn" && s.family === 4)).toMatchObject({ status: "updated" });
    expect(lookupIp(second.dataset, ip4("20.0.1.1"))).toBe("datacenter"); // carried over
  });

  it("a missing Private Relay list blocks the sections that need it (fail safe, not fail flagged)", async () => {
    const first = await buildVpnDataset({ fetchText: fetchTextFor(smallBodies()), previous: null, now: 1e12, sources });
    const bodies: Parameters<typeof fetchFrom>[0] = { ...smallBodies(), "https://test/apple": { status: 500 } };
    const res = await buildVpnDataset({ fetchText: fetchTextFor(bodies), previous: first.dataset, now: 2e12, sources });
    expect(res.sections.filter((s) => s.status === "kept").map((s) => `${s.category}/${s.family}`).sort()).toEqual([
      "datacenter/4",
      "vpn/4",
      "vpn/6",
    ]);
    expect(res.updatedSections).toBe(1); // tor only

    const noPrevious = await buildVpnDataset({ fetchText: fetchTextFor(bodies), previous: null, now: 2e12, sources });
    expect(noPrevious.dataset.sections.map((s) => s.category)).toEqual(["tor"]);
  });

  it("refuses a section that collapses versus the previous dataset", async () => {
    const prev = datasetFrom({ "datacenter/4": ["20.0.0.0/12"], "vpn/4": ["10.1.0.0/24", "10.2.0.0/24"] });
    const res = await buildVpnDataset({ fetchText: fetchTextFor(smallBodies()), previous: prev, now: 1e12, sources });
    expect(res.sections.find((s) => s.category === "datacenter")).toMatchObject({ status: "kept", reason: expect.stringContaining("shrank") });
    expect(lookupIp(res.dataset, ip4("20.5.0.1"))).toBe("datacenter");
  });

  it("survives every fetch throwing: nothing updated, previous kept", async () => {
    const prev = sample();
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await buildVpnDataset({ fetchText: createFetchText(failing), previous: prev, now: 1e12, sources });
    expect(res.updatedSections).toBe(0);
    expect(res.sources.every((s) => !s.ok && s.reason?.includes("network down"))).toBe(true);
    expect(res.dataset.sections).toHaveLength(prev.sections.length);
  });
});

// ── Fetch helper and seeding-script helpers ─────────────────────────────────────────

describe("createFetchText", () => {
  it("returns the body and status", async () => {
    const ft = createFetchText(fetchFrom({ "https://x/a": "1.2.3.4\n" }));
    expect(await ft("https://x/a", 100)).toEqual({ status: 200, text: "1.2.3.4\n" });
  });

  it("returns non-2xx with an empty body (validation then rejects it)", async () => {
    const ft = createFetchText(fetchFrom({}));
    expect(await ft("https://x/missing", 100)).toEqual({ status: 404, text: "" });
  });

  it("aborts bodies larger than the cap instead of buffering them", async () => {
    const ft = createFetchText(fetchFrom({ "https://x/big": "x".repeat(5000) }));
    await expect(ft("https://x/big", 1000)).rejects.toThrow(/exceeds/);
  });

  it("passes an abort signal so a hung download times out", async () => {
    const spy = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok");
    });
    await createFetchText(spy as unknown as typeof fetch)("https://x", 10);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("seeding-script helpers", () => {
  it("toWranglerBulkJson emits one base64 entry that decodes to the exact bytes", () => {
    const bytes = encodeDataset(sample());
    const parsed = JSON.parse(toWranglerBulkJson(bytes)) as Array<{ key: string; value: string; base64: boolean }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.key).toBe(VPN_DATASET_KEY);
    expect(parsed[0]!.base64).toBe(true);
    const back = Uint8Array.from(atob(parsed[0]!.value), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
    expect(decodeDataset(back)).not.toBeNull();
  });

  it("toWranglerBulkJson handles values larger than one encoding chunk", () => {
    const big = datasetFrom({ "datacenter/4": v4Lines(20_000, 24, "20.0.0.0").filter((_, i) => i % 2 === 0) });
    const bytes = encodeDataset(big);
    expect(bytes.length).toBeGreaterThan(0x8000);
    const parsed = JSON.parse(toWranglerBulkJson(bytes)) as Array<{ value: string }>;
    expect(Uint8Array.from(atob(parsed[0]!.value), (c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it("summarizeDataset reports ranges and coverage per section", () => {
    expect(summarizeDataset(datasetFrom({ "vpn/4": ["10.0.0.0/24", "10.0.2.0/23"], "vpn/6": ["2001:db8::/63"] }))).toEqual([
      { section: "vpn/ipv4", ranges: 2, covered: "768" },
      { section: "vpn/ipv6", ranges: 1, covered: "2" },
    ]);
    expect(countKeys([])).toBe(0n);
  });
});
