/**
 * VPN / datacenter / Tor IP dataset: list parsing, validation, range maths, a compact
 * binary encoding, and lookup. Shared by the Worker (lookup + daily refresh) and the
 * local seeding script (`apps/api/scripts/build-vpn-dataset.ts`).
 *
 * SELF-CONTAINED ON PURPOSE: this module has no imports, so the seeding script can load
 * it with plain Node (Node 22.18+/24 strips TypeScript types natively, but only follows
 * relative imports that carry a `.ts` extension, which the Worker's tsconfig does not
 * allow). Keep it import-free and stick to erasable TypeScript syntax (no enums,
 * namespaces or constructor parameter properties).
 *
 * ── Data sources (terms and cadence checked 2026-11-18) ────────────────────────────────
 *
 * 1. X4BNet/lists_vpn: https://github.com/X4BNet/lists_vpn
 *    - output/vpn/ipv4.txt: known VPN provider networks. Used as category "vpn".
 *    - output/datacenter/ipv4.txt: "VPNs and Datacenters ... anything that is not an
 *      eyeball network". Used as category "datacenter" (minus the VPN list).
 *    - output/vpn/ipv6.txt: VPN provider IPv6 networks. Used as category "vpn".
 *    License: README says the scripts, curated inputs and generated lists are MIT. The
 *    lists are built from the IPLocate.io IP-to-ASN database, which is CC BY-SA 4.0 and
 *    asks for the credit "IP address data powered by IPLocate.io" with a link
 *    (https://github.com/iplocate/ip-address-databases). We credit both in the docs.
 *    Cadence: rebuilt daily by GitHub Actions (`.github/workflows/build-list.yml`,
 *    cron `45 8 * * *` UTC).
 *    The datacenter IPv6 list is deliberately NOT used: the ASN check in
 *    vpn-detect.service.ts already covers the large clouds on IPv6, and the long tail
 *    adds false-positive risk for little gain (for example it contains 2001:470::/32,
 *    Hurricane Electric's block that also serves its free IPv6 tunnel broker for home
 *    users). Revisit if IPv6 VPN abuse shows up in practice.
 *
 * 2. Tor Project bulk exit list: https://check.torproject.org/torbulkexitlist
 *    One exit IP per line. The Tor Project provides it so services can "query locally"
 *    (https://blog.torproject.org/changes-tor-exit-list-service/, 2020-03-09); the same
 *    exit-list data is archived by Tor Metrics/CollecTor under CC0
 *    (https://metrics.torproject.org/: "Data on this site is freely available under a
 *    CC0 no copyright declaration"). Updated frequently (Last-Modified was under an hour
 *    old when checked). We refresh it daily with everything else.
 *
 * 3. Apple iCloud Private Relay egress ranges (EXCLUSION list, never stored):
 *    https://mask-api.icloud.com/egress-ip-ranges.csv
 *    Apple publishes these for server operators and states "Private Relay preserves the
 *    region the user is in, so your server can trust the region assigned to the IP
 *    address it sees" (https://developer.apple.com/icloud/prepare-your-network-for-icloud-private-relay/).
 *    A Private Relay user is therefore not a country spoofer, so their egress ranges are
 *    subtracted from the VPN and datacenter categories (X4BNet's VPN list includes them,
 *    and they sit inside Akamai, Cloudflare and Fastly address space).
 *
 * ── Key space ──────────────────────────────────────────────────────────────────────────
 * IPv4 ranges are stored per address (32-bit keys). IPv6 ranges are stored per /64
 * (the top 64 bits of the address): a /64 is one subscriber LAN, so a listed prefix
 * longer than /64 widens to its whole /64. That halves the storage and keeps lookups to
 * two 32-bit compares.
 */

// ── IP address parsing ───────────────────────────────────────────────────────────────

/** Parse a dotted-quad IPv4 address into an unsigned 32-bit integer. Strict: four decimal
 * octets 0-255, no leading zeros, no whitespace. Returns null on anything else. */
export function parseIPv4(s: string): number | null {
  const len = s.length;
  if (len < 7 || len > 15) return null;
  let value = 0;
  let octet = 0;
  let digits = 0;
  let dots = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c === 46 /* . */) {
      if (digits === 0 || dots === 3) return null;
      value = value * 256 + octet;
      octet = 0;
      digits = 0;
      dots++;
    } else if (c >= 48 && c <= 57) {
      if (digits > 0 && octet === 0) return null; // leading zero ("01")
      octet = octet * 10 + (c - 48);
      if (octet > 255) return null;
      digits++;
    } else {
      return null;
    }
  }
  if (dots !== 3 || digits === 0) return null;
  return value * 256 + octet;
}

function parseHextet(g: string): number | null {
  if (g.length < 1 || g.length > 4) return null;
  let v = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g.charCodeAt(i);
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    else return null;
    v = v * 16 + d;
  }
  return v;
}

