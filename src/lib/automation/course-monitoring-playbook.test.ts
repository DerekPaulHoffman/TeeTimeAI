import { describe, expect, it } from "vitest";

import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  isAutomationPlaybookExhausted,
  type AutomationPlaybookEventInput,
  type AutomationPlaybookLedger,
} from "./course-monitoring-playbook";

const observedAt = new Date("2026-08-10T12:00:00.000Z");
type TestEventInput = Omit<
  AutomationPlaybookEventInput,
  "cycle" | "observedAt" | "failureFingerprint" | "runtimeVersion"
> & {
  failureFingerprint?: string;
  runtimeVersion?: string;
};

function append(
  ledger: AutomationPlaybookLedger | null,
  input: TestEventInput,
) {
  return appendAutomationPlaybookEvent(ledger, {
    failureFingerprint: "PLAYBOOK:NONE",
    runtimeVersion: "test-runtime",
    ...input,
    cycle: 1,
    observedAt,
  });
}

describe("course monitoring automation playbook", () => {
  it("treats missing or invalid legacy ledgers as unexhausted", () => {
    expect(isAutomationPlaybookExhausted(null, 1)).toBe(false);
    expect(
      isAutomationPlaybookExhausted({ version: 1, events: "invalid" }, 1),
    ).toBe(false);
    expect(assessAutomationPlaybook(null, 1)).toMatchObject({
      valid: false,
      conclusion: "INCOMPLETE",
      nextStage: "OFFICIAL_IDENTITY",
    });
  });

  it("enforces the full ordered ladder and records skipped stages explicitly", () => {
    expect(() =>
      append(null, {
        stage: "TYPED_ADAPTER",
        transition: "STARTED",
        readPath: "TYPED_PROVIDER_ADAPTER",
        evidenceKind: "TOOLING",
      }),
    ).toThrow(/start with official identity/i);

    const started = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "STARTED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    expect(() =>
      append(started, {
        stage: "TYPED_ADAPTER",
        transition: "STARTED",
        readPath: "TYPED_PROVIDER_ADAPTER",
        evidenceKind: "TOOLING",
      }),
    ).toThrow(/prior stage must reach a terminal transition/i);
  });

  it("derives applicability, status, attempt count, and timestamps from append-only events", () => {
    let ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "STARTED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_IDENTITY",
      transition: "FAILED_RETRYABLE",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureClass: "NETWORK",
      failureFingerprint: "IDENTITY:NETWORK",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_IDENTITY",
      transition: "STARTED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    expect(assessAutomationPlaybook(ledger, 1).stages[0]).toEqual({
      stage: "OFFICIAL_IDENTITY",
      applicability: "APPLICABLE",
      status: "COMPLETED",
      attemptCount: 2,
      firstObservedAt: observedAt.toISOString(),
      lastObservedAt: observedAt.toISOString(),
      completedAt: observedAt.toISOString(),
    });
  });

  it("redacts notes and rejects unsafe or unbounded proof identifiers", () => {
    const ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "FAILED_RETRYABLE",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureClass: "NETWORK",
      failureFingerprint: "IDENTITY:NETWORK",
      note: "Contact golfer@example.com; retry https://course.example/book?token=secret",
    });
    expect(ledger.events[0]?.note).not.toContain("golfer@example.com");
    expect(ledger.events[0]?.note).not.toContain("/book");
    expect(ledger.events[0]?.note).not.toContain("secret");

    expect(() =>
      append(null, {
        stage: "OFFICIAL_IDENTITY",
        transition: "STARTED",
        readPath: "OFFICIAL_IDENTITY",
        evidenceKind: "OFFICIAL_SOURCE",
        failureFingerprint: "https://course.example/private",
        runtimeVersion: "runtime/unsafe",
      }),
    ).toThrow();
    expect(() =>
      append(null, {
        stage: "OFFICIAL_IDENTITY",
        transition: "STARTED",
        readPath: "OFFICIAL_IDENTITY",
        evidenceKind: "OFFICIAL_SOURCE",
        failureFingerprint: "BLACKLEDGE_GOLF_COURSE",
        runtimeVersion: "test-runtime",
      }),
    ).toThrow();
    expect(() =>
      append(null, {
        stage: "OFFICIAL_IDENTITY",
        transition: "STARTED",
        readPath: "OFFICIAL_IDENTITY",
        evidenceKind: "OFFICIAL_SOURCE",
        failureFingerprint: "A".repeat(161),
        runtimeVersion: "v".repeat(101),
      }),
    ).toThrow();
  });

  it("short-circuits on a current factual final without requesting human escalation", () => {
    const ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "FACTUAL_FINAL",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      factualDisposition: "MANUAL_DIRECT",
      failureFingerprint: "IDENTITY:MANUAL_DIRECT",
    });
    expect(assessAutomationPlaybook(ledger, 1)).toMatchObject({
      conclusion: "FACTUAL_FINAL",
      factualDisposition: "MANUAL_DIRECT",
      nextStage: null,
    });
    expect(isAutomationPlaybookExhausted(ledger, 1)).toBe(false);
  });

  it("allows authoritative rendered-page facts to short-circuit after earlier safe stages", () => {
    let ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "TYPED_ADAPTER",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "NOT_FOUND",
      failureFingerprint: "PROVIDER:NOT_FOUND",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "HTTP_ADAPTER_RETRY",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      skipReason: "NO_RUNNABLE_ADAPTER",
    });
    ledger = append(ledger, {
      stage: "RENDERED_BROWSER_DISCOVERY",
      transition: "FACTUAL_FINAL",
      readPath: "RENDERED_BROWSER",
      evidenceKind: "RENDERED_PAGE",
      factualDisposition: "MANUAL_DIRECT",
      failureFingerprint: "BROWSER:MANUAL_DIRECT",
    });

    expect(assessAutomationPlaybook(ledger, 1)).toMatchObject({
      conclusion: "FACTUAL_FINAL",
      factualDisposition: "MANUAL_DIRECT",
      nextStage: null,
    });
    expect(isAutomationPlaybookExhausted(ledger, 1)).toBe(false);
  });

  it("requires terminal local-reader proof and a final independent confirmation", () => {
    let ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "TYPED_ADAPTER",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PROVIDER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "HTTP_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PROVIDER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "RENDERED_BROWSER_DISCOVERY",
      transition: "COMPLETED",
      readPath: "RENDERED_BROWSER",
      evidenceKind: "RENDERED_PAGE",
    });
    ledger = append(ledger, {
      stage: "BROWSER_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PROVIDER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "LOCAL_READER",
      transition: "TECHNICAL_LIMITATION",
      readPath: "LOCAL_READER",
      evidenceKind: "LOCAL_READER_RESULT",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint: "LOCAL_READER:CHALLENGE",
    });
    expect(assessAutomationPlaybook(ledger, 1)).toMatchObject({
      conclusion: "INCOMPLETE",
      technicalObservationCount: 1,
      nextStage: "INDEPENDENT_CONFIRMATION",
    });

    ledger = append(ledger, {
      stage: "INDEPENDENT_CONFIRMATION",
      transition: "TECHNICAL_LIMITATION",
      readPath: "INDEPENDENT_CONFIRMATION",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint: "CONFIRMATION:CHALLENGE",
    });
    expect(assessAutomationPlaybook(ledger, 1)).toMatchObject({
      conclusion: "TECHNICAL_FINAL",
      technicalReason: "CAPTCHA_OR_QUEUE",
      technicalObservationCount: 2,
    });
    expect(isAutomationPlaybookExhausted(ledger, 1)).toBe(true);
  });

  it("classifies an incompatible local reader as unresolved, never as a technical final", () => {
    let ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "TYPED_ADAPTER",
      transition: "TECHNICAL_LIMITATION",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint: "PROVIDER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "TECHNICAL_LIMITATION",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint: "HTTP:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "HTTP_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PROVIDER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "RENDERED_BROWSER_DISCOVERY",
      transition: "TECHNICAL_LIMITATION",
      readPath: "RENDERED_BROWSER",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint: "BROWSER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "BROWSER_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PROVIDER:CHALLENGE",
    });
    ledger = append(ledger, {
      stage: "LOCAL_READER",
      transition: "NOT_APPLICABLE",
      readPath: "LOCAL_READER",
      evidenceKind: "TOOLING",
      skipReason: "NO_LOCAL_READER_CAPABILITY",
      failureFingerprint: "LOCAL_READER:NOT_APPLICABLE",
    });
    ledger = append(ledger, {
      stage: "INDEPENDENT_CONFIRMATION",
      transition: "TECHNICAL_LIMITATION",
      readPath: "INDEPENDENT_CONFIRMATION",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint: "CONFIRMATION:CHALLENGE",
    });
    expect(assessAutomationPlaybook(ledger, 1)).toMatchObject({
      conclusion: "UNRESOLVED_EXHAUSTED",
      nextStage: null,
    });
    expect(isAutomationPlaybookExhausted(ledger, 1)).toBe(true);
  });

  it("keeps proof scoped to the current incident cycle", () => {
    const priorCycle = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "FACTUAL_FINAL",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      factualDisposition: "IDENTITY_FINAL",
      failureFingerprint: "IDENTITY:FINAL",
    });
    const nextCycle = appendAutomationPlaybookEvent(priorCycle, {
      cycle: 2,
      stage: "OFFICIAL_IDENTITY",
      transition: "STARTED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:NONE",
      runtimeVersion: "test-runtime",
      observedAt: new Date(observedAt.getTime() + 1_000),
    });
    expect(assessAutomationPlaybook(nextCycle, 1).conclusion).toBe(
      "FACTUAL_FINAL",
    );
    expect(assessAutomationPlaybook(nextCycle, 2).conclusion).toBe(
      "INCOMPLETE",
    );
    expect(isAutomationPlaybookExhausted(nextCycle, 2)).toBe(false);
  });

  it("accepts an authoritative factual final discovered during independent confirmation", () => {
    let ledger = append(null, {
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "TYPED_ADAPTER",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "NOT_FOUND",
    });
    ledger = append(ledger, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
    });
    ledger = append(ledger, {
      stage: "HTTP_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "NOT_FOUND",
    });
    ledger = append(ledger, {
      stage: "RENDERED_BROWSER_DISCOVERY",
      transition: "COMPLETED",
      readPath: "RENDERED_BROWSER",
      evidenceKind: "RENDERED_PAGE",
    });
    ledger = append(ledger, {
      stage: "BROWSER_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "NOT_FOUND",
    });
    ledger = append(ledger, {
      stage: "LOCAL_READER",
      transition: "COMPLETED",
      readPath: "LOCAL_READER",
      evidenceKind: "LOCAL_READER_RESULT",
    });
    ledger = append(ledger, {
      stage: "INDEPENDENT_CONFIRMATION",
      transition: "FACTUAL_FINAL",
      readPath: "INDEPENDENT_CONFIRMATION",
      evidenceKind: "RENDERED_PAGE",
      factualDisposition: "MANUAL_DIRECT",
      failureFingerprint: "CONFIRMATION:MANUAL_DIRECT",
    });

    expect(assessAutomationPlaybook(ledger, 1)).toMatchObject({
      conclusion: "FACTUAL_FINAL",
      nextStage: null,
    });
    expect(isAutomationPlaybookExhausted(ledger, 1)).toBe(false);
  });
});
