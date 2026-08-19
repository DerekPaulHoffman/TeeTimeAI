import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  ShieldAlert,
  Wrench
} from "lucide-react";

import { hasClerkConfig } from "@/lib/env";
import { KNOWN_PROVIDER_FAMILIES } from "@/lib/automation/provider-capabilities";
import { getCurrentOperator } from "@/lib/operator/auth";
import { loadOperatorCourseMonitoringDetail } from "@/lib/operator/course-monitoring";
import { getProviderHandling } from "@/lib/operator/provider-handling";
import { getLocalReaderCourseKey } from "@/lib/local-reader/course-key";

import { CourseOutcomeForm, OfficialLinksForm } from "./operator-course-controls";
import { OperatorRecheckForm } from "./operator-recheck-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Course monitoring",
  description: "Private Tee Time Spot course monitoring history.",
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false
  }
};

export default async function OperatorCoursePage({
  params
}: {
  params: Promise<{ courseRef: string }>;
}) {
  if (!hasClerkConfig()) {
    notFound();
  }
  const clerkAuth = await auth();
  const { courseRef } = await params;
  if (!clerkAuth.userId) {
    return clerkAuth.redirectToSignIn({
      returnBackUrl: `/operator/courses/${encodeURIComponent(courseRef)}`
    });
  }
  if (!(await getCurrentOperator())) {
    notFound();
  }
  const detail = await loadOperatorCourseMonitoringDetail(courseRef);
  if (!detail) {
    notFound();
  }
  const stateLabel = getCourseStateLabel(detail);
  const isFinal = detail.state.startsWith("FINAL_");
  const isAuthoritativeFactualFinal =
    detail.state === "FINAL_MANUAL" || detail.state === "FINAL_IDENTITY";
  const recommendLocalReader =
    detail.course.providerFamilyKey === "EZLINKS" &&
    Boolean(getLocalReaderCourseKey(detail.course.detectedBookingUrl));

  return (
    <main className="operator-page operator-course-detail">
      <header className="operator-header">
        <div>
          <Link className="operator-back-link" href="/operator">
            <ArrowLeft size={15} />
            Site overview
          </Link>
          <p className="eyebrow operator-eyebrow">
            <ShieldAlert size={14} />
            Private course operations
          </p>
          <h1>{detail.course.name}</h1>
          <p className="operator-header-copy">
            Current monitoring state, bounded recovery work, operator decisions, and permanent
            redacted history.
          </p>
        </div>
        <span className="status-pill operator-status-neutral">{stateLabel}</span>
      </header>

      <section className="operator-section">
        <div className="operator-health-strip">
          <Fact
            label="Current state"
            value={stateLabel}
            detail={`Changed ${formatDateTime(detail.stateChangedAt)}`}
          />
          <Fact
            label="Last working"
            value={
              detail.lastSuccessfulAt
                ? formatDateTime(detail.lastSuccessfulAt)
                : "No surviving proof"
            }
            detail={`${detail.consecutiveFailures} consecutive failures`}
          />
          <Fact
            label="Escalation deadline"
            value={
              isFinal
                ? "Closed"
                : detail.incident?.escalationDeadlineAt
                ? formatDateTime(detail.incident.escalationDeadlineAt)
                : "None"
            }
            detail={
              isFinal
                ? "Final decision recorded"
                : detail.incident?.humanReviewReason
                ? formatEnum(detail.incident.humanReviewReason)
                : "Automation still owns the next step"
            }
          />
          <Fact
            label="Next safe attempt"
            value={
              detail.nextAutomaticAttemptAt
                ? formatDateTime(detail.nextAutomaticAttemptAt)
                : "Not scheduled"
            }
            detail={`${detail.activeRealAlerts} active real alerts`}
          />
          <Fact
            label="Pending delivery state"
            value={detail.pendingDeliveries}
            detail="Aggregate pending, sending, or retryable rows"
          />
        </div>
      </section>

      <section className="operator-section operator-course-detail-grid">
        <OfficialLinksForm
          bookingUrl={detail.course.detectedBookingUrl}
          idempotencyKey={`links:${randomUUID()}`}
          incidentCycle={detail.incident?.cycle ?? null}
          incidentRevision={detail.incident?.revision ?? null}
          monitoringPath={formatEnum(detail.course.monitoringMode)}
          platform={formatEnum(detail.course.detectedPlatform)}
          provider={detail.course.providerFamilyKey}
          providerHandling={getProviderHandling({
            providerFamilyKey: detail.course.providerFamilyKey,
            monitoringMode: detail.course.monitoringMode,
            automationEligibility: detail.course.automationEligibility,
            bookingMethod: detail.course.bookingMethod
          })}
          providerLabel={formatEnum(detail.course.providerFamilyKey)}
          providerOptions={[...KNOWN_PROVIDER_FAMILIES]}
          reference={detail.reference}
          statusRevision={detail.revision}
          website={detail.course.website}
        />

        <article className="operator-panel">
          <h2>
            <Wrench size={18} />
            Recovery checklist
          </h2>
          <ul className="operator-checklist">
            <ChecklistItem
              label="Identity and official links reviewed"
              complete={hasReadPath(detail.timeline, "OFFICIAL_LINK", "SIGNED_OUT_BROWSER")}
            />
            <ChecklistItem
              label="Typed provider access attempted"
              complete={hasReadPath(detail.timeline, "TYPED_PROVIDER", "ADAPTER")}
            />
            <ChecklistItem
              label="Signed-out browser surface inspected"
              complete={hasReadPath(detail.timeline, "SIGNED_OUT_BROWSER", "PUBLIC_PROVIDER")}
            />
            <ChecklistItem
              label="Local reader path attempted when eligible"
              complete={hasReadPath(detail.timeline, "LOCAL_READER")}
            />
            <ChecklistItem
              label="Fresh runtime proof recorded"
              complete={detail.timeline.some(
                (event) =>
                  Boolean(event.runtimeVersion) &&
                  (event.outcome === "MATCH_FOUND" || event.outcome === "NO_MATCH")
              )}
            />
          </ul>
          {detail.incident?.nextAction ? (
            <p className="operator-callout">
              <strong>Next action:</strong> {detail.incident.nextAction}
            </p>
          ) : null}
        </article>
      </section>

      <section className="operator-section">
        <div className="operator-action-grid">
          {isAuthoritativeFactualFinal ? (
            <article className="operator-action-card">
              <h2>New evidence required</h2>
              <p className="operator-form-help">
                A generic AI recheck cannot change this factual final. Update the official provider
                or links, or submit a new evidence-backed course outcome when stronger official
                evidence changes the classification.
              </p>
            </article>
          ) : (
            <OperatorRecheckForm
              idempotencyKey={`recheck:${randomUUID()}`}
              incidentCycle={detail.incident?.cycle ?? null}
              incidentRevision={detail.incident?.revision ?? null}
              reference={detail.reference}
              statusRevision={detail.revision}
            />
          )}

          {detail.incident ? (
            <CourseOutcomeForm
              idempotencyKey={`outcome:${randomUUID()}`}
              incidentCycle={detail.incident.cycle}
              incidentRevision={detail.incident.revision}
              recommendLocalReader={recommendLocalReader}
              reference={detail.reference}
              statusRevision={detail.revision}
            />
          ) : null}
        </div>
      </section>

      <section className="operator-section">
        <div className="operator-section-heading">
          <p className="eyebrow">Permanent redacted history</p>
          <h2>
            <History size={20} />
            Course timeline
          </h2>
          <p>
            No customer emails, recipient lists, search identifiers, credentials, or raw error
            payloads are stored here.
          </p>
        </div>
        <div className="operator-timeline">
          {detail.timeline.length > 0 ? (
            detail.timeline.map((event) => (
              <article className="operator-timeline-event" key={event.id}>
                <div className="operator-timeline-icon">
                  {event.outcome === "MATCH_FOUND" || event.outcome === "NO_MATCH" ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <Clock3 size={17} />
                  )}
                </div>
                <div>
                  <div className="operator-timeline-title">
                    <strong>{formatEnum(event.eventType)}</strong>
                    <time dateTime={event.occurredAt.toISOString()}>
                      {formatDateTime(event.occurredAt)}
                    </time>
                  </div>
                  <p>
                    {event.message ??
                      `${formatEnum(event.fromState)} to ${formatEnum(event.toState)}`}
                  </p>
                  <div className="operator-timeline-meta">
                    <span>{formatEnum(event.source)}</span>
                    {event.readPath ? <span>{formatEnum(event.readPath)}</span> : null}
                    {event.outcome ? <span>{formatEnum(event.outcome)}</span> : null}
                    {event.runtimeVersion ? <span>Runtime {event.runtimeVersion}</span> : null}
                    {event.deploymentSha ? (
                      <span>Release {event.deploymentSha.slice(0, 10)}</span>
                    ) : null}
                  </div>
                  {event.evidenceUrl ? (
                    <a href={event.evidenceUrl} rel="noreferrer" target="_blank">
                      View official evidence <ExternalLink size={13} />
                    </a>
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <p>No durable timeline events have been recorded yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function Fact({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <div className="operator-health-item">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ChecklistItem({ label, complete }: { label: string; complete: boolean }) {
  return (
    <li>
      {complete ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}
      <span>{label}</span>
    </li>
  );
}

function hasReadPath(
  timeline: Awaited<ReturnType<typeof loadOperatorCourseMonitoringDetail>> extends infer Detail
    ? Detail extends { timeline: infer Timeline }
      ? Timeline
      : never
    : never,
  ...needles: string[]
) {
  return (
    Array.isArray(timeline) &&
    timeline.some((event) => needles.some((needle) => event.readPath?.includes(needle)))
  );
}

function formatEnum(value: string | null | undefined) {
  if (!value) return "None";
  return value
    .replaceAll("_", " ")
    .toLocaleLowerCase("en-US")
    .replace(/(^|\s)\S/gu, (character) => character.toLocaleUpperCase());
}

function getCourseStateLabel(
  detail: NonNullable<Awaited<ReturnType<typeof loadOperatorCourseMonitoringDetail>>>
) {
  if (detail.course.automationReason === "TEMPORARILY_UNAVAILABLE") {
    return "Course website temporarily unavailable";
  }
  if (detail.course.monitoringMode === "LOCAL_READER_ONLY") {
    return "Local reader";
  }
  if (detail.state === "FINAL_IDENTITY" && detail.course.isPublic === false) {
    return "Private course";
  }
  if (detail.state === "FINAL_MANUAL") {
    return "Phone or manual booking";
  }
  if (detail.state === "FINAL_TECHNICAL") {
    if (detail.incident?.humanReviewReason === "ACCOUNT_REQUIRED") {
      return "Account required";
    }
    if (detail.incident?.humanReviewReason === "CAPTCHA_OR_QUEUE") {
      return "Captcha or waiting room";
    }
    return "Final technical limitation";
  }
  return formatEnum(detail.state);
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York"
  }).format(value);
}
