import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/public-tee-time-reader/parser.test.ts"]
  }
});
