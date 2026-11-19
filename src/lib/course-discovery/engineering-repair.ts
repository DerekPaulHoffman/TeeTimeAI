import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { reportCourseSupportIssue } from "@/lib/automation/support-incidents";
import { reconcileSimulatorSupportIncidentFailure } from "@/lib/automation/simulator-support-incidents";
import { AUTOMATION_PLAYBOOK_VERSION } from "@/lib/automation/course-monitoring-playbook";
import { isCourseDiscoveryEnabled, isGeneralDiscoveryEnabled } from "./config";
import { currentDiscoveryEngineeringFailure } from "./service";
import { hasLegacyDiscoveryOwner } from "./legacy-exclusion";
import { isDataOnlyFullRepair } from "@/lib/automation/course-support-full-repair";
import { createCourseSupportRemediationCourseRef } from "@/lib/automation/course-support-claim-evidence";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { delegatedDiagnosticGates, delegatedDiagnosticStages, delegatedFacilityBindingDiagnosticGates } from "./teeitup-delegated-booking-diagnostic";
import { bookingEdgeEvidenceSchema } from "./booking-edge-evidence";
import { hasReciprocalLearningRepairLink, readLearningRepairRecoveries, readLearningRepairRecoveryOf } from "./learning-repair-recovery";
import { projectStagehandNativeRouterFailure, stagehandNativeRouterCodes } from "./stagehand-native-router-diagnostic";
import { cpsPhoneBookingFailureStages } from "./cps-phone-booking-proof";
import { cpsCatalogIdentityFailureStages } from "./cps-source";
import { physicalBindingFailureEvidenceSchema } from "./physical-binding-failure-evidence";
import { safeOfficialSourceDiagnostic, navigationFailureKinds } from "./official-source-diagnostics";

