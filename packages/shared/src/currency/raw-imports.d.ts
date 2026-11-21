// Vite's `?raw` suffix imports a file's text (vitest runs on Vite). Used only by
// currency.purity.test.ts, which reads the SDK-bundled sources without Node's fs
// (the shared package has no Node types, on purpose: its code runs in Workers and
// browsers).
declare module "*?raw" {
  const source: string;
  export default source;
}
