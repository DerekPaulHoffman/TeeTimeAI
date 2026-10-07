import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPageHeader } from "@/components/search-page-header";

vi.mock("@/lib/env", () => ({
  getClerkPublishableKey: () => undefined,
  hasClerkConfig: () => false
}));
vi.mock("@/components/tee-time-intake", () => ({
  TeeTimeIntake: ({ initialValues, showPageHeader }: { initialValues: { mode: "OUTDOOR" | "SIMULATOR" }; showPageHeader: boolean }) => (
    <>
      {showPageHeader ? <SearchPageHeader mode={initialValues.mode} /> : null}
      <div data-initial-mode={initialValues.mode} />
    </>
  )
}));

import SearchPage from "./page";

describe("search entry mode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("explains one-hour simulator sessions for a simulator entry link", async () => {
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");
    const html = renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ mode: "simulator" }) }));
    expect(html).toContain("Find indoor golf simulators and set a free alert.");
    expect(html).toContain("one-hour sessions where supported");
    expect(html).toContain('data-initial-mode="SIMULATOR"');
  });

  it("retains the outdoor entry when simulators are disabled or not requested", async () => {
    for (const enabled of ["true", "false"]) {
      vi.stubEnv("SIMULATOR_MODE_ENABLED", enabled);
      const html = renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ mode: enabled === "false" ? "SIMULATOR" : undefined }) }));
      expect(html).toContain("Find public golf tee times and set a free alert.");
      expect(html).toContain('data-initial-mode="OUTDOOR"');
    }
  });
});
