import { describe, expect, it } from "vitest";
import charmSource from "./charm.ts?raw";
import exponentsSource from "./exponents.ts?raw";
import localPriceSource from "./local-price.ts?raw";
import pairSource from "./pair.ts?raw";

// The SDKs (MIT, published to npm, no runtime dependencies) bundle charm.ts,
// exponents.ts and pair.ts through a relative import. Anything those files
// import ends up in every SDK bundle, so they may import only each other: never
// a package (zod, @gopaylocal/shared's other modules), never Node built-ins.

function importsOf(src: string): string[] {
  const specifiers: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) specifiers.push(m[1]!);
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specifiers.push(m[1]!);
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(m[1]!);
  return specifiers;
}

describe("SDK-bundled currency modules stay pure", () => {
  it("exponents.ts imports nothing", () => {
    expect(importsOf(exponentsSource)).toEqual([]);
  });

  it("charm.ts imports only ./exponents", () => {
    expect(importsOf(charmSource)).toEqual(["./exponents"]);
  });

  it("pair.ts imports only ./charm", () => {
    expect(importsOf(pairSource)).toEqual(["./charm"]);
  });

  it("the import scanner sees the imports local-price.ts has", () => {
    // Guards the scanner itself: a file with known imports must not come back empty.
    expect(importsOf(localPriceSource)).toEqual(["../constants", "./charm", "./country-currency", "./exponents", "./fx", "./pair"]);
  });
});