/** Parse an IPv6 address (RFC 4291 text forms, including `::` and an embedded dotted
 * IPv4 tail) into its eight 16-bit groups. Zone IDs are rejected. Returns null if
 * malformed. */
export function parseIPv6(s: string): number[] | null {
  if (s.length < 2 || s.length > 45) return null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon === -1) return null;

  let body = s;
  let tailV4: number | null = null;
  if (s.indexOf(".", lastColon) !== -1) {
    tailV4 = parseIPv4(s.slice(lastColon + 1));
    if (tailV4 === null) return null;
    body = `${s.slice(0, lastColon + 1)}0:0`; // two placeholder groups for the IPv4 tail
  }

  const dbl = body.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dbl === -1) {
    head = body.split(":");
    tail = [];
    if (head.length !== 8) return null;
  } else {
    if (body.indexOf("::", dbl + 1) !== -1) return null;
    const h = body.slice(0, dbl);
    const t = body.slice(dbl + 2);
    head = h === "" ? [] : h.split(":");
    tail = t === "" ? [] : t.split(":");
    if (head.length + tail.length > 7) return null;
  }

  const groups = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < head.length; i++) {
    const g = parseHextet(head[i]!);
    if (g === null) return null;
    groups[i] = g;
  }
  for (let i = 0; i < tail.length; i++) {
    const g = parseHextet(tail[i]!);
    if (g === null) return null;
    groups[8 - tail.length + i] = g;
  }
  if (tailV4 !== null) {
    groups[6] = Math.floor(tailV4 / 65536);
    groups[7] = tailV4 % 65536;
  }
  return groups;
}

/** A visitor address in lookup form. IPv6 keeps only its /64 (two unsigned 32-bit words). */
export type ParsedIp =
  | { family: 4; v4: number }
  | { family: 6; hi: number; lo: number };

/** Parse a visitor IP (e.g. `cf-connecting-ip`). IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is
 * treated as the IPv4 address it carries. Returns null for anything unparseable. */
export function parseIp(input: string): ParsedIp | null {
  if (input.indexOf(":") === -1) {
    const v4 = parseIPv4(input);
    return v4 === null ? null : { family: 4, v4 };
  }
  const g = parseIPv6(input);
  if (!g) return null;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return { family: 4, v4: g[6]! * 65536 + g[7]! };
  }
  return { family: 6, hi: g[0]! * 65536 + g[1]!, lo: g[2]! * 65536 + g[3]! };
}

// ── CIDR parsing and range maths (build time; bigint keeps IPv6 exact) ───────────────

/** Inclusive range of keys (IPv4 addresses, or IPv6 /64 prefixes). */
export interface KeyRange {
  start: bigint;
  end: bigint;
}

export interface ParsedCidr extends KeyRange {
  family: 4 | 6;
  prefix: number;
}

function parsePrefix(s: string, max: number): number | null {
  if (s.length < 1 || s.length > 3) return null;
  if (s.length > 1 && s.charCodeAt(0) === 48) return null; // leading zero
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;
    v = v * 10 + (c - 48);
  }
  return v <= max ? v : null;
}

/** Parse `a.b.c.d`, `a.b.c.d/n`, an IPv6 address, or `ipv6/n` into a key range. Host bits
 * must be zero (a CIDR with host bits set is treated as malformed: it is a typical sign
 * of a truncated line such as `64.0.0.0/2` cut from `/24`). Returns null if invalid. */
export function parseCidr(text: string): ParsedCidr | null {
  const slash = text.indexOf("/");
  const addr = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);

  if (addr.indexOf(":") === -1) {
    const ip = parseIPv4(addr);
    if (ip === null) return null;
    const prefix = prefixText === null ? 32 : parsePrefix(prefixText, 32);
    if (prefix === null) return null;
    const size = 2 ** (32 - prefix);
    if (ip % size !== 0) return null;
    return { family: 4, prefix, start: BigInt(ip), end: BigInt(ip + size - 1) };
  }

  const groups = parseIPv6(addr);
  if (!groups) return null;
  const prefix = prefixText === null ? 128 : parsePrefix(prefixText, 128);
  if (prefix === null) return null;
  // Work per 16-bit group with plain numbers (Apple's list has ~243K IPv6 lines, and
  // 128-bit BigInt maths per line was most of the refresh's CPU time).
  const endGroups = [0, 0, 0, 0];
  for (let i = 0; i < 8; i++) {
    const inPrefix = Math.min(16, Math.max(0, prefix - i * 16)); // bits of group i inside the prefix
    const hostMask = inPrefix >= 16 ? 0 : 0xffff >> inPrefix;
    const g = groups[i]!;
    if ((g & hostMask) !== 0) return null;
    if (i < 4) endGroups[i] = g | hostMask;
  }
  return {
    family: 6,
    prefix,
    start: toU64(groups[0]!, groups[1]!, groups[2]!, groups[3]!),
    end: toU64(endGroups[0]!, endGroups[1]!, endGroups[2]!, endGroups[3]!),
  };
}

