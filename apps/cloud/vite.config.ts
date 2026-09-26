import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // tslib's CommonJS wrapper loses its exports when the SSR bundle converts it to ESM,
    // which breaks Radix's scroll lock during server rendering.
    alias: { tslib: "tslib/tslib.es6.mjs" },
  },
  plugins: [nitro({ preset: "bun" }), tanstackStart(), viteReact(), tailwindcss()],
})
