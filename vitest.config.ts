import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Only UI tests and these browser-state/DOM fixtures need a jsdom per file.
// Real Playwright tests and fixtures that create their own JSDOM run in Node.
const domTests = [
  "src/**/*.test.tsx",
  "src/components/site-observability.test.ts",
  "src/lib/auth/deferred-clerk.test.ts",
  "src/lib/course-discovery/membersports-public-tee-sheet.test.ts",
  "src/lib/course-discovery/mindbody-appointment-native-capture.test.ts",
  "src/lib/course-discovery/public-catalog-tile.test.ts",
  "src/lib/course-discovery/public-date-choice.test.ts",
  "src/lib/course-discovery/public-document-metadata.test.ts",
  "src/lib/course-discovery/public-product-control.test.ts",
  "src/lib/engagement/{client,discovery-source,traffic-class}.test.ts",
  "src/lib/local-reader/{chronogolf-player-selection,cps-player-selection,local-reader-settlement,local-reader,official-source-flow,official-source-reader,official-source-worker}.test.ts",
  "src/lib/searches/{search-draft,search-prefill}.test.ts"
];

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...domTests]
        }
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: domTests
        }
      }
    ]
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
