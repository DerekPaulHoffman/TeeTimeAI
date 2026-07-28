import type { ProviderCoverageCategory } from "@/lib/automation/provider-coverage";

export const COURSE_STATUS_GUIDE = [
  {
    key: "SITE_FAILED",
    label: "Site or check failed",
    meaning: "The newest check could not read the expected public availability data.",
    action:
      "Open the exact booking page and evidence, confirm the course identity, then repair the link, metadata, or provider reader."
  },
  {
    key: "NEEDS_ADAPTER",
    label: "Needs adapter",
    meaning:
      "The course has an online booking source, but Tee Time Spot does not yet have reusable support for its provider shape.",
    action: "Build or repair provider-family support and verify it against this exact course."
  },
  {
    key: "CAPTCHA_OR_QUEUE",
    label: "Captcha or queue",
    meaning:
      "The exact signed-out course surface currently presents a technical challenge or waiting room.",
    action:
      "Re-check the public course surface without bypassing the control; keep the official link and classify the current limitation accurately."
  },
  {
    key: "ACCOUNT_REQUIRED",
    label: "Account required",
    meaning: "Availability is not currently readable from a public signed-out course surface.",
    action:
      "Confirm the exact course flow. Keep it as a direct-booking limitation unless a public read-only source exists."
  },
  {
    key: "DIRECT_SITE_ONLY",
    label: "Direct booking only",
    meaning:
      "The course currently uses a manual or direct booking path rather than a public tee sheet Tee Time Spot can monitor.",
    action:
      "Keep the official booking details available to golfers and re-check only when the course publishes a monitorable surface."
  },
  {
    key: "PRIVATE_OR_INVALID",
    label: "Private or invalid identity",
    meaning:
      "Current evidence identifies the record as private, non-course, closed, or otherwise not a valid public monitoring target.",
    action:
      "No adapter work is needed. Reopen identity review only when stronger current evidence appears."
  },
  {
    key: "SOURCE_MISSING",
    label: "Source missing",
    meaning:
      "The course record does not have a usable official booking source or provider identity.",
    action: "Find and save the exact official course and booking links, then run a fresh check."
  },
  {
    key: "TOOLING_BLOCKED",
    label: "Tooling blocked",
    meaning:
      "The monitor could not run because its runtime, browser, metadata, or parser contract failed.",
    action: "Repair the monitoring tool or course metadata, then verify with a fresh runtime."
  },
  {
    key: "REVIEW_REQUIRED",
    label: "Review required",
    meaning:
      "The stored course facts are incomplete, conflicting, or based on an old non-technical policy result.",
    action: "Inspect the current signed-out public surface and correct the durable course facts."
  },
  {
    key: "STALE",
    label: "Stale",
    meaning:
      "A course with active real demand has not produced a successful check in the last 24 hours.",
    action:
      "Inspect the search scheduler and the exact booking surface, then run a fresh production-equivalent check."
  },
  {
    key: "NOT_CHECKED",
    label: "Not checked",
    meaning: "The course is configured or known, but there is no real-customer probe yet.",
    action:
      "Verify it when demand arrives, or run a bounded engineering check when the course is a current priority."
  },
  {
    key: "LOCAL_READER_READY",
    label: "Local reader ready",
    meaning:
      "The installed Chrome reader supports this exact public booking page, but no recent reader result is available.",
    action:
      "Keep the Local Reader enabled and run a detached verification or wait for an active alert to request a read."
  },
  {
    key: "LOCAL_READER_VERIFIED",
    label: "Working · local reader verified",
    meaning:
      "A recent signed local-reader result successfully read this exact public booking page without customer email or checkout activity.",
    action: "No course repair is needed while the reader remains enabled."
  },
  {
    key: "READER_CANDIDATE",
    label: "Reader candidate",
    meaning:
      "The exact public page rendered in Chrome, but it does not yet have a production reader parser and allowlist contract.",
    action:
      "Add a focused fail-closed parser only after the exact date, player, course identity, and empty-result states are verified."
  },
  {
    key: "MONITORING_RESTORED",
    label: "Working · monitoring restored",
    meaning: "Fresh production evidence confirms that Tee Time Spot can read this course again.",
    action: "No course repair is needed."
  },
  {
    key: "WORKING_MATCH",
    label: "Working · match found",
    meaning: "The newest check successfully read availability and found a matching tee time.",
    action: "No course repair is needed."
  },
  {
    key: "WORKING_NO_MATCH",
    label: "Working · no match",
    meaning:
      "The newest check successfully read the course, but no tee time matched that golfer’s request.",
    action: "No course repair is needed."
  }
] as const;

