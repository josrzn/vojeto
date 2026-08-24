import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts, whose `root` points at the web app.
export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
