import { Prisma } from "@prisma/client";
import { z } from "zod";

import { sanitizeResponderText } from "./course-support-responder-policy";

export const AUTOMATION_PLAYBOOK_VERSION = 1 as const;
export const AUTOMATION_PLAYBOOK_STAGES = [
  "OFFICIAL_IDENTITY",
  "TYPED_ADAPTER",
  "OFFICIAL_HTTP_DISCOVERY",
  "HTTP_ADAPTER_RETRY",
  "RENDERED_BROWSER_DISCOVERY",
  "BROWSER_ADAPTER_RETRY",
  "LOCAL_READER",
  "INDEPENDENT_CONFIRMATION",
] as const;
// Four six-hour rechecks per day can legitimately produce multiple start/result
// events per stage. Keep the ledger bounded without exhausting an active alert's
// normal monitoring lifetime or discarding current-cycle proof.
export const AUTOMATION_PLAYBOOK_MAX_EVENTS = 4096;

export const automationPlaybookStageSchema = z.enum(AUTOMATION_PLAYBOOK_STAGES);
export const automationPlaybookTransitionSchema = z.enum([
  "STARTED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "NOT_APPLICABLE",
  "COMPLETED",
  "SUCCEEDED",
  "FACTUAL_FINAL",
  "TECHNICAL_LIMITATION",
]);
export const automationPlaybookReadPathSchema = z.enum([
  "OFFICIAL_IDENTITY",
  "OFFICIAL_HTTP",
  "TYPED_PROVIDER_ADAPTER",
  "RENDERED_BROWSER",
  "LOCAL_READER",
  "INDEPENDENT_CONFIRMATION",
]);
export const automationPlaybookEvidenceKindSchema = z.enum([
  "OFFICIAL_SOURCE",
  "PROVIDER_RESPONSE",
  "RENDERED_PAGE",
  "LOCAL_READER_RESULT",
  "TOOLING",
]);
export const automationPlaybookSkipReasonSchema = z.enum([
  "NO_PROVIDER_METADATA",
  "NO_RUNNABLE_ADAPTER",
  "NO_METADATA_CHANGE",
  "NO_BROWSER_ROUTE",
  "NO_LOCAL_READER_CAPABILITY",
  "NO_INDEPENDENT_CONFIRMATION",
  "MONITORING_MODE_EXCLUDED",
]);
export const automationPlaybookFactualDispositionSchema = z.enum([
  "MANUAL_DIRECT",
  "IDENTITY_FINAL",
]);
export const automationPlaybookTechnicalReasonSchema = z.enum([
  "CAPTCHA_OR_QUEUE",
  "ACCOUNT_REQUIRED",
  "OTHER_TECHNICAL_LIMITATION",
]);
export const automationPlaybookFailureClassSchema = z.enum([
  "MISSING_SOURCE",
  "MISSING_METADATA",
  "UNSUPPORTED_FAMILY",
  "READER_PARSER_MISSING",
  "AUTH",
  "RATE_LIMIT",
  "CHALLENGE",
  "NOT_FOUND",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "SCHEMA",
  "UNKNOWN",
]);
export const automationPlaybookFailureFingerprintSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Z0-9][A-Z0-9._-]*(?::[A-Z0-9][A-Z0-9._-]*)+$/u);
export const automationPlaybookRuntimeVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u);

const EXPECTED_READ_PATH_BY_STAGE = {
  OFFICIAL_IDENTITY: "OFFICIAL_IDENTITY",
  TYPED_ADAPTER: "TYPED_PROVIDER_ADAPTER",
  OFFICIAL_HTTP_DISCOVERY: "OFFICIAL_HTTP",
  HTTP_ADAPTER_RETRY: "TYPED_PROVIDER_ADAPTER",
  RENDERED_BROWSER_DISCOVERY: "RENDERED_BROWSER",
  BROWSER_ADAPTER_RETRY: "TYPED_PROVIDER_ADAPTER",
  LOCAL_READER: "LOCAL_READER",
  INDEPENDENT_CONFIRMATION: "INDEPENDENT_CONFIRMATION",
} as const;

const TERMINAL_STAGE_TRANSITIONS = new Set<AutomationPlaybookTransition>([
  "FAILED_TERMINAL",
  "NOT_APPLICABLE",
  "COMPLETED",
  "SUCCEEDED",
  "FACTUAL_FINAL",
  "TECHNICAL_LIMITATION",
]);

