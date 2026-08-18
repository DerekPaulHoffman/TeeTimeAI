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
  | "RECOVERY_REQUIRED"
  | "SCHEDULED_RETRY"
  | "ENGINEERING_NEEDED"
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
  activeSyntheticAlertCount: number;
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
    resolution?: string | null;
    kind: string;
    activeRealSearchCount: number;
    engineeringOnly?: boolean;
    firstSeenAt: Date;
    latestMessage: string | null;
    nextAction: string | null;
    failureClass: string | null;
    nextAttemptAt?: Date | null;
    activeBatchId?: string | null;
    activeBatch?: {
      status: string;
      leaseExpiresAt: Date;
    } | null;
    attemptCount?: number;
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
  problemSummary: string | null;
};

const STALE_WITH_DEMAND_MS = 24 * 60 * 60 * 1000;

export function buildCourseInventory(
  courses: CourseStatusInput[],
  now = new Date()
): CourseInventoryItem[] {
  return courses
    .map((course) => {
      const classified = classifyCourseStatus(course, now);
      const automationQueueState = deriveAutomationQueueState(classified, now);
      return applyAutomationQueueCopy(classified, automationQueueState);
    })
    .sort(
      (left, right) =>
        getActiveIssuePriority(left) - getActiveIssuePriority(right) ||
        left.priorityScore - right.priorityScore ||
        right.activeAlertCount - left.activeAlertCount ||
        left.name.localeCompare(right.name)
    );
}

function getActiveIssuePriority(course: CourseInventoryItem) {
  const actionable = course.priorityGroup === "ACTION" || course.priorityGroup === "WATCH";
  if (actionable && course.activeAlertCount > 0) return 0;
  if (actionable && course.activeSyntheticAlertCount > 0) return 1;
  return 2;
}

function hasActivePriorityAlert(course: CourseStatusInput) {
  return course.activeAlertCount > 0 || course.activeSyntheticAlertCount > 0;
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
    recoveryRequired: courses.filter(
      (course) => course.automationQueueState === "RECOVERY_REQUIRED"
    ).length,
    scheduledRetry: courses.filter((course) => course.automationQueueState === "SCHEDULED_RETRY")
      .length,
    engineeringNeeded: courses.filter(
      (course) => course.automationQueueState === "ENGINEERING_NEEDED"
    ).length,
    needsHuman: courses.filter((course) => course.automationQueueState === "NEEDS_HUMAN").length
  };
}

export function getCourseSummaryCopy(counts: {
  action: number;
  watch: number;
  limitations: number;
  unchecked: number;
  working: number;
}) {
  const totalCount =
    counts.action + counts.watch + counts.limitations + counts.unchecked + counts.working;
  const attentionCount = counts.action + counts.watch;

  return {
    lifecycle:
      `${totalCount} courses appear once by current state. ` +
      "Known limitations are finished decisions, not active failures.",
    execution:
      `The same ${attentionCount} attention ${attentionCount === 1 ? "course appears" : "courses appear"} ` +
      "again here exactly once under automation or a person. These are not additional issues."
  };
}

