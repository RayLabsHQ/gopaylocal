// Generates packages/shared/src/currency/country-currency.ts from Unicode CLDR.
//
// Dev-only, never shipped. Run from the repo root when CLDR publishes a release
// that changes a country's currency (for example a country joining the euro):
//
//   node packages/shared/scripts/generate-country-currency.ts [cldr-json tag]
//
// The default tag is the CLDR release the committed table was built from. The
// script needs network access (raw.githubusercontent.com) and nothing else: no
// dependencies, plain fetch, plain Node (type stripping).
//
// Rule: for each region, the currencies that are legal tender today, meaning
// they have `_from` <= today, no `_to` (or a `_to` in the future), and are not
// marked `_tender: "false"`. A region with more than one such currency must
// have an entry in OVERRIDES, or the script fails, so every multi-currency
// country is a reviewed, documented choice.

import { writeFileSync } from "node:fs";

const DEFAULT_TAG = "49.0.0";

/**
 * Countries with more than one current legal tender in CLDR: the one we show
 * local prices in. Reviewed by hand; country-currency.test.ts pins each entry.
 */
const OVERRIDES: Record<string, { currency: string; why: string }> = {
  PA: { currency: "USD", why: "PAB and USD are both tender at par; US dollar notes are what circulate" },
  BT: { currency: "BTN", why: "BTN and INR are both tender at par; BTN is the national currency" },
  LS: { currency: "LSL", why: "LSL and ZAR are both tender at par; LSL is the national currency" },
  NA: { currency: "NAD", why: "NAD and ZAR are both tender at par; NAD is the national currency" },
  ZW: { currency: "USD", why: "ZWG and USD are both tender; USD is the more widely quoted, with a stable rate" },
  PS: { currency: "ILS", why: "ILS and JOD are both tender; ILS is the more widely quoted" },
  HT: { currency: "HTG", why: "HTG and USD are both tender; HTG is the national currency" },
};

/** CLDR region keys that are not countries or territories. */
const NOT_A_COUNTRY = new Set(["EU", "EZ", "UN", "ZZ", "QO"]);

interface CldrCurrencyEntry {
  _from?: string;
  _to?: string;
  _tender?: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? DEFAULT_TAG;
  const base = `https://raw.githubusercontent.com/unicode-org/cldr-json/${tag}`;
  const dataUrl = `${base}/cldr-json/cldr-core/supplemental/currencyData.json`;
  const data = JSON.parse(await fetchText(dataUrl)) as {
    supplemental: {
      version: { _cldrVersion: string };
      currencyData: { region: Record<string, Array<Record<string, CldrCurrencyEntry>>> };
    };
  };
  const license = (await fetchText(`${base}/LICENSE`)).trim();
  const cldrVersion = data.supplemental.version._cldrVersion;
  const today = new Date().toISOString().slice(0, 10);

  const table: Record<string, string> = {};
  const multi: string[] = [];
  for (const [region, entries] of Object.entries(data.supplemental.currencyData.region)) {
    if (!/^[A-Z]{2}$/.test(region) || NOT_A_COUNTRY.has(region)) continue;
    if (region.startsWith("X") && region !== "XK") continue;
    const current: string[] = [];
    for (const entry of entries) {
      for (const [code, info] of Object.entries(entry)) {
        if (info._tender === "false") continue;
        if (!info._from || info._from > today) continue;
        if (info._to && info._to <= today) continue;
        current.push(code);
      }
    }
    const override = OVERRIDES[region];
    if (override) {
      if (!current.includes(override.currency)) {
        throw new Error(`override ${region} -> ${override.currency} is not a current tender (${current.join(", ") || "none"})`);
      }
      table[region] = override.currency;
      continue;
    }
    if (current.length === 0) continue;
    if (current.length > 1) {
      multi.push(`${region}: ${current.join(", ")}`);
      continue;
    }
    table[region] = current[0]!;
  }
  if (multi.length > 0) {
    throw new Error(`regions with more than one current tender need an OVERRIDES entry:\n  ${multi.join("\n  ")}`);
  }
  for (const region of Object.keys(OVERRIDES)) {
    if (!table[region]) throw new Error(`override ${region} matched no CLDR region`);
  }

  const regions = Object.keys(table).sort();
  const rows: string[] = [];
  for (let i = 0; i < regions.length; i += 8) {
    rows.push(
      "  " +
        regions
          .slice(i, i + 8)
          .map((r) => `${r}: "${table[r]}",`)
          .join(" "),
    );
  }
  const overrideLines = Object.entries(OVERRIDES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([r, o]) => `//   ${r} -> ${o.currency}: ${o.why}.`);
  const licenseLines = license.split("\n").map((l) => (l ? `// ${l}` : "//"));

  const out = `// GENERATED FILE, do not edit by hand.
// Source: Unicode CLDR ${cldrVersion} supplemental currencyData
// (${dataUrl}),
// generated ${today} by packages/shared/scripts/generate-country-currency.ts.
//
// Country or territory (ISO 3166-1 alpha-2, as Cloudflare reports it) -> the
// currency (ISO 4217) local prices are shown in: the region's current legal
// tender. Regions with more than one current tender use a reviewed choice:
${overrideLines.join("\n")}
//
// Countries that use another country's currency map to it (EC, SV, TL, PR -> USD;
// KI, TV, NR -> AUD; AD, MC, SM, VA, ME, XK -> EUR). Codes Cloudflare can send
// that are not here (XX unknown, T1 Tor) get no local price.
//
// The CLDR data is used under the Unicode License v3, whose notice follows. It
// is also reproduced in the repository's NOTICE file.
//
${licenseLines.join("\n")}

export const COUNTRY_CURRENCY_CLDR_VERSION = "${cldrVersion}";

export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
${rows.join("\n")}
};
`;
  const target = new URL("../src/currency/country-currency.ts", import.meta.url);
  writeFileSync(target, out);
  console.log(`wrote ${regions.length} regions (CLDR ${cldrVersion}) to ${target.pathname}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