export type CourseStatusKey = (typeof COURSE_STATUS_GUIDE)[number]["key"];
export type CoursePriorityGroup = "ACTION" | "WATCH" | "LIMITATION" | "UNCHECKED" | "WORKING";
export type CourseInventoryView =
  "all" | "attention" | "fix-now" | "investigate" | "limitations" | "unchecked" | "working";
export type CourseDiagnosticKey =
  CourseStatusKey | "TECHNICAL_ACCESS" | "NO_PUBLIC_ONLINE" | "PRIVATE_OR_INVALID";
export type CourseStatusTone = "critical" | "warning" | "neutral" | "positive";
export type CourseAutomationQueueState =
  | "DUE_NOW"
  | "IN_PROGRESS"
  | "SCHEDULED_RETRY"
  | "NEEDS_HUMAN";

export type CourseStatusInput = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  stateCode: string | null;
  providerFamilyKey: string;
  automationEligibility: string;
  automationReason: string;
  bookingAccessMode: string;
  bookingMethod: string;
  detectedBookingUrl: string | null;
  website: string | null;
  localReaderSupported: boolean;
  localReaderCandidate: boolean;
  localReaderVerifiedAt: Date | null;
  localReaderVersion: string | null;
  activeAlertCount: number;
  selectionCount: number;
  monitoringStatus?: {
    reference: string;
    state: string;
    lastSuccessfulAt: Date | null;
    lastFailureAt: Date | null;
    nextAutomaticAttemptAt: Date | null;
    revalidationRequestedAt: Date | null;
  } | null;
  incident: {
    id: string;
    status: string;
    kind: string;
    activeRealSearchCount: number;
    firstSeenAt: Date;
    latestMessage: string | null;
    nextAction: string | null;
    failureClass: string | null;
    nextAttemptAt?: Date | null;
    activeBatchId?: string | null;
  } | null;
  latestProbe: {
    outcome: string;
    observedAt: Date;
    message: string | null;
    evidenceUrl: string | null;
  } | null;
  profileSlug: string | null;
  coverageCategory: ProviderCoverageCategory;
};

export type CourseInventoryItem = CourseStatusInput & {
  statusKey: CourseStatusKey;
  statusLabel: string;
  statusMeaning: string;
  recommendedAction: string;
  diagnosticKey: CourseDiagnosticKey;
  priorityGroup: CoursePriorityGroup;
  priorityScore: number;
  tone: CourseStatusTone;
  automationQueueState: CourseAutomationQueueState | null;
};

const STALE_WITH_DEMAND_MS = 24 * 60 * 60 * 1000;

export function buildCourseInventory(
  courses: CourseStatusInput[],
  now = new Date()
): CourseInventoryItem[] {
  return courses
    .map((course) => {
      const classified = classifyCourseStatus(course, now);
      return {
        ...classified,
        automationQueueState: deriveAutomationQueueState(classified, now)
      };
    })
    .sort(
      (left, right) =>
        left.priorityScore - right.priorityScore ||
        right.activeAlertCount - left.activeAlertCount ||
        left.name.localeCompare(right.name)
    );
}

export function filterCourseInventory(
  courses: CourseInventoryItem[],
  input: {
    diagnostic?: string;
    query?: string;
    state?: string;
    view?: string;
  }
) {
  const diagnostic = parseCourseDiagnosticFilter(input.diagnostic);
  const query = input.query?.trim().toLocaleLowerCase("en-US") ?? "";
  const state = parseCourseStateFilter(input.state);
  const view = parseCourseInventoryView(input.view);

  return courses.filter((course) => {
    const matchesView =
      view === "all" ||
      (view === "attention" &&
        (course.priorityGroup === "ACTION" || course.priorityGroup === "WATCH")) ||
      (view === "fix-now" && course.priorityGroup === "ACTION") ||
      (view === "investigate" && course.priorityGroup === "WATCH") ||
      (view === "limitations" && course.priorityGroup === "LIMITATION") ||
      (view === "unchecked" && course.priorityGroup === "UNCHECKED") ||
      (view === "working" && course.priorityGroup === "WORKING");
    if (!matchesView) return false;

    if (state !== "all" && course.stateCode !== state) return false;
    if (diagnostic !== "all" && course.diagnosticKey !== diagnostic) {
      return false;
    }

    if (!query) return true;
    return [
      course.name,
      course.address,
      course.city,
      course.stateCode,
      course.providerFamilyKey,
      course.statusLabel,
      course.statusMeaning,
      course.recommendedAction
    ].some((value) => value?.toLocaleLowerCase("en-US").includes(query));
  });
}

