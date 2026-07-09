import { defineConfig, devices } from "@playwright/test";

const localSmokePort = process.env.UI_SMOKE_PORT ?? "3100";
const baseURL = process.env.UI_SMOKE_BASE_URL ?? `http://127.0.0.1:${localSmokePort}`;
const shouldStartLocalServer = !process.env.UI_SMOKE_BASE_URL;

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  fullyParallel: false,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }]
  ],
  outputDir: "test-results/playwright",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: shouldStartLocalServer
    ? {
        command: `npm run dev -- --hostname 127.0.0.1 --port ${localSmokePort}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        url: baseURL
      }
    : undefined,
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { height: 1100, width: 1440 }
      }
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 5"]
      }
    }
  ]
});