function toU64(g0: number, g1: number, g2: number, g3: number): bigint {
  return (BigInt(g0 * 65536 + g1) << 32n) | BigInt(g2 * 65536 + g3);
}

function compareStart(a: KeyRange, b: KeyRange): number {
  return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
}

/** Sort and coalesce overlapping or adjacent ranges. Returns a new, disjoint, sorted list. */
export function mergeRanges(ranges: readonly KeyRange[]): KeyRange[] {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort(compareStart);
  const out: KeyRange[] = [];
  let cur: KeyRange = { start: sorted[0]!.start, end: sorted[0]!.end };
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.start <= cur.end + 1n) {
      if (r.end > cur.end) cur.end = r.end;
    } else {
      out.push(cur);
      cur = { start: r.start, end: r.end };
    }
  }
  out.push(cur);
  return out;
}

/** `base` minus `remove`. Both inputs must already be merged (sorted and disjoint). */
export function subtractRanges(base: readonly KeyRange[], remove: readonly KeyRange[]): KeyRange[] {
  const out: KeyRange[] = [];
  let j = 0;
  for (const r of base) {
    let start = r.start;
    const end = r.end;
    while (j < remove.length && remove[j]!.end < start) j++;
    for (let k = j; k < remove.length && remove[k]!.start <= end; k++) {
      const x = remove[k]!;
      if (x.start > start) out.push({ start, end: x.start - 1n });
      if (x.end >= end) {
        start = end + 1n;
        break;
      }
      if (x.end + 1n > start) start = x.end + 1n;
    }
    if (start <= end) out.push({ start, end });
  }
  return out;
}

/** Number of keys covered (IPv4 addresses, or IPv6 /64s). */
export function countKeys(ranges: readonly KeyRange[]): bigint {
  let total = 0n;
  for (const r of ranges) total += r.end - r.start + 1n;
  return total;
}

// ── List parsing (strict) ────────────────────────────────────────────────────────────

/** `lines`: one IP or CIDR per line (X4BNet, Tor). `csv-first-column`: CIDR in the first
 * comma-separated column (Apple's egress-ip-ranges.csv). Blank lines and `#` comments are
 * ignored in both. */
export type ListFormat = "lines" | "csv-first-column";

export interface ParsedList {
  v4: KeyRange[];
  v6: KeyRange[];
  entries: number;
}

export type ParseListResult = { ok: true; list: ParsedList } | { ok: false; error: string };

/** Shortest prefix accepted from a list. Anything broader is far more likely to be a
 * corrupt or hostile line than a real network (a stray `0.0.0.0/0` would deny every
 * visitor their discount). The real lists bottom out at /8 (IPv4) and /20 (IPv6). */
export const MIN_PREFIX_V4 = 8;
export const MIN_PREFIX_V6 = 16;

/** Append `r`, extending the previous range instead when the input is in ascending order
 * and `r` touches it. Sorted inputs (Apple's 243K-line IPv6 section collapses to ~6K
 * ranges) then never materialise one object per line; unsorted input is still correct
 * because callers run mergeRanges afterwards. */
function pushCoalesced(out: KeyRange[], start: bigint, end: bigint): void {
  const last = out[out.length - 1];
  if (last && start >= last.start && start <= last.end + 1n) {
    if (end > last.end) last.end = end;
    return;
  }
  out.push({ start, end });
}

/** Parse a downloaded list. Strict: any line that is not blank, a comment, or a valid
 * IP/CIDR fails the whole list, so a truncated or garbled download is rejected rather
 * than half-applied. Ranges are returned not yet sorted/merged (run mergeRanges). */
export function parseList(text: string, format: ListFormat): ParseListResult {
  const v4: KeyRange[] = [];
  const v6: KeyRange[] = [];
  let entries = 0;
  let lineNo = 0;
  let pos = 0;
  const len = text.length;
  while (pos <= len) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = len;
    lineNo++;
    let line = text.slice(pos, nl);
    pos = nl + 1;

    const hash = line.indexOf("#");
    if (hash !== -1) line = line.slice(0, hash);
    if (format === "csv-first-column") {
      const comma = line.indexOf(",");
      if (comma !== -1) line = line.slice(0, comma);
    }
    line = line.trim();
    if (line === "") continue;

    const cidr = parseCidr(line);
    if (!cidr) return { ok: false, error: `line ${lineNo}: not a valid IP/CIDR: ${JSON.stringify(line.slice(0, 60))}` };
    const minPrefix = cidr.family === 4 ? MIN_PREFIX_V4 : MIN_PREFIX_V6;
    if (cidr.prefix < minPrefix) {
      return { ok: false, error: `line ${lineNo}: prefix /${cidr.prefix} is broader than /${minPrefix}` };
    }
    pushCoalesced(cidr.family === 4 ? v4 : v6, cidr.start, cidr.end);
    entries++;
  }
  return { ok: true, list: { v4, v6, entries } };
}

