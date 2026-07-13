import { defineConfig, devices } from "@playwright/test";

import { VERCEL_PREVIEW_STORAGE_STATE } from "./src/lib/deployments/vercel-preview-auth";

const localSmokePort = process.env.UI_SMOKE_PORT ?? "3100";
const baseURL = process.env.UI_SMOKE_BASE_URL ?? `http://127.0.0.1:${localSmokePort}`;
const shouldStartLocalServer = !process.env.UI_SMOKE_BASE_URL;
const protectionBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  globalSetup: protectionBypassSecret
    ? "./scripts/ci/preview-smoke-global-setup.ts"
    : undefined,
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
    storageState: protectionBypassSecret ? VERCEL_PREVIEW_STORAGE_STATE : undefined,
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: shouldStartLocalServer
    ? {
        command: `npm run start -- --hostname 127.0.0.1 --port ${localSmokePort}`,
        reuseExistingServer: false,
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
