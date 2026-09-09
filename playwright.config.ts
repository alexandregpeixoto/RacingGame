import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1600, height: 1000 },
  },
  webServer: {
    command:
      process.env.TRACK_CREATOR_PRODUCTION === "1"
        ? "npm run preview -- --host 127.0.0.1 --port 4173 --strictPort"
        : "npm run dev -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: process.env.TRACK_CREATOR_PRODUCTION !== "1",
  },
});
