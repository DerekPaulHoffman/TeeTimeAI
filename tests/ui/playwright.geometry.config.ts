import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "interactive-geometry.spec.ts",
  outputDir: "../../test-results/geometry",
  timeout: 10_000,
  expect: { timeout: 2_000 },
  workers: 1,
  reporter: "list",
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1100 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined
  }
});
