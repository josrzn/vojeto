import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  publicDir: "../public",
  // Relative so the built site works from a subpath, e.g. GitHub Pages.
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
});
