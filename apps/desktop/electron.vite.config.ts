import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"

// Workspace packages ship TypeScript source and Bun links node_modules through a store,
// so the main and preload bundles inline every dependency instead of relying on
// electron-builder to copy node_modules into the app.
export default defineConfig({
  main: { build: { externalizeDeps: false } },
  preload: { build: { externalizeDeps: false } },
  renderer: { plugins: [react(), tailwindcss()] },
})