export function summarizeCourseInventory(courses: CourseInventoryItem[]) {
  return {
    action: courses.filter((course) => course.priorityGroup === "ACTION").length,
    watch: courses.filter((course) => course.priorityGroup === "WATCH").length,
    limitations: courses.filter((course) => course.priorityGroup === "LIMITATION").length,
    unchecked: courses.filter((course) => course.priorityGroup === "UNCHECKED").length,
    working: courses.filter((course) => course.priorityGroup === "WORKING").length,
    dueNow: courses.filter((course) => course.automationQueueState === "DUE_NOW").length,
    inProgress: courses.filter((course) => course.automationQueueState === "IN_PROGRESS").length,
    scheduledRetry: courses.filter(
      (course) => course.automationQueueState === "SCHEDULED_RETRY"
    ).length,
    needsHuman: courses.filter(
      (course) => course.automationQueueState === "NEEDS_HUMAN"
    ).length
  };
}

export function getCourseSummaryCopy(counts: { action: number; watch: number }) {
  const actionableCount = counts.action + counts.watch;

  return {
    lifecycle:
      "Every course appears once, based on its latest monitoring outcome.",
    execution:
      `The same ${actionableCount} Fix now and Investigate courses are regrouped here by next owner. ` +
      "If automation reaches its safety limit, an Auto investigating course appears under Needs human."
  };
}