const receiptSchema = z.object({ version: z.literal(1), state: z.literal("QUEUED"),
  incidentId: z.string().min(1).max(128), queuedAt: z.string().datetime(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
type Reader = Parameters<typeof currentDiscoveryEngineeringFailure>[0];
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const safeCode = (v: unknown) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(v) ? v : null;
// A diagnostic projection, not a checkpoint validator. Keep the generic `code`
// credential redacted; only these known worker outcomes may cross the CLI as a
// failureCode. Unknown and model-supplied uppercase strings remain unavailable.
const diagnosticFailureCodes = new Set([
  "GUARDED_HOST", "BROWSER_UNAVAILABLE", "ADAPTER_TRANSPORT_FAILED",
  "ADAPTER_CONFIGURATION_CHANGED", "ADAPTER_CONFIGURATION_UNVERIFIED", "ADAPTER_IDENTITY_MISMATCH",
  "INVALID_ADAPTER_SOURCE", "UNSUPPORTED_ADAPTER_SOURCE", "CPS_PUBLIC_BUILD_UNSUPPORTED",
  "STAGEHAND_WORKER_FAILED", "STAGEHAND_SOURCE_DISCOVERY_FAILED", "STAGEHAND_SOURCE_OUTPUT_INVALID",
  "STAGEHAND_FIXED_INSPECTION_FAILED", "STAGEHAND_SOURCE_BUDGET_EXHAUSTED",
  "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED", "OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED",
  "FOREUP_OFFICIAL_ROUTE_UNVERIFIED", "USCHEDULE_PUBLIC_LOCATION_UNVERIFIED", "USCHEDULE_PUBLIC_PARTY_UNVERIFIED",
  "OFFICIAL_POSTAL_SOURCE_UNVERIFIED", "CPS_PHONE_BOOKING_SOURCE_UNVERIFIED", "CPS_OFFICIAL_ENTRY_UNVERIFIED",
  "OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED", "OFFICIAL_STREET_TYPE_OMITTED_CHANGED",
  "OFFICIAL_CONTACT_SOURCE_UNVERIFIED", "OFFICIAL_CONTACT_READER_UNAVAILABLE", "OFFICIAL_CONTACT_ROOT_READ_UNVERIFIED",
  "OFFICIAL_CONTACT_ROOT_LINK_UNVERIFIED", "OFFICIAL_CONTACT_PAGE_READ_UNVERIFIED", "OFFICIAL_CONTACT_DOCUMENT_UNVERIFIED",
  "OFFICIAL_CONTACT_DEADLINE_EXCEEDED", "OFFICIAL_CONTACT_CHAIN_READ_UNVERIFIED",
  "OFFICIAL_CONTACT_DIRECTORY_BIND_UNVERIFIED", "OFFICIAL_CONTACT_DIRECTORY_READ_UNVERIFIED",
  "DISCOVERY_WORK_DEADLINE", "DISCOVERY_RECIPE_INVALID", "DISCOVERY_REPLAY_INCOMPLETE", "DISCOVERY_CHALLENGE_INVALID",
  "DISCOVERY_LEASE_REJECTED", "DISCOVERY_LEASE_EXPIRED", "DISCOVERY_CANCELLED",
  "FRAMEWORK_INSPECTION_DEADLINE", "FRAMEWORK_INSPECTION_CANCELLED", "FRAMEWORK_INSPECTION_SOURCE_UNREADABLE",
  "FRAMEWORK_INSPECTION_PATH_STALE", "FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED", "FRAMEWORK_INSPECTION_METADATA_INVALID",
  "FRAMEWORK_INSPECTION_METADATA_CONFLICT", "FRAMEWORK_INSPECTION_PROOF_NOT_BOUND", "FRAMEWORK_INSPECTION_OBSERVATION_INVALID",
  "FRAMEWORK_INSPECTION_CLOSE_FAILED", "FRAMEWORK_INSPECTION_CONTEXT_CHANGED", "FRAMEWORK_INSPECTION_LANDING_CHANGED",
  "FRAMEWORK_HYBRID_REPORT_INVALID", "FRAMEWORK_SOURCE_PROPOSAL_WITH_RECIPE", "FRAMEWORK_INSPECTION_ENGINE_INVALID",
  "FRAMEWORK_HYBRID_SOURCE_NOT_ELIGIBLE", "FRAMEWORK_INSPECTION_SCOPE_INVALID", "FRAMEWORK_INSPECTION_ACTION_LIMIT",
  "FRAMEWORK_INSPECTION_TRANSPORT_CHANGED", "FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED", "FRAMEWORK_INSPECTION_RECEIPT_FAILED",
]);

/** Compatibility for the specific old data-only/code-proof misclassification.
 * Keep the failed batch and original learner clocks; reopen only current,
 * unowned demand once, with an append-only correction and ordinary budgets. */
async function restoreMisclassifiedDataOnlyRepair(tx: Prisma.TransactionClient, input: {
  incident: { id: string; courseId: string; status: string; activeBatchId: string | null; cycle: number;
    humanReviewReason: string | null; updatedAt: Date; failureFingerprint: string; revision: number };
  course: Parameters<typeof buildCourseSupportProviderSnapshotFingerprint>[0];
  sourceFingerprint: string; failedAt: Date; now: Date;
}) {
  const { incident, now } = input;
  if (incident.status !== "NEEDS_HUMAN" || incident.activeBatchId || incident.humanReviewReason !== "AUTOMATION_STALLED") return;
  const batch = await tx.courseSupportBatch.findFirst({
    where: { completedAt: { not: null }, incidents: { some: { incidentId: incident.id, cycle: incident.cycle } } },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    select: { id: true, revision: true, status: true, completedAt: true, baseSha: true, releaseSha: true, summary: true,
      incidents: { select: { courseId: true, incidentId: true, cycle: true, result: true } } },
  });
  if (!batch || batch.status !== "PARTIAL" || batch.incidents.length !== 1 ||
      batch.incidents[0].incidentId !== incident.id || batch.incidents[0].cycle !== incident.cycle ||
      batch.incidents[0].result !== "NEEDS_HUMAN") return;
  const summary = object(batch.summary), directive = object(summary.remediation), closeout = object(summary.closeout);
  const attempts = Array.isArray(directive.attempts) ? directive.attempts.map(object) : [];
  const claim = attempts.length === 1 ? attempts[0] : null;
  const actions = object(claim?.actionPlan).allowedActions;
  if (summary.dataOnlyFullRepairCorrectionV1 || closeout.reason !== "expired_implementation_stopped_without_proof" ||
      closeout.outcome !== "needs_human" || !Array.isArray(summary.plannedPaths) || summary.plannedPaths.length !== 0 ||
      !claim || claim.courseRef !== createCourseSupportRemediationCourseRef(incident.courseId) ||
      claim.providerSnapshotFingerprint !== buildCourseSupportProviderSnapshotFingerprint(input.course) ||
      claim.failureFingerprint !== incident.failureFingerprint || !isDataOnlyFullRepair({
        reason: typeof directive.reason === "string" ? directive.reason : null,
        workMode: typeof directive.workMode === "string" ? directive.workMode : "",
        requiresImplementationPath: directive.requiresImplementationPath !== false,
        plannedPaths: [], baseSha: batch.baseSha, releaseSha: batch.releaseSha,
        allowedActions: Array.isArray(actions) ? actions.filter((v): v is string => typeof v === "string") : [],
      })) return;
  const monitoring = await tx.courseMonitoringStatus.findUnique({ where: { courseId: incident.courseId } });
  if (!monitoring || monitoring.state !== "ENGINEERING_VERIFICATION_NEEDED" ||
      monitoring.failureFingerprint !== incident.failureFingerprint ||
      (monitoring.lastSuccessfulAt && monitoring.lastSuccessfulAt > input.failedAt)) return;
  const latest = await tx.courseSupportBatchIncident.findFirst({ where: { incidentId: incident.id, cycle: incident.cycle,
    batch: { completedAt: null } }, select: { id: true } });
  if (latest) return;
  const nextAttemptAt = now;
  const message = "A full discovery repair had not claimed code; missing code-release proof did not establish an inaccessible course. Resume the unresolved repair under ordinary ownership and verification.";
  const changed = await tx.courseSupportIncident.updateMany({ where: { id: incident.id, updatedAt: incident.updatedAt,
    revision: incident.revision, status: "NEEDS_HUMAN", activeBatchId: null, cycle: incident.cycle }, data: {
    status: "AUTO_INVESTIGATING", nextAttemptAt, humanReviewReason: null, nextReminderAt: null,
    latestMessage: message, nextAction: "Continue the current full repair; preserve failed evidence and require independent saved-method proof.",
    revision: { increment: 1 },
  } });
  if (changed.count !== 1) throw Error("Data-only repair ownership changed during correction.");
  const monitored = await tx.courseMonitoringStatus.updateMany({ where: { courseId: incident.courseId, revision: monitoring.revision,
    state: monitoring.state, lastSuccessfulAt: monitoring.lastSuccessfulAt }, data: { state: "AUTO_INVESTIGATING",
    nextAutomaticAttemptAt: nextAttemptAt, stateChangedAt: now, revision: { increment: 1 } } });
  const corrected = await tx.courseSupportBatch.updateMany({ where: { id: batch.id, revision: batch.revision,
    status: batch.status, completedAt: batch.completedAt }, data: { summary: { ...summary,
    dataOnlyFullRepairCorrectionV1: { schemaVersion: 1, reason: "NO_CODE_PATHS_WERE_CLAIMED", observedAt: now.toISOString(),
      sourceFingerprint: input.sourceFingerprint, incidentCycle: incident.cycle, monitoringRestored: false },
  } as Prisma.InputJsonValue, revision: { increment: 1 } } });
  if (monitored.count !== 1 || corrected.count !== 1) throw Error("Data-only repair evidence changed during correction.");
  await tx.courseMonitoringEvent.create({ data: { courseId: incident.courseId, incidentId: incident.id,
    eventType: "REVALIDATION_REQUESTED", source: "COURSE_SUPPORT_RESPONDER", fromState: monitoring.state,
    toState: "AUTO_INVESTIGATING", failureFingerprint: incident.failureFingerprint, readPath: "DISCOVERY_CODE_REPAIR",
    message, occurredAt: now, idempotencyKey: `data-only-full-repair-correction:${batch.id}`,
    audit: { schemaVersion: 1, priorBatchPreserved: true, clocksPreserved: true, codePathsClaimed: false, monitoringRestored: false } } });
}
async function initializeEmptyInvestigation(tx: Pick<Prisma.TransactionClient, "courseSupportIncident">,
  incident: { id: string; updatedAt: Date; attemptLedger: unknown }) {
  if (incident.attemptLedger !== null) return true;
  const initialized = await tx.courseSupportIncident.updateMany({ where: { id: incident.id, updatedAt: incident.updatedAt,
    status: "AUTO_INVESTIGATING", activeBatchId: null }, data: { attemptLedger: { version: AUTOMATION_PLAYBOOK_VERSION, events: [] } } });
  return initialized.count === 1;
}

/** Closed hints only. Model checkpoints explain a failure, never establish
 * monitoring eligibility, completeness, access requirements or write authority. */
const inspectionReadabilitySchema = z.array(z.object({
  action: z.enum(["open", "observe", "inspect_adapter", "click"]), actionIndex: z.number().int().min(1).max(6),
  currentUrlCategory: z.enum(["OFFICIAL_ORIGIN", "BOOKING_ORIGIN", "OTHER_PUBLIC_HTTPS", "NON_PUBLIC_OR_INVALID"]),
  nativeTransport: z.boolean().nullable(), navigationStatusPresent: z.boolean(), navigationStatus: z.number().int().min(100).max(599).nullable(),
  accessRequirementObserved: z.boolean().nullable(), nativeFatalPresent: z.boolean(), nativeFatalCode: z.enum(stagehandNativeRouterCodes).nullable(),
  readyState: z.enum(["loading", "interactive", "complete"]).nullable(), pendingRequestCount: z.number().int().min(0).max(2048).nullable(),
  officialDocumentCurrent: z.boolean().nullable(),
  failedPredicates: z.array(z.enum(["TRANSPORT_CHANGED", "PUBLIC_URL_REJECTED", "ACCESS_REQUIREMENT", "NATIVE_FATAL", "OPEN_STATUS_MISSING", "STATUS_REJECTED"])).max(6),
})).min(1).max(6).refine(rows => new Set(rows.map(row => row.actionIndex)).size === rows.length);
const inspectionExecutionSchema = z.object({
  boundary: z.enum(["PREPARATION", "BROWSER_CREATE", "SOURCE_ROUTING", "BROWSER_REQUEST", "SNAPSHOT_VALIDATION", "RECIPE_VALIDATION", "SOURCE_BINDING", "CLEANUP"]),
  action: z.enum(["open", "observe", "inspect_adapter", "click"]).nullable(), actionIndex: z.number().int().min(0).max(6),
  snapshotReturned: z.boolean(), browserCreated: z.boolean(), browserClosed: z.boolean(),
  failureCode: z.enum(["UNKNOWN", "BROWSER_ACTION_FAILED", "BROWSER_ACTION_SCHEMA_INVALID", "BROWSER_EVALUATION_FAILED",
    "BROWSER_NAVIGATION_FAILED", "BROWSER_UNAVAILABLE", "DISCOVERY_PROCESS_REQUEST_FAILED", "DISCOVERY_PROCESS_OUTPUT_LIMIT",
    "DISCOVERY_PROCESS_PROTOCOL_INVALID", "DISCOVERY_PROCESS_FAILED", "DISCOVERY_PROCESS_CLOSED", "DISCOVERY_PROCESS_INPUT_FAILED",
    "DISCOVERY_PROCESS_TIMEOUT", "DISCOVERY_TOOL_FAILED", "DISCOVERY_CANCELLED", "PROVIDER_COORDINATION_UNAVAILABLE",
    "FIXED_CPS_SOURCE_DOCUMENT_SCOPE_INVALID", "FIXED_INSPECTION_FRAME_SCOPE_INVALID"]),
}).refine(row => (row.actionIndex === 0) === (row.action === null) && (!row.snapshotReturned || row.actionIndex > 0) && (!row.browserClosed || row.browserCreated));

export function discoveryFailureDiagnosis(job: { outcome: string | null; checkpoint: unknown }, includeBookingEdgeEvidence = false) {
  const checkpoint = object(job.checkpoint), progress = object(checkpoint.stagehandProgress), failure = object(checkpoint.stagehandFailure);
  // The native worker writes a bounded attempt history, not a flat code. Do
  // not turn arbitrary checkpoint prose into a repair instruction.
  const entries = failure.schemaVersion === 1 && failure.kind === "OWN_STAGEHAND_FAILURE_DIAGNOSTIC" &&
    Array.isArray(failure.entries) && failure.entries.length > 0 && failure.entries.length <= 2
    ? failure.entries.map(object) : [];
  const validHistory = entries.every((entry, index) => [1, 2].includes(entry.attempt as number) &&
    (index === 0 || (entries[index - 1].attempt as number) < (entry.attempt as number)) && safeCode(entry.code) && safeCode(entry.phase));
  const last = validHistory ? entries.at(-1) : undefined;
  const code = safeCode(last?.code ?? failure.code), phase = safeCode(last?.phase ?? progress.phase);
  const category = job.outcome === "DEADLINE" ? "DEADLINE_EXCEEDED" : job.outcome === "UNSUPPORTED" ? "MISSING_READER_CAPABILITY" :
    code === "GUARDED_HOST" ? "BROWSER_TRANSPORT_REJECTED" : code === "ADAPTER_CONFIGURATION_CHANGED" ? "SAVED_METHOD_SOURCE_CHANGED" :
      code === "BROWSER_UNAVAILABLE" ? "LOCAL_BROWSER_UNAVAILABLE" : phase === "INDEPENDENT_REPLAY" || phase === "REPLAY" ? "REPLAY_VALIDATION_FAILED" : "READER_OR_RUNTIME_FAILURE";
  const diagnostic = object(object(last?.fixedInspectionDiagnostic).teeItUpDelegation);
  const gates = object(diagnostic.gates);
  const delegationDiagnostic = delegatedDiagnosticStages.some(stage => stage === diagnostic.stage) &&
    delegatedDiagnosticGates.every(key => gates[key] === null || typeof gates[key] === "boolean")
    ? { stage: diagnostic.stage, gates: [...delegatedDiagnosticGates, ...delegatedFacilityBindingDiagnosticGates.filter(key =>
      gates[key] === null || typeof gates[key] === "boolean")].map(gate => ({
      gate: gate.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase(), passed: gates[gate] })) }
    : undefined;
  const hopEvidence = includeBookingEdgeEvidence ? bookingEdgeEvidenceSchema.safeParse(diagnostic.hopEvidence) : null;
  const physical = includeBookingEdgeEvidence && diagnostic.stage === "PROVIDER_BIND" ? physicalBindingFailureEvidenceSchema.safeParse(diagnostic.physicalBindingEvidence) : null;
  // Existing persisted inspection facts only. Deliberately omit URL hashes,
  // source text, identities and private binding values from this handoff.
  const readability = inspectionReadabilitySchema.safeParse(object(last?.fixedInspectionDiagnostic).readability);
  const execution = phase === "FIXED_INSPECTION" ? inspectionExecutionSchema.safeParse(object(last?.fixedInspectionDiagnostic).execution) : null;
  const officialSource = phase === "FIXED_INSPECTION" ? safeOfficialSourceDiagnostic(object(last?.fixedInspectionDiagnostic).officialSourceDiagnostic) : undefined;
  const fixedNative = object(object(last?.fixedInspectionDiagnostic).nativeRouterFailure);
  const fixedNativeProjection = phase === "FIXED_INSPECTION" && stagehandNativeRouterCodes.some(code => code === fixedNative.code)
    ? projectStagehandNativeRouterFailure(fixedNative.code, fixedNative) : undefined;
  const { code: fixedNativeCode, ...fixedNativeFacts } = fixedNativeProjection ?? {};
  const navigation = phase === "FIXED_INSPECTION" && navigationFailureKinds.some(kind => kind === object(last?.fixedInspectionDiagnostic).navigationFailureKind)
    ? object(last?.fixedInspectionDiagnostic).navigationFailureKind : undefined;
  // Presence is not validity or authority. A retained digest can explain why
  // diagnostics are unavailable; never reconstruct their omitted contents.
  const fixedInspectionDiagnosticRetention = phase === "FIXED_INSPECTION" && last?.fixedInspectionDiagnostic &&
    typeof last.fixedInspectionDiagnostic === "object" && !Array.isArray(last.fixedInspectionDiagnostic) ? "PRESENT" as const :
    phase === "FIXED_INSPECTION" && last?.fixedInspectionDiagnosticOmittedForBudget === true &&
      typeof last.fixedInspectionDiagnosticSha256 === "string" && /^[a-f0-9]{64}$/u.test(last.fixedInspectionDiagnosticSha256)
      ? "OMITTED_FOR_BUDGET" as const : undefined;
  const inspection = { category, code, failureCode: code && diagnosticFailureCodes.has(code) ? code : null,
    ...(fixedInspectionDiagnosticRetention ? { fixedInspectionDiagnosticRetention } : {}),
    ...(officialSource ? { fixedInspectionSourceDiagnostic: officialSource } : {}),
    ...(fixedNativeCode ? { fixedInspectionNativeTransportDiagnostic: { failureCode: fixedNativeCode, ...fixedNativeFacts } } : {}),
    ...(navigation ? { fixedInspectionNavigationFailureKind: navigation } : {}),
    ...(code === "STAGEHAND_WORKER_FAILED" && ["Error", "TypeError", "RangeError", "SyntaxError", "TimeoutError", "AbortError", "ZodError", "ProtocolError", "UNKNOWN"].includes(String(last?.workerErrorName))
      ? { workerErrorName: last?.workerErrorName } : {}),
    ...(readability.success ? { fixedInspectionReadability: readability.data } : {}),
    ...(execution?.success ? { fixedInspectionExecution: execution.data } : {}),
    ...(code === "CPS_PHONE_BOOKING_SOURCE_UNVERIFIED" && cpsPhoneBookingFailureStages.some(stage =>
      stage === object(last?.fixedInspectionDiagnostic).cpsPhoneBookingFailureStage) ? {
        cpsPhoneBookingFailureStage: object(last?.fixedInspectionDiagnostic).cpsPhoneBookingFailureStage,
      } : {}),
    ...(phase === "FIXED_INSPECTION" && code === "ADAPTER_IDENTITY_MISMATCH" && cpsCatalogIdentityFailureStages.some(stage =>
      stage === object(last?.fixedInspectionDiagnostic).cpsCatalogIdentityFailureStage) ? {
        cpsCatalogIdentityFailureStage: object(last?.fixedInspectionDiagnostic).cpsCatalogIdentityFailureStage,
      } : {}),
    ...(delegationDiagnostic ? { delegationDiagnostic } : {}),
    ...(delegationDiagnostic && hopEvidence?.success ? { bookingEdgeEvidence: hopEvidence.data } : {}),
    ...(delegationDiagnostic && physical?.success ? { physicalBindingEvidence: physical.data } : {}),
    phase, evidenceAuthority: false as const };
  // A fallback retains the fixed rejection as provenance, then serializes its
  // terminal guard last. Do not report the older inspection as the current
  // failure or allow arbitrary checkpoint strings to become reason codes.
  const guard = object(checkpoint.genericGuard);
  const guardCode = job.outcome === "TOOL_FAILURE" &&
    (guard.code === "DISCOVERY_NATIVE_TRANSPORT_FATAL" || guard.code === "DISCOVERY_GENERIC_BUDGET_EXHAUSTED") ? guard.code : null;
  const fatal = object(guard.nativeFirstFatal);
  const { code: nativeFailureCode, ...nativeFacts } = projectStagehandNativeRouterFailure(fatal.code, fatal);
  return { ...inspection, ...(guardCode ? {
    category: guardCode === "DISCOVERY_NATIVE_TRANSPORT_FATAL" ? "BROWSER_TRANSPORT_REJECTED" : "READER_OR_RUNTIME_FAILURE",
    code: guardCode, failureCode: guardCode, phase: "GENERIC_FALLBACK",
    delegationDiagnostic: undefined, bookingEdgeEvidence: undefined, physicalBindingEvidence: undefined, priorInspection: inspection,
    ...(guardCode === "DISCOVERY_NATIVE_TRANSPORT_FATAL" ? {
      nativeTransportDiagnostic: { failureCode: nativeFailureCode, ...nativeFacts },
    } : {}),
  } : {}) };
}

/** Only the same live, source-bound repair owner's reciprocal failed child.
 * Structural facts remain untrusted diagnosis, never provider/read authority. */
export async function getOwnedLearningFailureEvidence(reader: Reader, input: {
  batchId: string; ownerThreadId: string; courseId: string; incidentId: string; incidentCycle: number; providerSnapshotFingerprint: string; now: Date;
}) {
  const current = await currentDiscoveryEngineeringHandoff(reader, { courseId: input.courseId }, input.now);
  if (!current || current.receipt.incidentId !== input.incidentId ||
      buildCourseSupportProviderSnapshotFingerprint(current.source.course) !== input.providerSnapshotFingerprint) return null;
  const parentLink = readLearningRepairRecoveryOf(current.job.result);
  const root = parentLink ? await reader.courseDiscoveryJob.findUnique({ where: { id: parentLink.originalJobId } }) : current.job;
  const link = root && readLearningRepairRecoveries(root.result)?.filter(value => value.batchId === input.batchId &&
    value.ownerThreadId === input.ownerThreadId && value.incidentId === input.incidentId && value.cycle === input.incidentCycle &&
    value.sourceFingerprint === current.job.sourceFingerprint).at(-1);
  if (!root || !link || !hasReciprocalLearningRepairLink(root.result, link)) return null;
  const child = await reader.courseDiscoveryJob.findUnique({ where: { id: link.jobId } });
  if (!child || !["FAILED", "TIMED_OUT"].includes(child.status) || !child.firstPickedUpAt || !child.deadlineAt || !child.completedAt ||
      child.courseId !== input.courseId || child.offeringId !== null || child.targetKey !== root.targetKey ||
      child.baseRecipeId !== root.baseRecipeId || child.sourceFingerprint !== link.sourceFingerprint ||
      object(child.result).executionRuntimeVersion !== link.runtimeVersion ||
      JSON.stringify(readLearningRepairRecoveryOf(child.result)) !== JSON.stringify(link)) return null;
  const diagnosis = discoveryFailureDiagnosis(child, true);
  const evidence = diagnosis.priorInspection?.bookingEdgeEvidence ?? diagnosis.bookingEdgeEvidence;
  const physical = diagnosis.priorInspection?.physicalBindingEvidence ?? diagnosis.physicalBindingEvidence;
  const withinAttempt = (at: string) => Date.parse(at) >= child.firstPickedUpAt!.getTime() &&
    Date.parse(at) <= Math.min(child.deadlineAt!.getTime(), child.completedAt!.getTime(), input.now.getTime());
  if (!evidence && !physical || evidence && (!withinAttempt(evidence.observedAt) || evidence.attestedAt && !withinAttempt(evidence.attestedAt)) ||
      physical && !withinAttempt(physical.observedAt)) return null;
  return { schemaVersion: 1 as const, sourceFingerprint: link.sourceFingerprint, implementationRelease: link.releaseSha,
    executionRuntime: link.runtimeVersion, bookingEdgeEvidence: evidence ?? null, physicalBindingEvidence: physical ?? null,
    evidenceAuthority: false as const, untrustedPageEvidence: true as const };
}

/** Compatibility projection for callers that require a booking-edge witness. */
export async function getOwnedLearningBookingEdgeEvidence(reader: Reader, input: Parameters<typeof getOwnedLearningFailureEvidence>[1]) {
  const value = await getOwnedLearningFailureEvidence(reader, input);
  if (!value?.bookingEdgeEvidence) return null;
  const { bookingEdgeEvidence, physicalBindingEvidence: _physical, ...header } = value; void _physical;
  return { ...header, evidence: bookingEdgeEvidence };
}

export function discoveryEngineeringReceipt(result: unknown) {
  const parsed = receiptSchema.safeParse(object(result).engineeringHandoff);
  return parsed.success ? parsed.data : null;
}

/** A current, server-issued link permits the existing coding responder to own
 * implementation while ordinary saved-method execution can still recover. */
export async function currentDiscoveryEngineeringHandoff(reader: Reader, target: { courseId: string; offeringId?: string | null }, now: Date) {
  if (!isCourseDiscoveryEnabled() || !isGeneralDiscoveryEnabled()) return null;
  const rows = await reader.courseDiscoveryJob.findMany({ where: { courseId: target.courseId, offeringId: target.offeringId ?? null,
    status: { in: ["FAILED", "TIMED_OUT"] }, result: { path: ["engineeringHandoff", "state"], equals: "QUEUED" } },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 17 });
  if (rows.length === 17) throw new Error("Discovery engineering handoff history reached its bounded limit.");
  for (const row of rows) {
    const receipt = discoveryEngineeringReceipt(row.result);
    if (!receipt || receipt.sourceFingerprint !== row.sourceFingerprint) continue;
    const current = await currentDiscoveryEngineeringFailure(reader, row.id, now);
    if (current) return { ...current, receipt };
  }
  return null;
}

export async function discoveryEngineeringContext(reader: Reader, target: { courseId: string; offeringId?: string | null }, incidentId: string, now: Date) {
  const current = await currentDiscoveryEngineeringHandoff(reader, target, now);
  if (!current || current.receipt.incidentId !== incidentId) return null;
  const { job } = current;
  const parentLink = readLearningRepairRecoveryOf(job.result);
  const root = parentLink ? await reader.courseDiscoveryJob.findUnique({ where: { id: parentLink.originalJobId } }) : job;
  const latestLink = root ? readLearningRepairRecoveries(root.result)?.filter(link => link.incidentId === incidentId &&
    link.sourceFingerprint === job.sourceFingerprint).at(-1) : null;
  const child = latestLink ? await reader.courseDiscoveryJob.findUnique({ where: { id: latestLink.jobId } }) : null;
  const validChild = root && child && latestLink && hasReciprocalLearningRepairLink(root.result, latestLink) &&
    child.courseId === job.courseId && child.offeringId === job.offeringId && child.targetKey === root.targetKey &&
    child.sourceFingerprint === latestLink.sourceFingerprint &&
    latestLink.originalJobId === root.id && child.baseRecipeId === root.baseRecipeId &&
    (JSON.stringify(readLearningRepairRecoveryOf(child.result)) === JSON.stringify(latestLink) || child.status === "SUCCEEDED") ? child : null;
  return { version: 1, jobId: job.id, sourceFingerprint: job.sourceFingerprint, baseRecipeId: job.baseRecipeId,
    originalFirstPickupAt: job.firstPickedUpAt!.toISOString(), originalDeadlineAt: job.deadlineAt!.toISOString(),
    completedAt: job.completedAt!.toISOString(), attempts: job.attempts, outcome: job.outcome,
    originalDeadlineExpired: now > job.deadlineAt!, diagnosis: discoveryFailureDiagnosis(job),
    latestLearningRecovery: validChild && latestLink ? { jobId: validChild.id, kind: latestLink.kind,
      implementationRelease: latestLink.releaseSha, executionRuntime: latestLink.runtimeVersion,
      status: validChild.status, outcome: validChild.outcome, attempts: validChild.attempts,
      firstPickedUpAt: validChild.firstPickedUpAt?.toISOString() ?? null, deadlineAt: validChild.deadlineAt?.toISOString() ?? null,
      diagnosis: discoveryFailureDiagnosis(validChild), evidenceAuthority: false as const } : null,
    instruction: "Use the current owned action plan to investigate and repair the failed learning process end to end. A tooling failure is engineering work, not evidence of inaccessible inventory. Reserve implementation paths, test the observed regression, and prove the exact deployed runtime and normal customer recovery. Keep this original job terminal; recovery after its deadline does not pass the original fifteen-minute contract." };
}

/** Existing scheduled coding dispatch is the sole consumer. A restart or a
 * failed queue write retries this idempotent link without retrying discovery,
 * resetting an incident cooldown, sending email or changing customer intent. */
export async function reconcileDiscoveryEngineeringHandoffs(now = new Date()) {
  if (!isCourseDiscoveryEnabled() || !isGeneralDiscoveryEnabled()) return { examined: 0, queued: 0 };
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT j.id FROM "CourseDiscoveryJob" j JOIN "TeeSearch" s ON s.id=j.request->'demand'->>'searchId'
    WHERE j.status IN ('FAILED','TIMED_OUT') AND j.outcome IN ('TOOL_FAILURE','UNSUPPORTED','DEADLINE')
      AND j."firstPickedUpAt" IS NOT NULL AND j."completedAt" <= ${now} AND s.status='ACTIVE'
      AND j.request->'demand'->>'alertGeneration'=s."alertGeneration"::text
      AND s.date >= (${now}::timestamptz - interval '1 day')::date
      AND (COALESCE(j.result->'engineeringHandoff'->>'state','') NOT IN ('QUEUED','OBSOLETE')
        OR (j.result->'engineeringHandoff'->>'state'='QUEUED' AND j."offeringId" IS NULL
          AND j.result->'engineeringHandoff'->>'sourceFingerprint'=j."sourceFingerprint" AND EXISTS (
          SELECT 1 FROM "CourseSupportIncident" i WHERE i.id=j.result->'engineeringHandoff'->>'incidentId'
          AND i."courseId"=j."courseId" AND i."activeBatchId" IS NULL AND
          ((i.status='AUTO_INVESTIGATING' AND (i."attemptLedger" IS NULL OR i."attemptLedger"='null'::jsonb) AND i."firstSeenAt"<=j."completedAt")
           OR (i.status='NEEDS_HUMAN' AND i."humanReviewReason"='AUTOMATION_STALLED' AND EXISTS (
             SELECT 1 FROM "CourseSupportBatchIncident" bi JOIN "CourseSupportBatch" b ON b.id=bi."batchId"
             WHERE bi."incidentId"=i.id AND bi.cycle=i.cycle AND b."completedAt" IS NOT NULL
               AND b.summary#>>'{closeout,reason}'='expired_implementation_stopped_without_proof'
               AND b.summary#>>'{remediation,reason}'='FAILED_LEARNER_IMPLEMENTATION_HANDOFF'
               AND b.summary->'plannedPaths'='[]'::jsonb
               AND (b."releaseSha" IS NULL OR b."releaseSha"=b."baseSha")
               AND b.summary#>'{dataOnlyFullRepairCorrectionV1}' IS NULL))))))
    ORDER BY j."completedAt",j.id LIMIT 16`);
  let queued = 0;
  for (const candidate of candidates) {
    const current = await prisma.$transaction(async tx => {
      const failure = await currentDiscoveryEngineeringFailure(tx, candidate.id, now);
      if (!failure) {
        const obsolete = await tx.courseDiscoveryJob.findUnique({ where: { id: candidate.id } });
        if (obsolete && ["FAILED", "TIMED_OUT"].includes(obsolete.status) && !discoveryEngineeringReceipt(obsolete.result)) {
          await tx.courseDiscoveryJob.updateMany({ where: { id: obsolete.id, status: obsolete.status, updatedAt: obsolete.updatedAt },
            data: { result: { ...object(obsolete.result), engineeringHandoff: { version: 1, state: "OBSOLETE", observedAt: now.toISOString(),
              reason: "SOURCE_DEMAND_OR_SUCCESS_SUPERSEDED_FAILURE" } } as Prisma.InputJsonValue } });
        }
        return null;
      }
      const priorReceipt = discoveryEngineeringReceipt(failure.job.result);
      if (priorReceipt && !failure.job.offeringId && priorReceipt.sourceFingerprint === failure.job.sourceFingerprint) {
        // Compatibility for already queued, unowned handoffs. Keep their
        // receipt, retry state and original job clock exactly as recorded.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Course" WHERE id=${failure.job.courseId} FOR UPDATE`);
        const fresh = await currentDiscoveryEngineeringFailure(tx, failure.job.id, now);
        const freshReceipt = fresh ? discoveryEngineeringReceipt(fresh.job.result) : null;
        if (!fresh || !freshReceipt || freshReceipt.incidentId !== priorReceipt.incidentId ||
            freshReceipt.sourceFingerprint !== priorReceipt.sourceFingerprint || freshReceipt.queuedAt !== priorReceipt.queuedAt ||
            await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: failure.job.targetKey } }) ||
            await hasLegacyDiscoveryOwner(tx, failure.request.target)) return null;
        const incident = await tx.courseSupportIncident.findUnique({ where: { id: priorReceipt.incidentId } });
        if (incident?.courseId === failure.job.courseId) await restoreMisclassifiedDataOnlyRepair(tx, {
          incident, course: fresh.source.course, sourceFingerprint: fresh.job.sourceFingerprint,
          failedAt: fresh.job.completedAt!, now,
        });
        if (incident?.courseId === failure.job.courseId && incident.status === "AUTO_INVESTIGATING" &&
            incident.activeBatchId === null && incident.firstSeenAt <= failure.job.completedAt!) await initializeEmptyInvestigation(tx, incident);
        return null;
      }
      if (priorReceipt ||
          await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: failure.job.targetKey } }) ||
          await hasLegacyDiscoveryOwner(tx, failure.request.target)) return null;
      return failure;
    });
    if (!current) continue;
    const { job, source, request } = current;
    let incidentId: string | null = null;
    if (job.offeringId) {
      incidentId = await prisma.$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Course" WHERE id=${job.courseId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "CourseOffering" WHERE id=${job.offeringId} FOR UPDATE`);
        if (!await currentDiscoveryEngineeringFailure(tx, job.id, now) ||
            await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: job.targetKey } }) ||
            await hasLegacyDiscoveryOwner(tx, request.target)) return null;
        const existing = await tx.simulatorSupportIncident.findUnique({ where: { offeringId: job.offeringId! } });
        // Attach evidence to the existing episode without changing its reason,
        // final disposition or future retry. The normal reconciler may reopen
        // a resolved episode, but must not reset an unresolved one's cooldown.
        if (existing && existing.status !== "RESOLVED") return existing.status === "AUTO_INVESTIGATING" ? existing.id : null;
        await reconcileSimulatorSupportIncidentFailure(tx, { offeringId: job.offeringId!, reason: "DISCOVERY_CODE_REPAIR",
          evidenceUrl: source.identity.officialUrl, now, eligible: true });
        const incident = await tx.simulatorSupportIncident.findUnique({ where: { offeringId: job.offeringId! } });
        return incident?.status === "AUTO_INVESTIGATING" ? incident.id : null;
      });
    } else {
      const issue = await reportCourseSupportIssue({ course: source.course, searchId: request.demand.searchId,
        kind: "NEEDS_ADAPTER", message: "The public reader could not produce a verified reusable method; code diagnosis is required.",
        nextAction: "Use the discoveryEngineeringFailure packet to guide the current authorized stage. Repair reusable monitoring when implementation is authorized.",
        readPath: "DISCOVERY_CODE_REPAIR", now, failureObservedAt: job.completedAt!, episodeStartedAt: job.firstPickedUpAt!,
        onBeforeSourceWrite: async tx => { if (!await currentDiscoveryEngineeringFailure(tx, job.id, now) ||
          await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: job.targetKey } }) ||
          await hasLegacyDiscoveryOwner(tx, request.target)) throw new Error("Discovery engineering source or ownership changed."); } });
      incidentId = issue.status === "AUTO_INVESTIGATING" ? issue.incidentId : null;
    }
    if (!incidentId) continue;
    const linked = await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Course" WHERE id=${job.courseId} FOR UPDATE`);
      const fresh = await currentDiscoveryEngineeringFailure(tx, job.id, now);
      if (!fresh || discoveryEngineeringReceipt(fresh.job.result) ||
          await tx.courseDiscoveryJob.findUnique({ where: { activeTargetKey: job.targetKey } }) ||
          await hasLegacyDiscoveryOwner(tx, request.target)) return false;
      const incident = job.offeringId ? await tx.simulatorSupportIncident.findUnique({ where: { id: incidentId! } }) :
        await tx.courseSupportIncident.findUnique({ where: { id: incidentId! } });
      if (!incident || incident.status !== "AUTO_INVESTIGATING" ||
          (job.offeringId ? !("offeringId" in incident) || incident.offeringId !== job.offeringId : !("courseId" in incident) || incident.courseId !== job.courseId)) return false;
      // An empty investigation ledger is lifecycle state, not provider proof.
      // New learning incidents have no legacy playbook events; initialize the
      // valid empty shape before any owner captures its event-count fence.
      if (!job.offeringId && "attemptLedger" in incident && !await initializeEmptyInvestigation(tx, incident)) return false;
      const receipt = receiptSchema.parse({ version: 1, state: "QUEUED", incidentId, queuedAt: now.toISOString(), sourceFingerprint: job.sourceFingerprint });
      const result = { ...object(fresh.job.result), engineeringHandoff: receipt } as Prisma.InputJsonValue;
      const changed = await tx.courseDiscoveryJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: fresh.job.updatedAt,
        sourceFingerprint: job.sourceFingerprint }, data: { result } });
      return changed.count === 1;
    });
    if (linked) queued++;
  }
  return { examined: candidates.length, queued };
}