// ── Dataset model + binary encoding ──────────────────────────────────────────────────

/** KV key (in the VPN_DATA namespace) holding the encoded dataset. Bump the `v1` together
 * with DATASET_FORMAT_VERSION if the layout ever changes incompatibly. */
export const VPN_DATASET_KEY = "vpn:v1:dataset";
/** KV key holding a small JSON report of the last refresh run (for humans/debugging). */
export const VPN_STATUS_KEY = "vpn:v1:status";

export type VpnCategory = "vpn" | "datacenter" | "tor";

/** Order matters: lookups report the first matching category. */
export const CATEGORY_ORDER: readonly VpnCategory[] = ["tor", "vpn", "datacenter"];

const CATEGORY_CODE: Record<VpnCategory, number> = { vpn: 1, datacenter: 2, tor: 3 };
const CATEGORY_BY_CODE: Record<number, VpnCategory | undefined> = { 1: "vpn", 2: "datacenter", 3: "tor" };

/** One sorted, disjoint range list. IPv4: one u32 per key. IPv6: two u32 words (hi, lo)
 * per /64 key, interleaved. `starts` and `ends` are inclusive. */
export interface VpnSection {
  family: 4 | 6;
  category: VpnCategory;
  starts: Uint32Array;
  ends: Uint32Array;
}

export interface VpnDataset {
  /** Unix seconds when this dataset was built. */
  generatedAt: number;
  sections: VpnSection[];
}

export function sectionRangeCount(s: VpnSection): number {
  return s.family === 4 ? s.starts.length : s.starts.length / 2;
}

/** Convert merged bigint ranges into a typed-array section. */
export function toSection(family: 4 | 6, category: VpnCategory, ranges: readonly KeyRange[]): VpnSection {
  const words = family === 4 ? 1 : 2;
  const starts = new Uint32Array(ranges.length * words);
  const ends = new Uint32Array(ranges.length * words);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    if (family === 4) {
      starts[i] = Number(r.start);
      ends[i] = Number(r.end);
    } else {
      starts[2 * i] = Number(r.start >> 32n);
      starts[2 * i + 1] = Number(r.start & 0xffffffffn);
      ends[2 * i] = Number(r.end >> 32n);
      ends[2 * i + 1] = Number(r.end & 0xffffffffn);
    }
  }
  return { family, category, starts, ends };
}

/** Convert a section back to bigint ranges (used to compare against a previous dataset). */
export function sectionToRanges(s: VpnSection): KeyRange[] {
  const out: KeyRange[] = [];
  if (s.family === 4) {
    for (let i = 0; i < s.starts.length; i++) out.push({ start: BigInt(s.starts[i]!), end: BigInt(s.ends[i]!) });
  } else {
    for (let i = 0; i < s.starts.length; i += 2) {
      out.push({
        start: (BigInt(s.starts[i]!) << 32n) | BigInt(s.starts[i + 1]!),
        end: (BigInt(s.ends[i]!) << 32n) | BigInt(s.ends[i + 1]!),
      });
    }
  }
  return out;
}

/*
 * Binary layout, version 1 (all integers little-endian):
 *   0   4  magic "GPLV"
 *   4   1  format version (1)
 *   5   1  section count
 *   6   2  reserved (0)
 *   8   4  generatedAt (unix seconds)
 *  12   4  reserved (0)
 *  16   8 × sectionCount  section table: family u8 (4|6), category u8, reserved u16, rangeCount u32
 *  ...  per section, in table order: starts[rangeCount × words], ends[rangeCount × words] (u32)
 * Every offset is a multiple of 4, so a little-endian host can view the KV ArrayBuffer
 * directly as Uint32Arrays with no copying.
 */
const MAGIC = [0x47, 0x50, 0x4c, 0x56]; // "GPLV"
export const DATASET_FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const TABLE_ENTRY_BYTES = 8;
const MAX_SECTIONS = 16;

