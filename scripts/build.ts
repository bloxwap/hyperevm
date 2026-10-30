/**
 * Bundle the public entry to dist/ so CI can prove it builds.
 * Package exports still point at src/mod.ts. This package is not published.
 * @module
 */

export {};

const result = await Bun.build({
  entrypoints: ["./src/mod.ts"],
  outdir: "./dist",
  format: "esm",
  target: "node",
  sourcemap: "external",
  external: ["viem"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${result.outputs.length} file(s) to dist/.`);