const CONCLUSIVE_TRANSITIONS = new Set<AutomationPlaybookTransition>([
  "SUCCEEDED",
  "FACTUAL_FINAL",
]);

export const automationPlaybookEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    cycle: z.number().int().positive(),
    stage: automationPlaybookStageSchema,
    transition: automationPlaybookTransitionSchema,
    readPath: automationPlaybookReadPathSchema,
    evidenceKind: automationPlaybookEvidenceKindSchema,
    observedAt: z.string().datetime(),
    failureFingerprint: automationPlaybookFailureFingerprintSchema,
    runtimeVersion: automationPlaybookRuntimeVersionSchema,
    failureClass: automationPlaybookFailureClassSchema.optional(),
    skipReason: automationPlaybookSkipReasonSchema.optional(),
    factualDisposition: automationPlaybookFactualDispositionSchema.optional(),
    technicalReason: automationPlaybookTechnicalReasonSchema.optional(),
    note: z.string().trim().min(1).max(240).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const expectedReadPath = EXPECTED_READ_PATH_BY_STAGE[event.stage];
    if (event.readPath !== expectedReadPath) {
      context.addIssue({
        code: "custom",
        path: ["readPath"],
        message: `${event.stage} must use ${expectedReadPath}.`,
      });
    }

    const failureTransition =
      event.transition === "FAILED_RETRYABLE" ||
      event.transition === "FAILED_TERMINAL";
    if (failureTransition !== Boolean(event.failureClass)) {
      context.addIssue({
        code: "custom",
        path: ["failureClass"],
        message: failureTransition
          ? "A failed attempt requires a normalized failure class."
          : "Only a failed attempt may include a failure class.",
      });
    }

    if ((event.transition === "NOT_APPLICABLE") !== Boolean(event.skipReason)) {
      context.addIssue({
        code: "custom",
        path: ["skipReason"],
        message:
          event.transition === "NOT_APPLICABLE"
            ? "An inapplicable stage requires a bounded reason."
            : "Only an inapplicable stage may include a skip reason.",
      });
    }

    if (
      (event.transition === "FACTUAL_FINAL") !==
      Boolean(event.factualDisposition)
    ) {
      context.addIssue({
        code: "custom",
        path: ["factualDisposition"],
        message:
          event.transition === "FACTUAL_FINAL"
            ? "A factual final requires a factual disposition."
            : "Only a factual final may include a factual disposition.",
      });
    }
    if (
      event.transition === "FACTUAL_FINAL" &&
      !["OFFICIAL_SOURCE", "RENDERED_PAGE"].includes(event.evidenceKind)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceKind"],
        message:
          "A factual short-circuit requires current official or rendered-page evidence.",
      });
    }
    if (
      event.transition === "FACTUAL_FINAL" &&
      ![
        "OFFICIAL_IDENTITY",
        "RENDERED_BROWSER_DISCOVERY",
        "INDEPENDENT_CONFIRMATION",
      ].includes(event.stage)
    ) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message:
          "A factual short-circuit requires current official identity, rendered discovery, or independent confirmation evidence.",
      });
    }

    if (
      (event.transition === "TECHNICAL_LIMITATION") !==
      Boolean(event.technicalReason)
    ) {
      context.addIssue({
        code: "custom",
        path: ["technicalReason"],
        message:
          event.transition === "TECHNICAL_LIMITATION"
            ? "A technical observation requires a precise technical reason."
            : "Only a technical observation may include a technical reason.",
      });
    }
    if (
      event.transition === "TECHNICAL_LIMITATION" &&
      event.evidenceKind === "TOOLING"
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceKind"],
        message:
          "A tooling failure is not proof of a course technical limitation.",
      });
    }
  });