export function encodeDataset(ds: VpnDataset): Uint8Array {
  if (ds.sections.length > MAX_SECTIONS) throw new Error("too many sections");
  let total = HEADER_BYTES + TABLE_ENTRY_BYTES * ds.sections.length;
  for (const s of ds.sections) total += (s.starts.length + s.ends.length) * 4;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(MAGIC, 0);
  view.setUint8(4, DATASET_FORMAT_VERSION);
  view.setUint8(5, ds.sections.length);
  view.setUint32(8, ds.generatedAt >>> 0, true);
  let off = HEADER_BYTES;
  for (const s of ds.sections) {
    view.setUint8(off, s.family);
    view.setUint8(off + 1, CATEGORY_CODE[s.category]);
    view.setUint32(off + 4, sectionRangeCount(s), true);
    off += TABLE_ENTRY_BYTES;
  }
  for (const s of ds.sections) {
    for (const arr of [s.starts, s.ends]) {
      for (let i = 0; i < arr.length; i++, off += 4) view.setUint32(off, arr[i]!, true);
    }
  }
  return bytes;
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function compare64(aHi: number, aLo: number, bHi: number, bLo: number): number {
  if (aHi !== bHi) return aHi < bHi ? -1 : 1;
  if (aLo !== bLo) return aLo < bLo ? -1 : 1;
  return 0;
}

/** True when every range has start <= end and ranges are strictly increasing and disjoint. */
function isSortedDisjoint(s: VpnSection): boolean {
  const { starts, ends } = s;
  if (s.family === 4) {
    for (let i = 0; i < starts.length; i++) {
      if (starts[i]! > ends[i]!) return false;
      if (i > 0 && starts[i]! <= ends[i - 1]!) return false;
    }
    return true;
  }
  for (let i = 0; i < starts.length; i += 2) {
    if (compare64(starts[i]!, starts[i + 1]!, ends[i]!, ends[i + 1]!) > 0) return false;
    if (i > 0 && compare64(starts[i]!, starts[i + 1]!, ends[i - 2]!, ends[i - 1]!) <= 0) return false;
  }
  return true;
}

/** Decode a dataset blob. Returns null (never throws) if the blob is the wrong size,
 * has the wrong magic/version, or contains unsorted/overlapping ranges, so a corrupt
 * value in KV degrades to "no list data" instead of wrong answers. */
export function decodeDataset(input: ArrayBuffer | Uint8Array): VpnDataset | null {
  try {
    let buf: ArrayBuffer;
    if (input instanceof Uint8Array) {
      buf = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength
        ? (input.buffer as ArrayBuffer)
        : (input.slice().buffer as ArrayBuffer);
    } else {
      buf = input;
    }
    if (buf.byteLength < HEADER_BYTES) return null;
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) if (view.getUint8(i) !== MAGIC[i]) return null;
    if (view.getUint8(4) !== DATASET_FORMAT_VERSION) return null;
    const count = view.getUint8(5);
    if (count > MAX_SECTIONS) return null;
    const generatedAt = view.getUint32(8, true);

    let off = HEADER_BYTES;
    if (buf.byteLength < off + count * TABLE_ENTRY_BYTES) return null;
    const table: Array<{ family: 4 | 6; category: VpnCategory; n: number }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < count; i++, off += TABLE_ENTRY_BYTES) {
      const family = view.getUint8(off);
      const category = CATEGORY_BY_CODE[view.getUint8(off + 1)];
      const n = view.getUint32(off + 4, true);
      if ((family !== 4 && family !== 6) || !category) return null;
      const id = `${family}:${category}`;
      if (seen.has(id)) return null;
      seen.add(id);
      table.push({ family, category, n });
    }

    let expected = off;
    for (const t of table) expected += t.n * (t.family === 4 ? 1 : 2) * 2 * 4;
    if (expected !== buf.byteLength) return null;

    const sections: VpnSection[] = [];
    for (const t of table) {
      const words = t.n * (t.family === 4 ? 1 : 2);
      let starts: Uint32Array;
      let ends: Uint32Array;
      if (LITTLE_ENDIAN_HOST) {
        starts = new Uint32Array(buf, off, words);
        ends = new Uint32Array(buf, off + words * 4, words);
      } else {
        starts = new Uint32Array(words);
        ends = new Uint32Array(words);
        for (let i = 0; i < words; i++) {
          starts[i] = view.getUint32(off + i * 4, true);
          ends[i] = view.getUint32(off + (words + i) * 4, true);
        }
      }
      off += words * 2 * 4;
      const section: VpnSection = { family: t.family, category: t.category, starts, ends };
      if (!isSortedDisjoint(section)) return null;
      sections.push(section);
    }
    return { generatedAt, sections };
  } catch {
    return null;
  }
}

// ── Lookup (hot path: binary search, no allocation) ──────────────────────────────────

function inV4(starts: Uint32Array, ends: Uint32Array, ip: number): boolean {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= ip) {
      if (ip <= ends[mid]!) return true;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return false;
}

