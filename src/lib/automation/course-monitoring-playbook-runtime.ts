import type { CourseMonitoringEventSource } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { recordCourseMonitoringPlaybookTransition } from "./course-monitoring";
import type { CourseSupportBrowserPersistenceFence } from "./course-support-browser-stages";
import {
  assessAutomationPlaybook,
  parseAutomationPlaybookLedger,
  type AutomationPlaybookAssessment,
  type AutomationPlaybookEvidenceKind,
  type AutomationPlaybookFailureClass,
  type AutomationPlaybookFactualDisposition,
  type AutomationPlaybookReadPath,
  type AutomationPlaybookSkipReason,
  type AutomationPlaybookStage,
  type AutomationPlaybookTechnicalReason,
  type AutomationPlaybookTransition,
} from "./course-monitoring-playbook";

export type CourseMonitoringPlaybookRuntime = {
  courseId: string;
  incidentId: string;
  cycle: number;
  assessment: AutomationPlaybookAssessment;
  localReaderTechnicalReason: AutomationPlaybookTechnicalReason | null;
};

export type RuntimePlaybookTransitionInput = {
  stage: AutomationPlaybookStage;
  transition: AutomationPlaybookTransition;
  readPath: AutomationPlaybookReadPath;
  evidenceKind: AutomationPlaybookEvidenceKind;
  runtimeVersion: string;
  failureClass?: AutomationPlaybookFailureClass;
  skipReason?: AutomationPlaybookSkipReason;
  factualDisposition?: AutomationPlaybookFactualDisposition;
  technicalReason?: AutomationPlaybookTechnicalReason;
  source?: CourseMonitoringEventSource;
  now?: Date;
};

export async function loadCourseMonitoringPlaybookRuntime(
  courseId: string,
): Promise<CourseMonitoringPlaybookRuntime | null> {
  const incident = await prisma.courseSupportIncident.findUnique({
    where: { courseId },
    select: {
      id: true,
      cycle: true,
      status: true,
      attemptLedger: true,
    },
  });
  if (!incident || incident.status === "RESOLVED") {
    return null;
  }

  const ledger = parseAutomationPlaybookLedger(incident.attemptLedger);
  const localReaderTechnicalReason =
    [...(ledger?.events ?? [])]
      .reverse()
      .find(
        (event) =>
          event.cycle === incident.cycle &&
          event.stage === "LOCAL_READER" &&
          event.transition === "TECHNICAL_LIMITATION",
      )?.technicalReason ?? null;

  return {
    courseId,
    incidentId: incident.id,
    cycle: incident.cycle,
    assessment: assessAutomationPlaybook(
      incident.attemptLedger,
      incident.cycle,
    ),
    localReaderTechnicalReason,
  };
}

export async function recordRuntimePlaybookTransition(
  runtime: CourseMonitoringPlaybookRuntime,
  input: RuntimePlaybookTransitionInput,
  browserPersistenceFence?: CourseSupportBrowserPersistenceFence,
) {
  if (runtime.assessment.conclusion !== "INCOMPLETE") {
    return { recorded: false as const, reason: "CONCLUDED" as const };
  }
  if (runtime.assessment.nextStage !== input.stage) {
    return { recorded: false as const, reason: "OUT_OF_ORDER" as const };
  }
  const currentStage = runtime.assessment.stages.find(
    (stage) => stage.stage === input.stage,
  );
  if (input.transition === "STARTED" && currentStage?.status === "STARTED") {
    return { recorded: false as const, reason: "ALREADY_STARTED" as const };
  }

  const result = await recordCourseMonitoringPlaybookTransition({
    courseId: runtime.courseId,
    incidentId: runtime.incidentId,
    stage: input.stage,
    transition: input.transition,
    readPath: input.readPath,
    evidenceKind: input.evidenceKind,
    failureFingerprint: buildRuntimePlaybookFingerprint(input),
    runtimeVersion: input.runtimeVersion,
    failureClass: input.failureClass,
    skipReason: input.skipReason,
    factualDisposition: input.factualDisposition,
    technicalReason: input.technicalReason,
    note: getRuntimePlaybookNote(input.stage, input.transition),
    source: input.source,
    now: input.now,
    browserPersistenceFence,
  });
  if (!result) {
    return { recorded: false as const, reason: "UNAVAILABLE" as const };
  }

  runtime.assessment = result.assessment;
  if (
    input.stage === "LOCAL_READER" &&
    input.transition === "TECHNICAL_LIMITATION"
  ) {
    runtime.localReaderTechnicalReason = input.technicalReason ?? null;
  }
  return { recorded: true as const, result };
}

export function buildBrowserPlaybookTransition(input: {
  stage: "RENDERED_BROWSER_DISCOVERY" | "INDEPENDENT_CONFIRMATION";
  technicalReason: AutomationPlaybookTechnicalReason | null;
  localReaderTechnicalReason: AutomationPlaybookTechnicalReason | null;
  factualDisposition?: AutomationPlaybookFactualDisposition | null;
}): Pick<
  RuntimePlaybookTransitionInput,
  "transition" | "evidenceKind" | "technicalReason" | "factualDisposition"
> {
  if (input.factualDisposition) {
    return {
      transition: "FACTUAL_FINAL",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: undefined,
      factualDisposition: input.factualDisposition,
    };
  }
  if (
    input.technicalReason &&
    (input.stage === "RENDERED_BROWSER_DISCOVERY" ||
      input.technicalReason === input.localReaderTechnicalReason)
  ) {
    return {
      transition: "TECHNICAL_LIMITATION",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: input.technicalReason,
      factualDisposition: undefined,
    };
  }
  return {
    transition: "COMPLETED",
    evidenceKind: "RENDERED_PAGE",
    technicalReason: undefined,
    factualDisposition: undefined,
  };
}

export function canResolveAutomaticBrowserTechnicalFinal(input: {
  playbookConclusion: AutomationPlaybookAssessment["conclusion"];
  monitoringState: string | null | undefined;
}) {
  return (
    input.playbookConclusion === "TECHNICAL_FINAL" &&
    input.monitoringState === "FINAL_TECHNICAL"
  );
}

export function getBrowserFactualFinality(
  disposition: AutomationPlaybookFactualDisposition,
) {
  if (disposition === "IDENTITY_FINAL") {
    return {
      state: "FINAL_IDENTITY" as const,
      outcome: "IDENTITY_FINAL" as const,
      resolution: "IDENTITY_CLASSIFIED" as const,
    };
  }
  return {
    state: "FINAL_MANUAL" as const,
    outcome: "MANUAL_DIRECT" as const,
    resolution: "DIRECT_BOOKING_CLASSIFIED" as const,
  };
}

function buildRuntimePlaybookFingerprint(
  input: RuntimePlaybookTransitionInput,
) {
  const result =
    input.technicalReason ??
    input.factualDisposition ??
    input.skipReason ??
    input.failureClass ??
    input.transition;
  return `PLAYBOOK:${input.stage}:${result}`;
}

function getRuntimePlaybookNote(
  stage: AutomationPlaybookStage,
  transition: AutomationPlaybookTransition,
) {
  return `Ordered automation stage ${stage.toLowerCase().replaceAll("_", " ")} recorded ${transition.toLowerCase().replaceAll("_", " ")}.`;
}
