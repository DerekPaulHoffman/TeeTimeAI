import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getFreshRenderedCorroborationEvidence,
  resolveBrowserInvestigationMode,
  resolveBrowserProbeRuntimeVersion,
  resolveBrowserProbeTargetSelection,
  runBrowserProbeCli,
} from "../../../scripts/automation/browser-probe-needed-adapters";
import { getAutomationRuntimeVersion } from "./runtime-version";

const releaseSha = "a".repeat(40);
const persistenceFence = {
  batchId: "batch-1",
  leaseToken: "lease-1",
  ownerThreadId: "thread-1",
  releaseSha,
  deployedAt: new Date("2026-07-21T11:50:00.000Z"),
  runtimeVersion: releaseSha,
  incidentId: "incident-1",
  courseId: "course-1",
  cycle: 1,
  stage: "RENDERED_BROWSER_DISCOVERY" as const,
};

describe("browser probe direct entry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a mutating direct invocation before the browser runner can write", async () => {
    const runner = vi.fn();

    await expect(
      runBrowserProbeCli(["--course-id", "course-1"], runner),
    ).rejects.toThrow("diagnostic-only");

    expect(runner).not.toHaveBeenCalled();
  });

  it("allows only diagnostic dry runs with terminal and search writes disabled", async () => {
    const runner = vi.fn().mockResolvedValue({
      targetCount: 1,
      persistedCount: 0,
    });

    await expect(
      runBrowserProbeCli(
        ["--dry-run", "--course-id", "course-1", "--limit", "1"],
        runner,
      ),
    ).resolves.toEqual({ targetCount: 1, persistedCount: 0 });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        deferTerminalCloseout: true,
        persistSearchProbe: false,
      }),
    );
  });

  it("uses the owned release SHA when local dispatch has no Vercel runtime identity", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");

    expect(getAutomationRuntimeVersion()).toBe("local");
    expect(
      resolveBrowserProbeRuntimeVersion(
        getAutomationRuntimeVersion(),
        persistenceFence,
      ),
    ).toBe(releaseSha);
  });

  it("rejects an explicit real runtime that conflicts with the owned release", () => {
    expect(() =>
      resolveBrowserProbeRuntimeVersion("b".repeat(40), persistenceFence),
    ).toThrow("does not match the owned batch release");
  });

  it("uses distinct rendered and independent investigation modes from the ordered stage", () => {
    expect(resolveBrowserInvestigationMode({ persistenceFence })).toBe(
      "RENDERED",
    );
    expect(
      resolveBrowserInvestigationMode({
        persistenceFence: {
          ...persistenceFence,
          stage: "INDEPENDENT_CONFIRMATION",
        },
      }),
    ).toBe("INDEPENDENT");
  });

  it("passes the exact owned persistence fence into target selection", () => {
    expect(
      resolveBrowserProbeTargetSelection({
        limit: 1,
        courseName: undefined,
        courseId: "course-1",
        persistenceFence,
      }),
    ).toEqual({
      limit: 1,
      courseName: undefined,
      courseId: "course-1",
      persistenceFence,
    });
  });

  it("accepts corroboration only from a fresh rendered observation in the same cycle and runtime", () => {
    const confirmedAt = new Date("2026-08-20T12:00:00.000Z");
    const evidence = {
      accessBarriers: [
        { url: "https://provider.example/public", status: 403 },
      ],
      browserInvestigation: {
        mode: "RENDERED",
        incidentCycle: 3,
        runtimeVersion: releaseSha,
        observedAt: "2026-08-20T12:01:00.000Z",
      },
    };
    const discovery = {
      createdAt: new Date("2026-08-20T12:01:01.000Z"),
      evidence,
    };
    const context = {
      incidentCycle: 3,
      runtimeVersion: releaseSha,
      confirmedAt,
    };

    expect(getFreshRenderedCorroborationEvidence(discovery, context)).toBe(
      evidence,
    );
    expect(
      getFreshRenderedCorroborationEvidence(
        {
          ...discovery,
          evidence: {
            ...evidence,
            browserInvestigation: {
              ...evidence.browserInvestigation,
              mode: "INDEPENDENT",
            },
          },
        },
        context,
      ),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(discovery, {
        ...context,
        incidentCycle: 4,
      }),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(discovery, {
        ...context,
        runtimeVersion: "b".repeat(40),
      }),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(
        {
          createdAt: new Date("2026-08-20T11:59:59.000Z"),
          evidence,
        },
        context,
      ),
    ).toBeNull();
    expect(
      getFreshRenderedCorroborationEvidence(
        {
          ...discovery,
          evidence: {
            ...evidence,
            browserInvestigation: {
              ...evidence.browserInvestigation,
              observedAt: "2026-08-20T11:59:59.000Z",
            },
          },
        },
        context,
      ),
    ).toBeNull();
  });
});