function inV6(starts: Uint32Array, ends: Uint32Array, hi64: number, lo64: number): boolean {
  let lo = 0;
  let hi = starts.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (compare64(starts[2 * mid]!, starts[2 * mid + 1]!, hi64, lo64) <= 0) {
      if (compare64(hi64, lo64, ends[2 * mid]!, ends[2 * mid + 1]!) <= 0) return true;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return false;
}

/** Return the first matching category (in CATEGORY_ORDER), or null. */
export function lookupIp(ds: VpnDataset, ip: ParsedIp): VpnCategory | null {
  for (const category of CATEGORY_ORDER) {
    for (const s of ds.sections) {
      if (s.category !== category || s.family !== ip.family) continue;
      const hit = ip.family === 4 ? inV4(s.starts, s.ends, ip.v4) : inV6(s.starts, s.ends, ip.hi, ip.lo);
      if (hit) return category;
    }
  }
  return null;
}

// ── Sources, validation and dataset build ────────────────────────────────────────────

export type VpnSourceId = "x4b-vpn-v4" | "x4b-datacenter-v4" | "x4b-vpn-v6" | "tor-exits" | "apple-private-relay";

export interface VpnSourceSpec {
  id: VpnSourceId;
  url: string;
  format: ListFormat;
  /** Address family the file must contain; "any" allows both. */
  family: 4 | 6 | "any";
  /** Reject bodies outside these byte sizes (empty / truncated / runaway downloads). */
  minBytes: number;
  maxBytes: number;
  /** Reject lists with fewer parsed entries than this. */
  minEntries: number;
  /** Optional bounds on IPv4 addresses covered after merging. */
  minV4Addresses?: number;
  maxV4Addresses?: number;
}

/*
 * Bounds are deliberately loose: wide enough that normal upstream drift never trips them,
 * tight enough to catch an empty, truncated, or garbage download. Measured 2026-11-18:
 * X4B vpn v4 11,080 lines / 3.33M addresses (upstream CI expects 2M-4M); X4B datacenter
 * v4 45,820 lines / 408M addresses (upstream CI expects 250M-425M); X4B vpn v6 703
 * lines; Tor 1,281 exits; Apple 285,194 lines (41,831 IPv4 / 105,744 addresses).
 */
export const VPN_SOURCES: Record<VpnSourceId, VpnSourceSpec> = {
  "x4b-vpn-v4": {
    id: "x4b-vpn-v4",
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt",
    format: "lines",
    family: 4,
    minBytes: 20_000,
    maxBytes: 8_000_000,
    minEntries: 1_000,
    minV4Addresses: 500_000,
    maxV4Addresses: 50_000_000,
  },
  "x4b-datacenter-v4": {
    id: "x4b-datacenter-v4",
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt",
    format: "lines",
    family: 4,
    minBytes: 100_000,
    maxBytes: 16_000_000,
    minEntries: 10_000,
    minV4Addresses: 100_000_000,
    // ~20% of the IPv4 space. Upstream is ~408M today; much beyond this ceiling would
    // start catching eyeball networks, so refuse rather than deny discounts at scale.
    maxV4Addresses: 850_000_000,
  },
  "x4b-vpn-v6": {
    id: "x4b-vpn-v6",
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv6.txt",
    format: "lines",
    family: 6,
    minBytes: 1_000,
    maxBytes: 8_000_000,
    minEntries: 100,
  },
  "tor-exits": {
    id: "tor-exits",
    url: "https://check.torproject.org/torbulkexitlist",
    format: "lines",
    family: "any",
    minBytes: 2_000,
    maxBytes: 4_000_000,
    minEntries: 300,
  },
  "apple-private-relay": {
    id: "apple-private-relay",
    url: "https://mask-api.icloud.com/egress-ip-ranges.csv",
    format: "csv-first-column",
    family: "any",
    minBytes: 1_000_000,
    maxBytes: 64_000_000,
    minEntries: 50_000,
    minV4Addresses: 20_000,
    maxV4Addresses: 5_000_000,
  },
};

export interface FetchedText {
  status: number;
  text: string;
}

/** Fetch a URL as text. Implementations should reject (not truncate) bodies larger than
 * `maxBytes`. */
export type FetchText = (url: string, maxBytes: number) => Promise<FetchedText>;

export type SourceValidation =
  | { ok: true; entries: number; v4: KeyRange[]; v6: KeyRange[] }
  | { ok: false; reason: string };

/** Validate one downloaded source against its spec. Returns merged v4/v6 ranges on success. */
export function validateSource(spec: VpnSourceSpec, res: FetchedText): SourceValidation {
  if (res.status < 200 || res.status > 299) return { ok: false, reason: `HTTP ${res.status}` };
  const bytes = res.text.length;
  if (bytes < spec.minBytes) return { ok: false, reason: `body too small (${bytes} < ${spec.minBytes} chars)` };
  if (bytes > spec.maxBytes) return { ok: false, reason: `body too large (${bytes} > ${spec.maxBytes} chars)` };

  const parsed = parseList(res.text, spec.format);
  if (!parsed.ok) return { ok: false, reason: `malformed: ${parsed.error}` };
  const { list } = parsed;
  if (list.entries < spec.minEntries) {
    return { ok: false, reason: `too few entries (${list.entries} < ${spec.minEntries})` };
  }
  if (spec.family === 4 && list.v6.length > 0) return { ok: false, reason: "unexpected IPv6 entries in an IPv4 list" };
  if (spec.family === 6 && list.v4.length > 0) return { ok: false, reason: "unexpected IPv4 entries in an IPv6 list" };

  const v4 = mergeRanges(list.v4);
  const v6 = mergeRanges(list.v6);
  const v4Addresses = Number(countKeys(v4));
  if (spec.minV4Addresses !== undefined && v4Addresses < spec.minV4Addresses) {
    return { ok: false, reason: `covers too few IPv4 addresses (${v4Addresses} < ${spec.minV4Addresses})` };
  }
  if (spec.maxV4Addresses !== undefined && v4Addresses > spec.maxV4Addresses) {
    return { ok: false, reason: `covers too many IPv4 addresses (${v4Addresses} > ${spec.maxV4Addresses})` };
  }
  return { ok: true, entries: list.entries, v4, v6 };
}

/** Relative-change guard for a rebuilt section versus the one already in KV. A section
 * that shrinks below half, or grows past double, of what it covered before is refused
 * (the previous section is kept) because that is far more likely to be an upstream
 * accident than a real change in one day. */
export const MAX_SHRINK_RATIO = 0.5;
export const MAX_GROWTH_RATIO = 2;

export function checkSectionChange(next: readonly KeyRange[], previous: readonly KeyRange[] | undefined): string | null {
  if (next.length === 0) return "rebuilt section is empty";
  if (!previous || previous.length === 0) return null;
  const nextKeys = countKeys(next);
  const prevKeys = countKeys(previous);
  // Compare with integer maths (IPv6 key counts exceed 2^53).
  if (nextKeys * 2n < prevKeys) {
    return `coverage shrank below ${MAX_SHRINK_RATIO * 100}% of the previous dataset (${nextKeys} vs ${prevKeys})`;
  }
  if (nextKeys > prevKeys * 2n) {
    return `coverage grew past ${MAX_GROWTH_RATIO}x the previous dataset (${nextKeys} vs ${prevKeys})`;
  }
  if (next.length * 2 < previous.length) {
    return `range count shrank below ${MAX_SHRINK_RATIO * 100}% of the previous dataset (${next.length} vs ${previous.length})`;
  }
  return null;
}

export interface SourceReport {
  id: VpnSourceId;
  ok: boolean;
  reason?: string;
  chars?: number;
  entries?: number;
}

export interface SectionReport {
  family: 4 | 6;
  category: VpnCategory;
  /** updated: rebuilt from today's downloads. kept: previous section carried over.
   * absent: no usable data and nothing to carry over. empty: the sources are fine but
   * contribute nothing to this section (e.g. the Tor list has no IPv6 exits). */
  status: "updated" | "kept" | "absent" | "empty";
  reason?: string;
  ranges: number;
}

export interface BuildResult {
  dataset: VpnDataset;
  updatedSections: number;
  sections: SectionReport[];
  sources: SourceReport[];
}

interface SectionPlan {
  family: 4 | 6;
  category: VpnCategory;
  needs: VpnSourceId[];
  build: (src: Map<VpnSourceId, { v4: KeyRange[]; v6: KeyRange[] }>) => KeyRange[];
}

function from(src: Map<VpnSourceId, { v4: KeyRange[]; v6: KeyRange[] }>, id: VpnSourceId) {
  const s = src.get(id);
  if (!s) throw new Error(`missing source ${id}`);
  return s;
}

/** How each stored section is derived. A section is rebuilt only if every source it
 * needs validated; otherwise the previous section is kept as-is. */
const SECTION_PLANS: readonly SectionPlan[] = [
  {
    family: 4,
    category: "tor",
    needs: ["tor-exits"],
    build: (src) => from(src, "tor-exits").v4,
  },
  {
    family: 6,
    category: "tor",
    needs: ["tor-exits"],
    build: (src) => from(src, "tor-exits").v6,
  },
  {
    family: 4,
    category: "vpn",
    needs: ["x4b-vpn-v4", "apple-private-relay"],
    build: (src) => subtractRanges(from(src, "x4b-vpn-v4").v4, from(src, "apple-private-relay").v4),
  },
  {
    // Datacenter minus the VPN list (upstream's datacenter list already includes it) so
    // categories are disjoint and no range is stored twice.
    family: 4,
    category: "datacenter",
    needs: ["x4b-datacenter-v4", "x4b-vpn-v4", "apple-private-relay"],
    build: (src) =>
      subtractRanges(
        subtractRanges(from(src, "x4b-datacenter-v4").v4, from(src, "x4b-vpn-v4").v4),
        from(src, "apple-private-relay").v4,
      ),
  },
  {
    family: 6,
    category: "vpn",
    needs: ["x4b-vpn-v6", "apple-private-relay"],
    build: (src) => subtractRanges(from(src, "x4b-vpn-v6").v6, from(src, "apple-private-relay").v6),
  },
];

/**
 * Download every source, validate each one, and assemble a new dataset. Never throws for
 * bad upstream data: a source that fails validation only stops the sections that depend
 * on it from being rebuilt, and those sections are carried over from `previous`.
 * `updatedSections === 0` means there is nothing new worth writing.
 */
export async function buildVpnDataset(opts: {
  fetchText: FetchText;
  previous: VpnDataset | null;
  now: number;
  sources?: Record<VpnSourceId, VpnSourceSpec>;
}): Promise<BuildResult> {
  const specs = opts.sources ?? VPN_SOURCES;
  const ids = Object.keys(specs) as VpnSourceId[];

  // Validate each body as soon as it arrives so the raw text (Apple's is ~12 MB) can be
  // garbage-collected; only merged ranges are kept.
  const good = new Map<VpnSourceId, { v4: KeyRange[]; v6: KeyRange[] }>();
  const sources: SourceReport[] = await Promise.all(
    ids.map(async (id): Promise<SourceReport> => {
      const spec = specs[id];
      let res: FetchedText;
      try {
        res = await opts.fetchText(spec.url, spec.maxBytes);
      } catch (err) {
        return { id, ok: false, reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const v = validateSource(spec, res);
      if (!v.ok) return { id, ok: false, reason: v.reason, chars: res.text.length };
      good.set(id, { v4: v.v4, v6: v.v6 });
      return { id, ok: true, chars: res.text.length, entries: v.entries };
    }),
  );

  const sections: VpnSection[] = [];
  const reports: SectionReport[] = [];
  let updatedSections = 0;
  for (const plan of SECTION_PLANS) {
    const prev = opts.previous?.sections.find((s) => s.family === plan.family && s.category === plan.category);
    const keepPrevious = (reason: string) => {
      if (prev) {
        sections.push(prev);
        reports.push({ family: plan.family, category: plan.category, status: "kept", reason, ranges: sectionRangeCount(prev) });
      } else {
        reports.push({ family: plan.family, category: plan.category, status: "absent", reason, ranges: 0 });
      }
    };

    const missing = plan.needs.filter((id) => !good.has(id));
    if (missing.length > 0) {
      keepPrevious(`source(s) unavailable: ${missing.join(", ")}`);
      continue;
    }
    const ranges = mergeRanges(plan.build(good));
    if (ranges.length === 0 && !prev) {
      // Legitimately empty (e.g. the Tor list has no IPv6 exits today): nothing to store.
      reports.push({ family: plan.family, category: plan.category, status: "empty", ranges: 0 });
      continue;
    }
    const problem = checkSectionChange(ranges, prev ? sectionToRanges(prev) : undefined);
    if (problem) {
      keepPrevious(problem);
      continue;
    }
    sections.push(toSection(plan.family, plan.category, ranges));
    reports.push({ family: plan.family, category: plan.category, status: "updated", ranges: ranges.length });
    updatedSections++;
  }

  return {
    dataset: { generatedAt: Math.floor(opts.now / 1000), sections },
    updatedSections,
    sections: reports,
    sources,
  };
}

// ── Helpers for the seeding script (pure, unit-tested) ───────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** JSON for `wrangler kv bulk put`: one entry, value base64-encoded with `base64: true`
 * so the KV bulk API stores the raw bytes. (Wrangler 4.75's `--local` mode decodes such
 * values into a UTF-8 string, which corrupts binary data; for local KV use
 * `wrangler kv key put --path <file.bin>` instead. A corrupted value is rejected by
 * decodeDataset, so the failure mode is "no list data", not wrong answers.) */
export function toWranglerBulkJson(encoded: Uint8Array, key: string = VPN_DATASET_KEY): string {
  return `${JSON.stringify([{ key, value: bytesToBase64(encoded), base64: true }], null, 2)}\n`;
}

export interface DatasetSummaryRow {
  section: string;
  ranges: number;
  /** IPv4: addresses covered. IPv6: /64 prefixes covered (as a decimal string). */
  covered: string;
}

export function summarizeDataset(ds: VpnDataset): DatasetSummaryRow[] {
  return ds.sections.map((s) => ({
    section: `${s.category}/ipv${s.family}`,
    ranges: sectionRangeCount(s),
    covered: countKeys(sectionToRanges(s)).toString(),
  }));
}

/** Fetch-based FetchText with a byte cap, usable from both the Worker and Node. */
export function createFetchText(fetchImpl: typeof fetch, timeoutMs = 60_000): FetchText {
  return async (url, maxBytes) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) {
      // Drain/cancel so the connection is released.
      await res.body?.cancel().catch(() => {});
      return { status: res.status, text: "" };
    }
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new Error(`content-length ${declared} exceeds ${maxBytes}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`body exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { status: res.status, text };
  };
}
