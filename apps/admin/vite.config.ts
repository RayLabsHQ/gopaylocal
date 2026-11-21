import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  server: { port: 3001 },
  // Vite 8 resolves tsconfig `paths` (the `~/*` alias) natively; it replaces
  // the vite-tsconfig-paths plugin, which Vite 8 warns about.
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackStart({ spa: { enabled: true } }),
    tailwindcss(),
    viteReact(),
  ],
})
