import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // No data: URLs: the daemon's CSP is default-src 'self', so every asset is a file (DS-10).
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