export function summarizeCourseDiagnostics(courses: CourseInventoryItem[]) {
  const groups = [
    { key: "ACTION", label: "Fix now" },
    { key: "WATCH", label: "Investigate" },
    { key: "LIMITATION", label: "Known limitations" },
    { key: "UNCHECKED", label: "Not checked" },
    { key: "WORKING", label: "Working" }
  ] as const;

  return groups.map((group) => {
    const matchingCourses = courses.filter((course) => course.priorityGroup === group.key);
    const subcategoryCounts = new Map<CourseDiagnosticKey, { count: number; label: string }>();
    for (const course of matchingCourses) {
      const current = subcategoryCounts.get(course.diagnosticKey);
      subcategoryCounts.set(course.diagnosticKey, {
        count: (current?.count ?? 0) + 1,
        label: current?.label ?? course.statusLabel
      });
    }

    return {
      ...group,
      count: matchingCourses.length,
      subcategories: [...subcategoryCounts.entries()]
        .map(([key, value]) => ({ key, ...value }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    };
  });
}

export function listCourseStates(courses: CourseInventoryItem[]) {
  const counts = new Map<string, number>();
  for (const course of courses) {
    if (!course.stateCode) continue;
    counts.set(course.stateCode, (counts.get(course.stateCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([stateCode, count]) => ({ stateCode, count }))
    .sort((left, right) => left.stateCode.localeCompare(right.stateCode));
}

export function parseCourseInventoryView(value: string | undefined): CourseInventoryView {
  if (
    value === "attention" ||
    value === "fix-now" ||
    value === "investigate" ||
    value === "limitations" ||
    value === "unchecked" ||
    value === "working"
  ) {
    return value;
  }
  return "all";
}

export function parseCourseDiagnosticFilter(
  value: string | undefined
): CourseDiagnosticKey | "all" {
  const normalized = value?.trim().toLocaleUpperCase("en-US");
  const keys = new Set<CourseDiagnosticKey>([
    ...COURSE_STATUS_GUIDE.map((status) => status.key),
    "TECHNICAL_ACCESS",
    "NO_PUBLIC_ONLINE",
    "PRIVATE_OR_INVALID"
  ]);
  return normalized && keys.has(normalized as CourseDiagnosticKey)
    ? (normalized as CourseDiagnosticKey)
    : "all";
}

export function parseCourseStateFilter(value: string | undefined) {
  const normalized = value?.trim().toLocaleUpperCase("en-US") ?? "";
  return /^[A-Z]{2}$/u.test(normalized) ? normalized : "all";
}

function classifyCourseStatus(
  course: CourseStatusInput,
  now: Date
): Omit<CourseInventoryItem, "automationQueueState"> {
  const latestSuccessfulEvidence = getLatestSuccessfulEvidence(course);
  if (
    latestSuccessfulEvidence &&
    (course.monitoringStatus?.state === "HEALTHY" ||
      isRecoverableMonitoringState(course.monitoringStatus?.state)) &&
    (!course.monitoringStatus?.lastFailureAt ||
      latestSuccessfulEvidence.observedAt > course.monitoringStatus.lastFailureAt)
  ) {
    if (
      course.activeAlertCount > 0 &&
      now.getTime() - latestSuccessfulEvidence.observedAt.getTime() >
        STALE_WITH_DEMAND_MS
    ) {
      return withStatus(course, "STALE", {
        priorityGroup: "ACTION",
        priorityScore: 1,
        tone: "critical"
      });
    }
    return withStatus(course, latestSuccessfulEvidence.statusKey, {
      priorityGroup: "WORKING",
      priorityScore: 5,
      tone: "positive"
    });
  }

  if (course.monitoringStatus?.state === "DEGRADED_RETRYING") {
    return withStatus(course, "SITE_FAILED", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 0 : 1,
      tone: course.activeAlertCount > 0 ? "critical" : "warning",
      labelOverride: "Degraded · retrying",
      meaningOverride:
        "One public read failed. The previous working state is preserved while an independent retry runs.",
      actionOverride:
        "Wait for the fresh-session retry and independent verification before confirming an incident."
    });
  }
  if (course.monitoringStatus?.state === "AUTO_INVESTIGATING") {
    return withStatus(course, "NEEDS_ADAPTER", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 0 : 1,
      tone: course.activeAlertCount > 0 ? "critical" : "warning",
      labelOverride: "Auto investigating",
      meaningOverride:
        "Repeated evidence confirmed a monitoring issue and the bounded automated recovery playbook is active.",
      actionOverride:
        "Automation owns safe provider, browser, metadata, reader, adapter, and fresh-runtime verification until the deadline."
    });
  }
  if (course.monitoringStatus?.state === "ENGINEERING_VERIFICATION_NEEDED") {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: "ACTION",
      priorityScore: 0,
      tone: "critical",
      labelOverride: "Engineering verification needed",
      meaningOverride:
        "Safe automated recovery did not produce conclusive runnable proof or an engineer-approved final limitation.",
      actionOverride:
        "Open the redacted course history, inspect the official surface, and record an evidence-backed decision."
    });
  }
  if (course.monitoringStatus?.state === "REVALIDATING_FINAL") {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: "WATCH",
      priorityScore: 1,
      tone: "warning",
      labelOverride: "Revalidating prior final",
      meaningOverride:
        "New real demand triggered one safe revalidation while the prior engineer decision remains visible.",
      actionOverride:
        "Allow the immediate revalidation to restore monitoring, reconfirm the same limitation, or reopen changed evidence."
    });
  }
  if (course.monitoringStatus?.state === "FINAL_TECHNICAL") {
    const statusKey =
      course.bookingAccessMode === "CAPTCHA_OR_QUEUE" ? "CAPTCHA_OR_QUEUE" : "ACCOUNT_REQUIRED";
    return withStatus(course, statusKey, {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      labelOverride: "Engineer-verified limitation",
      meaningOverride:
        "An engineer reviewed current official evidence and approved this precise technical limitation.",
      actionOverride:
        "No timer-based polling is scheduled. New real demand will trigger one safe revalidation."
    });
  }

  const openIncident =
    course.incident && course.incident.status !== "RESOLVED" ? course.incident : null;
  if (openIncident) {
    const statusKey = statusKeyForFailure(openIncident.kind, course.bookingAccessMode);
    return withStatus(course, statusKey, {
      priorityGroup:
        openIncident.activeRealSearchCount > 0 || course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: openIncident.activeRealSearchCount > 0 || course.activeAlertCount > 0 ? 0 : 1,
      tone:
        openIncident.activeRealSearchCount > 0 || course.activeAlertCount > 0
          ? "critical"
          : "warning",
      actionOverride: openIncident.nextAction
    });
  }

  if (course.coverageCategory === "MONITORED") {
    const latestSuccessfulProbe =
      course.latestProbe &&
      (course.latestProbe.outcome === "MATCH_FOUND" || course.latestProbe.outcome === "NO_MATCH")
        ? course.latestProbe
        : null;
    if (
      latestSuccessfulProbe &&
      course.activeAlertCount > 0 &&
      now.getTime() - latestSuccessfulProbe.observedAt.getTime() > STALE_WITH_DEMAND_MS
    ) {
      return withStatus(course, "STALE", {
        priorityGroup: "ACTION",
        priorityScore: 1,
        tone: "critical"
      });
    }
    return withStatus(
      course,
      latestSuccessfulProbe?.outcome === "MATCH_FOUND"
        ? "WORKING_MATCH"
        : latestSuccessfulProbe?.outcome === "NO_MATCH"
          ? "WORKING_NO_MATCH"
          : "MONITORING_RESTORED",
      {
        priorityGroup: "WORKING",
        priorityScore: 5,
        tone: "positive"
      }
    );
  }

  if (course.coverageCategory === "TECHNICAL_CONSTRAINT") {
    if (course.localReaderSupported) {
      return withStatus(
        course,
        course.localReaderVerifiedAt ? "LOCAL_READER_VERIFIED" : "LOCAL_READER_READY",
        course.localReaderVerifiedAt
          ? {
              priorityGroup: "WORKING",
              priorityScore: 5,
              tone: "positive"
            }
          : {
              priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "UNCHECKED",
              priorityScore: course.activeAlertCount > 0 ? 1 : 4,
              tone: course.activeAlertCount > 0 ? "critical" : "neutral"
            }
      );
    }
    if (course.localReaderCandidate) {
      return withStatus(course, "READER_CANDIDATE", {
        priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
        priorityScore: course.activeAlertCount > 0 ? 1 : 2,
        tone: course.activeAlertCount > 0 ? "critical" : "warning"
      });
    }
    const statusKey =
      course.bookingAccessMode === "CAPTCHA_OR_QUEUE" ? "CAPTCHA_OR_QUEUE" : "ACCOUNT_REQUIRED";
    return withStatus(course, statusKey, {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      diagnosticKeyOverride: statusKey === "ACCOUNT_REQUIRED" ? "TECHNICAL_ACCESS" : undefined,
      labelOverride: statusKey === "ACCOUNT_REQUIRED" ? "Technical access limitation" : undefined
    });
  }

  if (course.coverageCategory === "PHONE_OR_WALK_IN") {
    return withStatus(course, "ACCOUNT_REQUIRED", {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      diagnosticKeyOverride: "NO_PUBLIC_ONLINE",
      labelOverride: "No public online tee sheet",
      meaningOverride:
        "Current official evidence points to phone, walk-in, contact-only, or another non-public booking path.",
      actionOverride:
        "Keep the official course link and re-check only if a public online tee sheet becomes available."
    });
  }

  if (course.coverageCategory === "PRIVATE_OR_INVALID") {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      diagnosticKeyOverride: "PRIVATE_OR_INVALID",
      labelOverride: "Private or invalid course record",
      meaningOverride:
        "Current exact identity evidence shows that this is private, not a playable public course, or no longer a valid course record.",
      actionOverride:
        "No monitoring work is needed unless new official identity evidence changes this classification."
    });
  }

  if (course.coverageCategory === "UNSUPPORTED_FAMILY") {
    return withStatus(course, "NEEDS_ADAPTER", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 0 : 2,
      tone: course.activeAlertCount > 0 ? "critical" : "warning"
    });
  }

  if (course.coverageCategory === "SOURCE_UNVERIFIED") {
    return withStatus(course, "SOURCE_MISSING", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 0 : 2,
      tone: course.activeAlertCount > 0 ? "critical" : "warning"
    });
  }

  if (course.coverageCategory === "SUPPORTED_READY") {
    return withStatus(course, "NOT_CHECKED", {
      priorityGroup: "UNCHECKED",
      priorityScore: 4,
      tone: "neutral"
    });
  }

  if (course.latestProbe) {
    if (course.latestProbe.outcome === "MATCH_FOUND" || course.latestProbe.outcome === "NO_MATCH") {
      if (
        course.activeAlertCount > 0 &&
        now.getTime() - course.latestProbe.observedAt.getTime() > STALE_WITH_DEMAND_MS
      ) {
        return withStatus(course, "STALE", {
          priorityGroup: "ACTION",
          priorityScore: 1,
          tone: "critical"
        });
      }
      return withStatus(
        course,
        course.latestProbe.outcome === "MATCH_FOUND" ? "WORKING_MATCH" : "WORKING_NO_MATCH",
        {
          priorityGroup: "WORKING",
          priorityScore: 5,
          tone: "positive"
        }
      );
    }

    const statusKey = statusKeyForFailure(course.latestProbe.outcome, course.bookingAccessMode);
    const isKnownLimitation =
      (statusKey === "CAPTCHA_OR_QUEUE" || statusKey === "ACCOUNT_REQUIRED") &&
      course.activeAlertCount === 0;
    return withStatus(course, statusKey, {
      priorityGroup: isKnownLimitation
        ? "LIMITATION"
        : course.activeAlertCount > 0
          ? "ACTION"
          : "WATCH",
      priorityScore: isKnownLimitation ? 3 : course.activeAlertCount > 0 ? 1 : 2,
      tone: isKnownLimitation ? "neutral" : course.activeAlertCount > 0 ? "critical" : "warning"
    });
  }

  if (
    course.providerFamilyKey === "SOURCE_MISSING" ||
    (!course.detectedBookingUrl &&
      course.bookingMethod !== "PHONE_ONLY" &&
      course.bookingMethod !== "CONTACT_COURSE" &&
      course.bookingMethod !== "WALK_IN")
  ) {
    return withStatus(course, "SOURCE_MISSING", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 0 : 2,
      tone: course.activeAlertCount > 0 ? "critical" : "warning"
    });
  }

  if (
    course.bookingAccessMode === "CAPTCHA_OR_QUEUE" ||
    course.automationReason === "CAPTCHA_OR_QUEUE"
  ) {
    return withStatus(course, "CAPTCHA_OR_QUEUE", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "LIMITATION",
      priorityScore: course.activeAlertCount > 0 ? 1 : 3,
      tone: course.activeAlertCount > 0 ? "critical" : "neutral"
    });
  }

  if (
    course.bookingAccessMode === "ACCOUNT_REQUIRED" ||
    course.bookingAccessMode === "ACCOUNT_SELF_SERVICE" ||
    course.bookingAccessMode === "ACCOUNT_STAFF_PROVISIONED" ||
    course.automationReason === "ACCOUNT_REQUIRED"
  ) {
    return withStatus(course, "ACCOUNT_REQUIRED", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "LIMITATION",
      priorityScore: course.activeAlertCount > 0 ? 1 : 3,
      tone: course.activeAlertCount > 0 ? "critical" : "neutral"
    });
  }

  if (
    course.bookingMethod === "PHONE_ONLY" ||
    course.bookingMethod === "CONTACT_COURSE" ||
    course.bookingMethod === "WALK_IN" ||
    course.automationReason === "NO_ONLINE_BOOKING"
  ) {
    return withStatus(course, "ACCOUNT_REQUIRED", {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      diagnosticKeyOverride: "NO_PUBLIC_ONLINE",
      labelOverride: "No public online tee sheet",
      meaningOverride:
        "The saved course facts currently point to phone, walk-in, contact-only, or another non-public booking path.",
      actionOverride:
        "Keep the official course link and re-check only if a public online tee sheet becomes available."
    });
  }

  if (course.automationReason === "UNSUPPORTED_PLATFORM") {
    return withStatus(course, "NEEDS_ADAPTER", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 0 : 2,
      tone: course.activeAlertCount > 0 ? "critical" : "warning"
    });
  }

  if (
    course.automationReason === "AUTOMATION_PROHIBITED" ||
    course.automationEligibility === "NEEDS_REVIEW" ||
    course.automationEligibility === "BLOCKED"
  ) {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: course.activeAlertCount > 0 ? "ACTION" : "WATCH",
      priorityScore: course.activeAlertCount > 0 ? 1 : 2,
      tone: course.activeAlertCount > 0 ? "critical" : "warning"
    });
  }

  if (course.automationEligibility === "ALLOWED" || course.automationEligibility === "UNKNOWN") {
    return withStatus(course, "NOT_CHECKED", {
      priorityGroup: "UNCHECKED",
      priorityScore: 4,
      tone: "neutral"
    });
  }

  return withStatus(course, "REVIEW_REQUIRED", {
    priorityGroup: "WATCH",
    priorityScore: 2,
    tone: "warning"
  });
}