export function summarizeCourseDiagnostics(courses: CourseInventoryItem[]) {
  const groups = [
    { key: "ACTION", label: "Needs attention" },
    { key: "WATCH", label: "Investigation backlog" },
    { key: "LIMITATION", label: "Known limitations" },
    { key: "UNCHECKED", label: "Verify when needed" },
    { key: "WORKING", label: "Monitoring works" }
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
  if (course.incident?.status === "NEEDS_HUMAN") {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: "ACTION",
      priorityScore: 0,
      tone: "critical",
      labelOverride: "Engineering verification needed",
      meaningOverride:
        "AI finished its bounded checks but still needs you to confirm the course works or provide more course information.",
      actionOverride:
        "Open the redacted course history, check the official course surface again, then confirm the result or add the missing details and request another AI recheck."
    });
  }
  if (course.incident?.status === "AUTO_INVESTIGATING") {
    if (course.automationReason === "TEMPORARILY_UNAVAILABLE") {
      return withStatus(course, "SITE_FAILED", {
        priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
        priorityScore: hasActivePriorityAlert(course) ? 0 : 1,
        tone: hasActivePriorityAlert(course) ? "critical" : "warning",
        labelOverride: "Course website temporarily unavailable",
        meaningOverride:
          "An operator confirmed that the course website is not working correctly, so Tee Time Spot cannot currently view its tee times.",
        actionOverride:
          "A future check is scheduled. Golfers keep their active alerts and will be emailed when tee-time checks resume."
      });
    }
    const operatorRecheckQueued =
      course.monitoringStatus?.revalidationRequestedAt !== null &&
      course.monitoringStatus?.revalidationRequestedAt !== undefined;
    return withStatus(course, statusKeyForFailure(course.incident.kind, course.bookingAccessMode), {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 1,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning",
      labelOverride: operatorRecheckQueued ? "AI recheck requested" : "Auto investigating",
      meaningOverride: operatorRecheckQueued
        ? "Your note is saved and waiting for AI to run a fresh course verification."
        : "Repeated evidence confirmed a monitoring issue and the bounded automated recovery playbook is active.",
      actionOverride: operatorRecheckQueued
        ? "No action is needed yet. Wait for AI to finish; this course will move to Engineering verification needed only if you must confirm the result or provide more information."
        : (course.incident.nextAction ??
          "Automation owns safe provider, browser, metadata, reader, adapter, and fresh-runtime verification until the deadline.")
    });
  }
  if (
    course.incident?.status === "RESOLVED" &&
    isStaleInvestigationState(course.monitoringStatus?.state)
  ) {
    if (course.incident.resolution === "MONITORING_RESTORED") {
      return withStatus(course, "MONITORING_RESTORED", {
        priorityGroup: "WORKING",
        priorityScore: 5,
        tone: "positive"
      });
    }
    if (course.incident.resolution === "IDENTITY_CLASSIFIED") {
      return withStatus(course, "PRIVATE_OR_INVALID", {
        priorityGroup: "LIMITATION",
        priorityScore: 3,
        tone: "neutral",
        labelOverride: "Private course",
        meaningOverride:
          "An operator confirmed this is a private course, so public tee-time monitoring is closed.",
        actionOverride: "No further monitoring work is scheduled."
      });
    }
    if (course.incident.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION") {
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
    if (
      course.incident.resolution === "DIRECT_BOOKING_CLASSIFIED" ||
      course.incident.resolution === "SOURCE_UNVERIFIED"
    ) {
      return withStatus(course, "DIRECT_SITE_ONLY", {
        priorityGroup: "LIMITATION",
        priorityScore: 3,
        tone: "neutral",
        labelOverride: "Known direct-booking limitation",
        meaningOverride:
          "The investigation reached a final direct-course or source-unavailable outcome; no automated repair is still running.",
        actionOverride:
          "Keep the official course details available to golfers and re-check only when stronger public booking evidence appears."
      });
    }
  }

  if (course.monitoringStatus?.state === "FINAL_IDENTITY") {
    return withStatus(course, "PRIVATE_OR_INVALID", {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      labelOverride: "Private or invalid course record",
      meaningOverride:
        "Current exact identity evidence shows that this is private, not a playable public course, or no longer a valid course record.",
      actionOverride: "No further monitoring work is scheduled."
    });
  }

  if (course.monitoringStatus?.state === "FINAL_MANUAL") {
    return withStatus(course, "DIRECT_SITE_ONLY", {
      priorityGroup: "LIMITATION",
      priorityScore: 3,
      tone: "neutral",
      diagnosticKeyOverride: "NO_PUBLIC_ONLINE",
      labelOverride: "Phone or manual booking",
      meaningOverride:
        "An operator confirmed that tee times require a phone call, account, or another manual course process.",
      actionOverride:
        "No automated investigation is running. Keep the official course details available to golfers and re-check only when stronger public booking evidence appears."
    });
  }

  const latestSuccessfulEvidence = getLatestSuccessfulEvidence(course);
  if (
    latestSuccessfulEvidence &&
    (course.monitoringStatus?.state === "HEALTHY" ||
      isRecoverableMonitoringState(course.monitoringStatus?.state)) &&
    (!course.monitoringStatus?.lastFailureAt ||
      latestSuccessfulEvidence.observedAt > course.monitoringStatus.lastFailureAt)
  ) {
    if (
      hasActivePriorityAlert(course) &&
      now.getTime() - latestSuccessfulEvidence.observedAt.getTime() > STALE_WITH_DEMAND_MS
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
    if (course.automationReason === "TEMPORARILY_UNAVAILABLE") {
      return withStatus(course, "SITE_FAILED", {
        priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
        priorityScore: hasActivePriorityAlert(course) ? 0 : 1,
        tone: hasActivePriorityAlert(course) ? "critical" : "warning",
        labelOverride: "Course website temporarily unavailable",
        meaningOverride:
          "An operator confirmed that the course website is not working correctly, so Tee Time Spot cannot currently view its tee times.",
        actionOverride:
          "A future check is scheduled. Golfers keep their active alerts and will be emailed when tee-time checks resume."
      });
    }
    return withStatus(course, "SITE_FAILED", {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 1,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning",
      labelOverride: "Degraded · retrying",
      meaningOverride:
        "One public read failed. The previous working state is preserved while an independent retry runs.",
      actionOverride:
        "Wait for the fresh-session retry and independent verification before confirming an incident."
    });
  }
  if (course.monitoringStatus?.state === "AUTO_INVESTIGATING") {
    const operatorRecheckQueued = course.monitoringStatus.revalidationRequestedAt !== null;
    return withStatus(course, "NEEDS_ADAPTER", {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 1,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning",
      labelOverride: operatorRecheckQueued ? "AI recheck requested" : "Auto investigating",
      meaningOverride: operatorRecheckQueued
        ? "Your note is saved and waiting for AI to run a fresh course verification."
        : "Repeated evidence confirmed a monitoring issue and the bounded automated recovery playbook is active.",
      actionOverride: operatorRecheckQueued
        ? "No action is needed yet. Wait for AI to finish; this course will move to Engineering verification needed only if you must confirm the result or provide more information."
        : (course.incident?.nextAction ??
          "Automation owns safe provider, browser, metadata, reader, adapter, and fresh-runtime verification until the deadline.")
    });
  }
  if (course.monitoringStatus?.state === "ENGINEERING_VERIFICATION_NEEDED") {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: "ACTION",
      priorityScore: 0,
      tone: "critical",
      labelOverride: "Engineering verification needed",
      meaningOverride:
        "AI finished its bounded checks but still needs you to confirm the course works or provide more course information.",
      actionOverride:
        course.incident?.nextAction ??
        "Open the redacted course history, check the official course surface again, then confirm the result or add the missing details and request another AI recheck."
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
        openIncident.activeRealSearchCount > 0 || hasActivePriorityAlert(course)
          ? "ACTION"
          : "WATCH",
      priorityScore:
        openIncident.activeRealSearchCount > 0 || hasActivePriorityAlert(course) ? 0 : 1,
      tone:
        openIncident.activeRealSearchCount > 0 || hasActivePriorityAlert(course)
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
      hasActivePriorityAlert(course) &&
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
              priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "UNCHECKED",
              priorityScore: hasActivePriorityAlert(course) ? 1 : 4,
              tone: hasActivePriorityAlert(course) ? "critical" : "neutral"
            }
      );
    }
    if (course.localReaderCandidate) {
      return withStatus(course, "READER_CANDIDATE", {
        priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
        priorityScore: hasActivePriorityAlert(course) ? 1 : 2,
        tone: hasActivePriorityAlert(course) ? "critical" : "warning"
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
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 2,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning"
    });
  }

  if (course.coverageCategory === "SOURCE_UNVERIFIED") {
    return withStatus(course, "SOURCE_MISSING", {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 2,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning"
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
        hasActivePriorityAlert(course) &&
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
        : hasActivePriorityAlert(course)
          ? "ACTION"
          : "WATCH",
      priorityScore: isKnownLimitation ? 3 : hasActivePriorityAlert(course) ? 1 : 2,
      tone: isKnownLimitation ? "neutral" : hasActivePriorityAlert(course) ? "critical" : "warning"
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
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 2,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning"
    });
  }

  if (
    course.bookingAccessMode === "CAPTCHA_OR_QUEUE" ||
    course.automationReason === "CAPTCHA_OR_QUEUE"
  ) {
    return withStatus(course, "CAPTCHA_OR_QUEUE", {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "LIMITATION",
      priorityScore: hasActivePriorityAlert(course) ? 1 : 3,
      tone: hasActivePriorityAlert(course) ? "critical" : "neutral"
    });
  }

  if (
    course.bookingAccessMode === "ACCOUNT_REQUIRED" ||
    course.bookingAccessMode === "ACCOUNT_SELF_SERVICE" ||
    course.bookingAccessMode === "ACCOUNT_STAFF_PROVISIONED" ||
    course.automationReason === "ACCOUNT_REQUIRED"
  ) {
    return withStatus(course, "ACCOUNT_REQUIRED", {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "LIMITATION",
      priorityScore: hasActivePriorityAlert(course) ? 1 : 3,
      tone: hasActivePriorityAlert(course) ? "critical" : "neutral"
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
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 0 : 2,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning"
    });
  }

  if (
    course.automationReason === "AUTOMATION_PROHIBITED" ||
    course.automationEligibility === "NEEDS_REVIEW" ||
    course.automationEligibility === "BLOCKED"
  ) {
    return withStatus(course, "REVIEW_REQUIRED", {
      priorityGroup: hasActivePriorityAlert(course) ? "ACTION" : "WATCH",
      priorityScore: hasActivePriorityAlert(course) ? 1 : 2,
      tone: hasActivePriorityAlert(course) ? "critical" : "warning"
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
  const statusMeaning = options.meaningOverride ?? guide.meaning;
  return {
    ...course,
    statusKey,
    statusLabel: options.labelOverride ?? guide.label,
    statusMeaning,
    recommendedAction: options.actionOverride ?? guide.action,
    diagnosticKey: options.diagnosticKeyOverride ?? statusKey,
    priorityGroup: options.priorityGroup,
    priorityScore: options.priorityScore,
    tone: options.tone,
    problemSummary: summarizeCourseProblem(course, statusMeaning)
  };
}

function summarizeCourseProblem(course: CourseStatusInput, fallback: string) {
  const message = (course.incident?.latestMessage ?? course.latestProbe?.message ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  const failureClass = course.incident?.failureClass;

  if (/verification window ended without enough independent observations/iu.test(message)) {
    return "The verification run did not collect enough independent checks to confirm whether monitoring works.";
  }
  if (/HTTP 403/iu.test(message)) {
    return "The official booking page returned HTTP 403, and no verified public tee-time feed was found.";
  }
  if (/no public booking surface is currently available/iu.test(message)) {
    return "No verified public read-only tee-time source has been found for this booking provider.";
  }
  if (failureClass === "CHALLENGE") {
    return "The public booking page is behind a CAPTCHA or waiting-room challenge, so monitoring cannot read it safely.";
  }
  if (failureClass === "AUTH") {
    return "The booking page requires an account or authenticated session, so signed-out monitoring cannot read it.";
  }
  if (failureClass === "READER_PARSER_MISSING") {
    return "The local reader can reach this booking page but does not yet understand its tee-time results.";
  }
  if (failureClass === "UNSUPPORTED_FAMILY") {
    return "No verified public read-only tee-time path exists yet for this booking provider.";
  }
  if (failureClass === "MISSING_SOURCE") {
    return "No trustworthy official booking source has been recorded for this course.";
  }
  if (failureClass === "NOT_FOUND") {
    return "The recorded booking page could not be found and needs a corrected official link.";
  }
  if (failureClass === "HTTP_5XX") {
    return "The monitoring or verification path returned a server error before it could confirm a course result.";
  }
  if (message) {
    return message.length > 240 ? `${message.slice(0, 237)}...` : message;
  }
  return fallback;
}

function getLatestSuccessfulEvidence(course: CourseStatusInput) {
  const candidates: Array<{
    observedAt: Date;
    statusKey: CourseStatusKey;
  }> = [];
  if (course.latestProbe?.outcome === "MATCH_FOUND" || course.latestProbe?.outcome === "NO_MATCH") {
    candidates.push({
      observedAt: course.latestProbe.observedAt,
      statusKey: course.latestProbe.outcome === "MATCH_FOUND" ? "WORKING_MATCH" : "WORKING_NO_MATCH"
    });
  }
  if (course.localReaderVerifiedAt) {
    candidates.push({
      observedAt: course.localReaderVerifiedAt,
      statusKey: "LOCAL_READER_VERIFIED"
    });
  }
  if (course.monitoringStatus?.lastSuccessfulAt) {
    candidates.push({
      observedAt: course.monitoringStatus.lastSuccessfulAt,
      statusKey: "MONITORING_RESTORED"
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

function isStaleInvestigationState(state: string | undefined) {
  return (
    state === "DEGRADED_RETRYING" ||
    state === "AUTO_INVESTIGATING" ||
    state === "ENGINEERING_VERIFICATION_NEEDED"
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
    course.incident?.status === "NEEDS_HUMAN" &&
    course.incident.failureClass === "READER_PARSER_MISSING" &&
    !course.localReaderSupported
  ) {
    return "ENGINEERING_NEEDED";
  }
  if (
    course.incident?.status === "NEEDS_HUMAN" ||
    course.monitoringStatus?.state === "ENGINEERING_VERIFICATION_NEEDED"
  ) {
    return "NEEDS_HUMAN";
  }
  if (course.incident?.activeBatchId) {
    const batch = course.incident.activeBatch;
    return batch &&
      ["CLAIMED", "IMPLEMENTING", "VERIFYING"].includes(batch.status) &&
      batch.leaseExpiresAt > now
      ? "IN_PROGRESS"
      : "RECOVERY_REQUIRED";
  }
  if (
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
      course.incident?.nextAttemptAt ?? course.monitoringStatus?.nextAutomaticAttemptAt ?? null;
    return nextAttemptAt && nextAttemptAt > now ? "SCHEDULED_RETRY" : "DUE_NOW";
  }
  return course.priorityGroup === "ACTION" || course.priorityGroup === "WATCH"
    ? "NEEDS_HUMAN"
    : null;
}

function applyAutomationQueueCopy(
  course: Omit<CourseInventoryItem, "automationQueueState">,
  automationQueueState: CourseAutomationQueueState | null
): CourseInventoryItem {
  const operatorRecheckRequested =
    course.monitoringStatus?.revalidationRequestedAt !== null &&
    course.monitoringStatus?.revalidationRequestedAt !== undefined &&
    (course.incident?.status === "AUTO_INVESTIGATING" ||
      course.monitoringStatus?.state === "AUTO_INVESTIGATING");

  if (!operatorRecheckRequested) {
    return { ...course, automationQueueState };
  }

  if (automationQueueState === "IN_PROGRESS") {
    return {
      ...course,
      automationQueueState,
      statusLabel: "AI recheck running",
      statusMeaning: "AI currently owns this course in an active bounded verification batch.",
      recommendedAction:
        "No action is needed while the active verification finishes and records its durable result."
    };
  }
  if (automationQueueState === "DUE_NOW") {
    return {
      ...course,
      automationQueueState,
      statusLabel: "Waiting for AI capacity",
      statusMeaning:
        "Your note is saved and this course is eligible for a fresh verification, but no worker owns it yet.",
      recommendedAction:
        "No action is needed yet. AI will claim it when a verification slot opens."
    };
  }
  if (automationQueueState === "SCHEDULED_RETRY") {
    return {
      ...course,
      automationQueueState,
      statusLabel: "AI retry scheduled",
      statusMeaning:
        "AI completed a bounded attempt and scheduled another safe retry; it is not checking this course right now.",
      recommendedAction: "No action is needed until the scheduled retry becomes due."
    };
  }
  if (automationQueueState === "RECOVERY_REQUIRED") {
    return {
      ...course,
      automationQueueState,
      statusLabel: "AI recheck needs recovery",
      statusMeaning:
        "The prior verification owner expired before closeout, so the batch must be safely recovered before checking continues.",
      recommendedAction: "Wait for the responder to recover the fenced batch."
    };
  }

  return { ...course, automationQueueState };
}
