// Keeps every app's wrangler.example.toml (the self-hosting template) in step with
// the real wrangler.toml (the hosted deployment). When you add or change a binding,
// cron, rate limit or variable in a wrangler.toml, make the same change in the
// example next to it, with a comment saying what it is for and whether it is
// required. Also checks that no hosted-deployment id leaks into an example.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type TomlValue = string | number | boolean | string[];
type Table = Record<string, TomlValue>;
type Parsed = { root: Table; tables: Record<string, Table>; arrays: Record<string, Table[]> };

/** Index of the first `#` outside a double-quoted string, or -1. */
function commentStart(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && quoted) i++;
    else if (ch === '"') quoted = !quoted;
    else if (ch === "#" && !quoted) return i;
  }
  return -1;
}

function parseValue(raw: string): TomlValue {
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+$/.test(raw)) return Number(raw);
  // Basic strings and single-line arrays of basic strings are valid JSON here.
  return JSON.parse(raw.replace(/,\s*]$/, "]")) as string | string[];
}

/**
 * Just enough TOML for these files: [table], [[array.of.tables]], dotted sub-tables
 * of the latest array entry ([ratelimits.simple]), and `key = value` with strings,
 * integers, booleans or one-line string arrays. Throws on anything else so a new
 * construct in a wrangler file fails loudly instead of being skipped.
 */
function parseToml(text: string): Parsed {
  const parsed: Parsed = { root: {}, tables: {}, arrays: {} };
  let current: Table = parsed.root;
  let lastArray: { name: string; entry: Table } | null = null;
  for (const [n, rawLine] of text.split("\n").entries()) {
    const cut = commentStart(rawLine);
    const line = (cut === -1 ? rawLine : rawLine.slice(0, cut)).trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\[\[([A-Za-z0-9_.]+)\]\]$/))) {
      const entry: Table = {};
      (parsed.arrays[m[1]!] ??= []).push(entry);
      lastArray = { name: m[1]!, entry };
      current = entry;
    } else if ((m = line.match(/^\[([A-Za-z0-9_.]+)\]$/))) {
      const name = m[1]!;
      if (lastArray && name.startsWith(`${lastArray.name}.`)) {
        // Flatten [ratelimits.simple] into the current [[ratelimits]] entry as "simple.limit".
        const prefix = name.slice(lastArray.name.length + 1);
        const entry = lastArray.entry;
        current = new Proxy({} as Table, {
          set: (_t, key, value) => ((entry[`${prefix}.${String(key)}`] = value), true),
        });
      } else {
        lastArray = null;
        current = parsed.tables[name] ??= {};
      }
    } else if ((m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/))) {
      current[m[1]!] = parseValue(m[2]!.trim());
    } else {
      throw new Error(`unsupported TOML on line ${n + 1}: ${rawLine}`);
    }
  }
  return parsed;
}

const appsDir = new URL("../../", import.meta.url);
const read = (app: string, file: string) => readFileSync(new URL(`${app}/${file}`, appsDir), "utf8");
const load = (app: string) => {
  const realText = read(app, "wrangler.toml");
  const exampleText = read(app, "wrangler.example.toml");
  return { realText, exampleText, real: parseToml(realText), example: parseToml(exampleText) };
};

/** Values that identify the hosted deployment: resource ids, Dodo product ids, the DB host. */
function hostedIdentifiers(real: Parsed): string[] {
  const ids: string[] = [];
  for (const entries of Object.values(real.arrays)) {
    for (const entry of entries) {
      if (typeof entry.id === "string") ids.push(entry.id);
    }
  }
  for (const [key, value] of Object.entries(real.tables.vars ?? {})) {
    if (key.startsWith("DODO_PRICE_ID") && typeof value === "string") ids.push(value);
  }
  const host = real.tables.placement?.host;
  if (typeof host === "string") ids.push(host.split(":")[0]!);
  return ids.filter(Boolean);
}

const byName = (entries: Table[] | undefined, key: string) =>
  Object.fromEntries((entries ?? []).map((e) => [String(e[key]), e]));

describe.each(["api", "dashboard", "admin", "web", "docs"])("%s/wrangler.example.toml", (app) => {
  const { real, example, exampleText } = load(app);

  it("matches the real config's entry point, compatibility settings and assets", () => {
    for (const key of ["main", "compatibility_date", "compatibility_flags"]) {
      expect(example.root[key], key).toEqual(real.root[key]);
    }
    expect(typeof example.root.name).toBe("string");
    expect(example.tables.assets).toEqual(real.tables.assets);
    expect(example.arrays.rules).toEqual(real.arrays.rules);
    expect(example.tables.triggers).toEqual(real.tables.triggers);
  });

  it("contains none of the hosted deployment's identifiers", () => {
    for (const id of hostedIdentifiers(real)) {
      expect(exampleText, id).not.toContain(id);
    }
  });
});

describe("api/wrangler.example.toml bindings", () => {
  const { real, example, exampleText } = load("api");

  it("declares the same KV namespaces and Hyperdrive bindings", () => {
    expect(Object.keys(byName(example.arrays.kv_namespaces, "binding")).sort()).toEqual(
      Object.keys(byName(real.arrays.kv_namespaces, "binding")).sort(),
    );
    expect(Object.keys(byName(example.arrays.hyperdrive, "binding")).sort()).toEqual(
      Object.keys(byName(real.arrays.hyperdrive, "binding")).sort(),
    );
  });

  it("declares the same rate limiters with the same namespace ids, limits and periods", () => {
    expect(byName(example.arrays.ratelimits, "name")).toEqual(byName(real.arrays.ratelimits, "name"));
  });

  it("mentions every [vars] key of the real config (set or commented out)", () => {
    for (const key of Object.keys(real.tables.vars ?? {})) {
      expect(exampleText, key).toMatch(new RegExp(`^#?\\s*${key}\\s*=`, "m"));
    }
  });

  it("documents every binding the Worker reads (src/bindings.ts)", () => {
    const bindingsSource = readFileSync(new URL("./bindings.ts", import.meta.url), "utf8");
    const block = bindingsSource.slice(
      bindingsSource.indexOf("export type Bindings"),
      bindingsSource.indexOf("export type AppEnv"),
    );
    const names = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(exampleText, name).toContain(name);
    }
  });

  it("is set up for self-hosting", () => {
    expect(example.tables.vars?.SELF_HOSTED).toBe("true");
    for (const key of ["API_BASE_URL", "APP_BASE_URL", "ADMIN_BASE_URL"]) {
      expect(String(example.tables.vars?.[key]), key).not.toMatch(/gopaylocal\.com/);
    }
  });
});