function statusKeyForFailure(value: string, bookingAccessMode: string): CourseStatusKey {
  if (value === "NEEDS_ADAPTER") return "NEEDS_ADAPTER";
  if (value === "FETCH_FAILED") return "SITE_FAILED";
  if (value === "BLOCKED_TOOLING") return "TOOLING_BLOCKED";
  if (value === "BLOCKED_AUTH" && bookingAccessMode === "CAPTCHA_OR_QUEUE") {
    return "CAPTCHA_OR_QUEUE";
  }
  if (value === "BLOCKED_AUTH") return "ACCOUNT_REQUIRED";
  if (value === "MANUAL_DIRECT") return "DIRECT_SITE_ONLY";
  if (value === "IDENTITY_FINAL") return "PRIVATE_OR_INVALID";
  if (value === "IDENTITY_RECHECK") return "REVIEW_REQUIRED";
  if (value === "BLOCKED_POLICY") return "REVIEW_REQUIRED";
  return "REVIEW_REQUIRED";
}

function withStatus(
  course: CourseStatusInput,
  statusKey: CourseStatusKey,
  options: {
    priorityGroup: CoursePriorityGroup;
    priorityScore: number;
    tone: CourseStatusTone;
    diagnosticKeyOverride?: CourseDiagnosticKey;
    labelOverride?: string;
    meaningOverride?: string;
    actionOverride?: string | null;
  }
): Omit<CourseInventoryItem, "automationQueueState"> {
  const guide = COURSE_STATUS_GUIDE.find((item) => item.key === statusKey);
  if (!guide) {
    throw new Error(`Missing operator course status guide for ${statusKey}`);
  }
  return {
    ...course,
    statusKey,
    statusLabel: options.labelOverride ?? guide.label,
    statusMeaning: options.meaningOverride ?? guide.meaning,
    recommendedAction: options.actionOverride ?? guide.action,
    diagnosticKey: options.diagnosticKeyOverride ?? statusKey,
    priorityGroup: options.priorityGroup,
    priorityScore: options.priorityScore,
    tone: options.tone
  };
}