export const automationPlaybookLedgerSchema = z
  .object({
    version: z.literal(AUTOMATION_PLAYBOOK_VERSION),
    events: z
      .array(automationPlaybookEventSchema)
      .max(AUTOMATION_PLAYBOOK_MAX_EVENTS),
  })
  .strict()
  .superRefine((ledger, context) => {
    let prior: AutomationPlaybookEvent | null = null;
    for (const [index, event] of ledger.events.entries()) {
      if (event.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message:
            "Attempt-ledger sequences must be contiguous and append-only.",
        });
      }
      if (!prior) {
        if (event.stage !== AUTOMATION_PLAYBOOK_STAGES[0]) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "stage"],
            message:
              "Each playbook cycle must start with official identity verification.",
          });
        }
        prior = event;
        continue;
      }
      if (
        new Date(event.observedAt).getTime() <
        new Date(prior.observedAt).getTime()
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "observedAt"],
          message: "Attempt-ledger timestamps must not move backward.",
        });
      }
      if (event.cycle < prior.cycle) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "cycle"],
          message: "Attempt-ledger cycles must not move backward.",
        });
        prior = event;
        continue;
      }
      if (event.cycle > prior.cycle) {
        if (event.stage !== AUTOMATION_PLAYBOOK_STAGES[0]) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "stage"],
            message:
              "A new incident cycle must restart at official identity verification.",
          });
        }
        prior = event;
        continue;
      }

      if (CONCLUSIVE_TRANSITIONS.has(prior.transition)) {
        context.addIssue({
          code: "custom",
          path: ["events", index],
          message: "A concluded playbook cycle cannot receive another event.",
        });
        prior = event;
        continue;
      }
      const priorStageIndex = AUTOMATION_PLAYBOOK_STAGES.indexOf(prior.stage);
      const stageIndex = AUTOMATION_PLAYBOOK_STAGES.indexOf(event.stage);
      if (stageIndex < priorStageIndex) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "stage"],
          message:
            "Attempt-ledger stages must not move backward within a cycle.",
        });
      } else if (
        stageIndex === priorStageIndex &&
        isTerminalStageTransition(prior.transition)
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "stage"],
          message:
            "A completed stage cannot receive another event in the same cycle.",
        });
      } else if (stageIndex > priorStageIndex) {
        if (stageIndex !== priorStageIndex + 1) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "stage"],
            message: "Skipped playbook stages must be recorded explicitly.",
          });
        }
        if (!isTerminalStageTransition(prior.transition)) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "stage"],
            message:
              "The prior stage must reach a terminal transition before advancing.",
          });
        }
      }
      prior = event;
    }
  });

export type AutomationPlaybookStage = z.infer<
  typeof automationPlaybookStageSchema
>;
export type AutomationPlaybookTransition = z.infer<
  typeof automationPlaybookTransitionSchema
>;
export type AutomationPlaybookReadPath = z.infer<
  typeof automationPlaybookReadPathSchema
>;
export type AutomationPlaybookEvidenceKind = z.infer<
  typeof automationPlaybookEvidenceKindSchema
>;
export type AutomationPlaybookSkipReason = z.infer<
  typeof automationPlaybookSkipReasonSchema
>;
export type AutomationPlaybookFactualDisposition = z.infer<
  typeof automationPlaybookFactualDispositionSchema
>;
export type AutomationPlaybookTechnicalReason = z.infer<
  typeof automationPlaybookTechnicalReasonSchema
>;
export type AutomationPlaybookFailureClass = z.infer<
  typeof automationPlaybookFailureClassSchema
>;
export type AutomationPlaybookEvent = z.infer<
  typeof automationPlaybookEventSchema
>;
export type AutomationPlaybookLedger = z.infer<
  typeof automationPlaybookLedgerSchema
>;

export type AutomationPlaybookEventInput = Omit<
  AutomationPlaybookEvent,
  "sequence" | "observedAt" | "note"
> & {
  observedAt?: Date;
  note?: string | null;
};

export type AutomationPlaybookConclusion =
  | "INCOMPLETE"
  | "MONITORING_RESTORED"
  | "FACTUAL_FINAL"
  | "TECHNICAL_FINAL"
  | "UNRESOLVED_EXHAUSTED";

export type AutomationPlaybookStageAssessment = {
  stage: AutomationPlaybookStage;
  applicability: "UNKNOWN" | "APPLICABLE" | "NOT_APPLICABLE";
  status: "PENDING" | AutomationPlaybookTransition;
  attemptCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  completedAt: string | null;
};

export type AutomationPlaybookAssessment = {
  valid: boolean;
  version: typeof AUTOMATION_PLAYBOOK_VERSION | null;
  cycle: number | null;
  conclusion: AutomationPlaybookConclusion;
  nextStage: AutomationPlaybookStage | null;
  completedStages: AutomationPlaybookStage[];
  factualDisposition: AutomationPlaybookFactualDisposition | null;
  technicalReason: AutomationPlaybookTechnicalReason | null;
  technicalObservationCount: number;
  stages: AutomationPlaybookStageAssessment[];
};

