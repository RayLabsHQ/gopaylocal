import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2020',
  // The provider, hooks and components only work on the client, so the package
  // is a client module for React Server Components (Next.js App Router).
  // Bundling drops directives from source files, so it is added to the output
  // here. Side effect: the plain helpers it re-exports are client references in
  // a server component; import those from @gopaylocal/js there instead.
  banner: { js: "'use client';" },
});