function getLatestSuccessfulEvidence(course: CourseStatusInput) {
  const candidates: Array<{
    observedAt: Date;
    statusKey: CourseStatusKey;
  }> = [];
  if (
    course.latestProbe?.outcome === "MATCH_FOUND" ||
    course.latestProbe?.outcome === "NO_MATCH"
  ) {
    candidates.push({
      observedAt: course.latestProbe.observedAt,
      statusKey:
        course.latestProbe.outcome === "MATCH_FOUND"
          ? "WORKING_MATCH"
          : "WORKING_NO_MATCH"
    });
  }
  if (course.localReaderVerifiedAt) {
    candidates.push({
      observedAt: course.localReaderVerifiedAt,
      statusKey: "LOCAL_READER_VERIFIED"
    });
  }
  return candidates.sort(
    (left, right) => right.observedAt.getTime() - left.observedAt.getTime()
  )[0];
}

function isRecoverableMonitoringState(state: string | undefined) {
  return (
    state === "DEGRADED_RETRYING" ||
    state === "AUTO_INVESTIGATING" ||
    state === "ENGINEERING_VERIFICATION_NEEDED" ||
    state === "REVALIDATING_FINAL"
  );
}

function deriveAutomationQueueState(
  course: Omit<CourseInventoryItem, "automationQueueState">,
  now: Date
): CourseAutomationQueueState | null {
  if (
    course.priorityGroup === "WORKING" ||
    course.priorityGroup === "LIMITATION" ||
    course.priorityGroup === "UNCHECKED"
  ) {
    return null;
  }
  if (
    course.incident?.status === "NEEDS_HUMAN" ||
    course.monitoringStatus?.state === "ENGINEERING_VERIFICATION_NEEDED"
  ) {
    return "NEEDS_HUMAN";
  }
  if (
    course.incident?.activeBatchId ||
    course.monitoringStatus?.state === "DEGRADED_RETRYING" ||
    course.monitoringStatus?.state === "REVALIDATING_FINAL"
  ) {
    return "IN_PROGRESS";
  }
  if (
    course.incident?.status === "AUTO_INVESTIGATING" ||
    course.monitoringStatus?.state === "AUTO_INVESTIGATING"
  ) {
    const nextAttemptAt =
      course.incident?.nextAttemptAt ??
      course.monitoringStatus?.nextAutomaticAttemptAt ??
      null;
    return nextAttemptAt && nextAttemptAt > now
      ? "SCHEDULED_RETRY"
      : "DUE_NOW";
  }
  return course.priorityGroup === "ACTION" ? "NEEDS_HUMAN" : null;
}