export function parseAutomationPlaybookLedger(
  value: unknown,
): AutomationPlaybookLedger | null {
  const parsed = automationPlaybookLedgerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function getAutomationPlaybookFactualFinalEvidence(
  value: unknown,
  cycle: number,
) {
  const ledger = parseAutomationPlaybookLedger(value);
  const event = ledger?.events.find(
    (candidate) =>
      candidate.cycle === cycle && candidate.transition === "FACTUAL_FINAL",
  );
  if (!event?.factualDisposition) return null;
  return {
    disposition: event.factualDisposition,
    observedAt: new Date(event.observedAt),
  };
}

export function appendAutomationPlaybookEvent(
  currentValue: unknown,
  rawInput: AutomationPlaybookEventInput,
): AutomationPlaybookLedger {
  const { observedAt, note: rawNote, ...input } = rawInput;
  const current =
    currentValue === null || currentValue === undefined
      ? ({
          version: AUTOMATION_PLAYBOOK_VERSION,
          events: [],
        } satisfies AutomationPlaybookLedger)
      : parseAutomationPlaybookLedger(currentValue);
  if (!current) {
    throw new Error(
      "The stored automation attempt ledger is invalid and requires repair.",
    );
  }
  const currentAssessment = assessAutomationPlaybook(current, input.cycle);
  if (
    currentAssessment.cycle === input.cycle &&
    currentAssessment.conclusion !== "INCOMPLETE"
  ) {
    throw new Error(
      "The current automation playbook cycle is already concluded.",
    );
  }

  const note = sanitizeAutomationPlaybookNote(rawNote);
  const event = automationPlaybookEventSchema.parse({
    ...input,
    sequence: current.events.length + 1,
    observedAt: (observedAt ?? new Date()).toISOString(),
    ...(note ? { note } : {}),
  });
  return automationPlaybookLedgerSchema.parse({
    version: AUTOMATION_PLAYBOOK_VERSION,
    events: [...current.events, event],
  });
}

export function assessAutomationPlaybook(
  value: unknown,
  requestedCycle?: number | null,
): AutomationPlaybookAssessment {
  const ledger = parseAutomationPlaybookLedger(value);
  if (!ledger) {
    return incompleteAssessment(false, requestedCycle ?? null);
  }
  const cycle = requestedCycle ?? ledger.events.at(-1)?.cycle ?? null;
  if (!cycle) {
    return incompleteAssessment(true, null);
  }
  const events = ledger.events.filter((event) => event.cycle === cycle);
  if (events.length === 0) {
    return incompleteAssessment(true, cycle);
  }
  const stages = buildStageAssessments(events);
  const completedStages = stages
    .filter((stage) => stage.completedAt)
    .map((stage) => stage.stage);
  const succeeded = events.find((event) => event.transition === "SUCCEEDED");
  if (succeeded) {
    return {
      valid: true,
      version: AUTOMATION_PLAYBOOK_VERSION,
      cycle,
      conclusion: "MONITORING_RESTORED",
      nextStage: null,
      completedStages,
      factualDisposition: null,
      technicalReason: null,
      technicalObservationCount: 0,
      stages,
    };
  }
  const factualFinal = events.find(
    (event) => event.transition === "FACTUAL_FINAL",
  );
  if (factualFinal?.factualDisposition) {
    return {
      valid: true,
      version: AUTOMATION_PLAYBOOK_VERSION,
      cycle,
      conclusion: "FACTUAL_FINAL",
      nextStage: null,
      completedStages,
      factualDisposition: factualFinal.factualDisposition,
      technicalReason: null,
      technicalObservationCount: 0,
      stages,
    };
  }

  const technicalObservations = new Map<
    AutomationPlaybookTechnicalReason,
    Set<AutomationPlaybookReadPath>
  >();
  for (const event of events) {
    if (event.transition !== "TECHNICAL_LIMITATION" || !event.technicalReason) {
      continue;
    }
    const paths = technicalObservations.get(event.technicalReason) ?? new Set();
    paths.add(event.readPath);
    technicalObservations.set(event.technicalReason, paths);
  }
  const localReaderTechnical = events.find(
    (event) =>
      event.stage === "LOCAL_READER" &&
      event.transition === "TECHNICAL_LIMITATION",
  );
  const independentConfirmation = events.find(
    (event) =>
      event.stage === "INDEPENDENT_CONFIRMATION" &&
      event.transition === "TECHNICAL_LIMITATION" &&
      event.technicalReason === localReaderTechnical?.technicalReason,
  );
  const confirmedTechnicalReason = localReaderTechnical?.technicalReason;
  const confirmedTechnical = confirmedTechnicalReason
    ? technicalObservations.get(confirmedTechnicalReason)
    : null;
  if (
    independentConfirmation &&
    confirmedTechnicalReason &&
    confirmedTechnical &&
    confirmedTechnical.size >= 2
  ) {
    return {
      valid: true,
      version: AUTOMATION_PLAYBOOK_VERSION,
      cycle,
      conclusion: "TECHNICAL_FINAL",
      nextStage: null,
      completedStages,
      factualDisposition: null,
      technicalReason: confirmedTechnicalReason,
      technicalObservationCount: confirmedTechnical.size,
      stages,
    };
  }

  const nextStage = AUTOMATION_PLAYBOOK_STAGES.find(
    (stage) => !completedStages.includes(stage),
  );
  return {
    valid: true,
    version: AUTOMATION_PLAYBOOK_VERSION,
    cycle,
    conclusion: nextStage ? "INCOMPLETE" : "UNRESOLVED_EXHAUSTED",
    nextStage: nextStage ?? null,
    completedStages,
    factualDisposition: null,
    technicalReason: null,
    technicalObservationCount: Math.max(
      0,
      ...[...technicalObservations.values()].map((paths) => paths.size),
    ),
    stages,
  };
}

export function isAutomationPlaybookExhausted(
  value: unknown,
  cycle?: number | null,
) {
  const conclusion = assessAutomationPlaybook(value, cycle).conclusion;
  return (
    conclusion === "TECHNICAL_FINAL" || conclusion === "UNRESOLVED_EXHAUSTED"
  );
}

export function isAutomationHumanReviewProofCurrentOrPrior(
  value: unknown,
  cycle?: number | null,
) {
  if (!cycle || cycle < 1) {
    return false;
  }
  return (
    isAutomationPlaybookExhausted(value, cycle) ||
    (cycle > 1 && isAutomationPlaybookExhausted(value, cycle - 1))
  );
}

export function serializeAutomationPlaybookLedger(
  ledger: AutomationPlaybookLedger,
): Prisma.InputJsonObject {
  return ledger as unknown as Prisma.InputJsonObject;
}

function incompleteAssessment(
  valid: boolean,
  cycle: number | null,
): AutomationPlaybookAssessment {
  return {
    valid,
    version: valid ? AUTOMATION_PLAYBOOK_VERSION : null,
    cycle,
    conclusion: "INCOMPLETE",
    nextStage: AUTOMATION_PLAYBOOK_STAGES[0],
    completedStages: [],
    factualDisposition: null,
    technicalReason: null,
    technicalObservationCount: 0,
    stages: buildStageAssessments([]),
  };
}

function buildStageAssessments(
  events: AutomationPlaybookEvent[],
): AutomationPlaybookStageAssessment[] {
  return AUTOMATION_PLAYBOOK_STAGES.map((stage) => {
    const stageEvents = events.filter((event) => event.stage === stage);
    const lastEvent = stageEvents.at(-1);
    const resultCount = stageEvents.filter(
      (event) =>
        event.transition !== "STARTED" && event.transition !== "NOT_APPLICABLE",
    ).length;
    const startedCount = stageEvents.filter(
      (event) => event.transition === "STARTED",
    ).length;
    const terminalEvent = [...stageEvents]
      .reverse()
      .find((event) => isTerminalStageTransition(event.transition));
    return {
      stage,
      applicability:
        lastEvent?.transition === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : stageEvents.length > 0
            ? "APPLICABLE"
            : "UNKNOWN",
      status: lastEvent?.transition ?? "PENDING",
      attemptCount: Math.max(startedCount, resultCount),
      firstObservedAt: stageEvents[0]?.observedAt ?? null,
      lastObservedAt: lastEvent?.observedAt ?? null,
      completedAt: terminalEvent?.observedAt ?? null,
    };
  });
}

function isTerminalStageTransition(transition: AutomationPlaybookTransition) {
  return TERMINAL_STAGE_TRANSITIONS.has(transition);
}

function sanitizeAutomationPlaybookNote(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return sanitizeResponderText(trimmed)
    .replace(/\bhttps?:\/\/[^\s<>'"]+/giu, "[redacted-url]")
    .slice(0, 240)
    .trim();
}
