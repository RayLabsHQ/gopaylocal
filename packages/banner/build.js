import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");

const config = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  outfile: "dist/banner.js",
  sourcemap: false,
  treeShaking: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
};

if (isWatch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("Watching...");
} else {
  await build(config);
  const { statSync } = await import("fs");
  const stat = statSync("dist/banner.js");
  console.log(`Built: dist/banner.js (${(stat.size / 1024).toFixed(1)}KB)`);
}
