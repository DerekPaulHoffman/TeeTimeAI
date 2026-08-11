import { describe, expect, it } from "vitest";

import {
  approvedCourseSupportResponderCheckout,
  generatedPrismaSetupRequiredResult,
  inspectGeneratedPrismaClient,
  launchFailureResult,
  requiredCourseSupportIncidentScalarFields,
  responderInvocation,
  selectApprovedCourseSupportResponderCheckout
} from "../../../scripts/automation/course-support-preflight.mjs";

describe("course support preflight checkout selection", () => {
  const currentMain = "a".repeat(40);
  const wrongCheckout = "C:\\dev\\TeeTimeAI-clean-wrong-worktree";

  it("rejects a clean exact-main worktree when the approved dispatch checkout is unavailable", () => {
    expect(
      selectApprovedCourseSupportResponderCheckout({
        approvedCheckout: approvedCourseSupportResponderCheckout,
        preparedCheckouts: [wrongCheckout],
        currentMain,
        readHead: () => currentMain,
        platform: "win32"
      })
    ).toEqual({ outcome: "unavailable" });
  });

  it("selects only the approved dispatch checkout when another clean exact-main worktree is present", () => {
    expect(
      selectApprovedCourseSupportResponderCheckout({
        approvedCheckout: approvedCourseSupportResponderCheckout,
        preparedCheckouts: [wrongCheckout, approvedCourseSupportResponderCheckout],
        currentMain,
        readHead: () => currentMain,
        platform: "win32"
      })
    ).toEqual({
      outcome: "selected",
      checkout: approvedCourseSupportResponderCheckout
    });
  });

  it("rejects an environment override to a different prepared checkout", () => {
    expect(
      selectApprovedCourseSupportResponderCheckout({
        approvedCheckout: approvedCourseSupportResponderCheckout,
        requestedCheckout: wrongCheckout,
        preparedCheckouts: [approvedCourseSupportResponderCheckout],
        currentMain,
        readHead: () => currentMain,
        platform: "win32"
      })
    ).toEqual({ outcome: "rejected_requested_checkout" });
  });
});

describe("course support preflight process launch", () => {
  it("routes the static responder command through cmd.exe on Windows", () => {
    expect(responderInvocation("win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npx vercel env run -e production -- npm run automation:course-support -- inspect"
      ]
    });
  });

  it("invokes npx directly on non-Windows platforms", () => {
    expect(responderInvocation("linux")).toEqual({
      command: "npx",
      args: [
        "vercel",
        "env",
        "run",
        "-e",
        "production",
        "--",
        "npm",
        "run",
        "automation:course-support",
        "--",
        "inspect"
      ]
    });
  });

  it("reports spawn errors without exposing their message", () => {
    const result = launchFailureResult({
      error: Object.assign(new Error("sensitive local path"), { code: "EINVAL" }),
      status: null
    });

    expect(result).toMatchObject({
      outcome: "setup_required",
      failureClass: "PROCESS_LAUNCH_FAILED",
      errorCode: "EINVAL"
    });
    expect(JSON.stringify(result)).not.toContain("sensitive local path");
  });

  it("reports a missing exit status even when no spawn error is present", () => {
    expect(launchFailureResult({ error: undefined, status: null })).toMatchObject({
      outcome: "setup_required",
      failureClass: "MISSING_EXIT_STATUS"
    });
  });

  it("leaves normal child exits unchanged", () => {
    expect(launchFailureResult({ error: undefined, status: 0 })).toBeNull();
    expect(launchFailureResult({ error: undefined, status: 2 })).toBeNull();
  });
});

describe("course support preflight generated Prisma parity", () => {
  it("accepts a generated client with every required incident scalar field", () => {
    const result = inspectGeneratedPrismaClient("C:\\prepared-responder", () => ({
      Prisma: {
        CourseSupportIncidentScalarFieldEnum: Object.fromEntries(
          requiredCourseSupportIncidentScalarFields.map((field) => [field, field])
        )
      }
    }));

    expect(result).toEqual({
      status: "current",
      requiredScalarFieldCount: requiredCourseSupportIncidentScalarFields.length,
      missingScalarFieldCount: 0
    });
    expect(generatedPrismaSetupRequiredResult(result)).toBeNull();
  });

  it("fails closed when attemptLedger is missing from the generated client", () => {
    expect(requiredCourseSupportIncidentScalarFields).toContain("attemptLedger");
    const result = inspectGeneratedPrismaClient("C:\\prepared-responder", () => ({
      Prisma: {
        CourseSupportIncidentScalarFieldEnum: {
          cycle: "cycle",
          status: "status"
        }
      }
    }));

    expect(generatedPrismaSetupRequiredResult(result)).toEqual({
      outcome: "setup_required",
      reason:
        "The responder checkout's generated Prisma client is stale for required course-support fields.",
      failureClass: "STALE_GENERATED_PRISMA_CLIENT",
      requiredScalarFieldCount: requiredCourseSupportIncidentScalarFields.length,
      missingScalarFieldCount: 1,
      nextAction:
        "Run npm run prisma:generate in the dedicated responder checkout, confirm it remains clean, then rerun the preflight."
    });
  });

  it("reports an uninspectable client without exposing loader details or paths", () => {
    const result = inspectGeneratedPrismaClient(
      "C:\\private\\responder-checkout",
      () => {
        throw new Error("sensitive loader detail");
      }
    );
    const setupRequired = generatedPrismaSetupRequiredResult(result);

    expect(setupRequired).toMatchObject({
      outcome: "setup_required",
      failureClass: "GENERATED_PRISMA_CLIENT_UNAVAILABLE",
      requiredScalarFieldCount: requiredCourseSupportIncidentScalarFields.length
    });
    expect(JSON.stringify(setupRequired)).not.toContain("sensitive loader detail");
    expect(JSON.stringify(setupRequired)).not.toContain("private");
  });
});
