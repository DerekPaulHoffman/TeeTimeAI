import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  Link2,
  ShieldAlert,
  Wrench
} from "lucide-react";

import { hasClerkConfig } from "@/lib/env";
import { getCurrentOperator } from "@/lib/operator/auth";
import { loadOperatorCourseMonitoringDetail } from "@/lib/operator/course-monitoring";

import {
  approveTechnicalFinalAction,
  correctBookingLinkAction,
  reopenTechnicalFinalAction
} from "./actions";
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

  const hidden = (
    <>
      <input name="reference" type="hidden" value={detail.reference} />
      <input name="statusRevision" type="hidden" value={detail.revision} />
      <input name="incidentCycle" type="hidden" value={detail.incident?.cycle ?? ""} />
      <input name="incidentRevision" type="hidden" value={detail.incident?.revision ?? ""} />
    </>
  );

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
        <span className="status-pill operator-status-neutral">{formatEnum(detail.state)}</span>
      </header>

      <section className="operator-section">
        <div className="operator-health-strip">
          <Fact
            label="Current state"
            value={formatEnum(detail.state)}
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
              detail.incident?.escalationDeadlineAt
                ? formatDateTime(detail.incident.escalationDeadlineAt)
                : "None"
            }
            detail={
              detail.incident?.humanReviewReason
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
        <article className="operator-panel">
          <h2>
            <Link2 size={18} />
            Official surfaces
          </h2>
          <dl className="operator-detail-list">
            <Detail label="Provider" value={formatEnum(detail.course.providerFamilyKey)} />
            <Detail label="Platform" value={formatEnum(detail.course.detectedPlatform)} />
            <Detail label="Booking method" value={formatEnum(detail.course.bookingMethod)} />
            <Detail label="Access" value={formatEnum(detail.course.bookingAccessMode)} />
          </dl>
          <SafeLink label="Official course site" value={detail.course.website} />
          <SafeLink label="Official booking page" value={detail.course.detectedBookingUrl} />
        </article>

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
          <OperatorForm
            action={correctBookingLinkAction}
            icon={<Link2 size={17} />}
            title="Correct official booking link"
            submitLabel="Verify link and recheck"
          >
            {hidden}
            <input name="idempotencyKey" type="hidden" value={`link:${randomUUID()}`} />
            <label>
              HTTPS booking link
              <input
                defaultValue={detail.course.detectedBookingUrl ?? ""}
                name="bookingUrl"
                required
                type="url"
              />
            </label>
            <label>
              Official evidence
              <input name="evidenceUrl" required type="url" />
            </label>
            <label>
              Bounded note
              <textarea maxLength={500} name="note" required rows={3} />
            </label>
          </OperatorForm>

          <OperatorRecheckForm
            idempotencyKey={`recheck:${randomUUID()}`}
            incidentCycle={detail.incident?.cycle ?? null}
            incidentRevision={detail.incident?.revision ?? null}
            reference={detail.reference}
            statusRevision={detail.revision}
          />

          {detail.incident && detail.state !== "FINAL_TECHNICAL" ? (
            <OperatorForm
              action={approveTechnicalFinalAction}
              icon={<ShieldAlert size={17} />}
              title="Approve technical limitation"
              submitLabel="Record final decision"
            >
              {hidden}
              <input name="idempotencyKey" type="hidden" value={`final:${randomUUID()}`} />
              <label>
                Precise reason
                <select name="reason" required>
                  <option value="CAPTCHA_OR_QUEUE">Captcha or queue</option>
                  <option value="ACCOUNT_REQUIRED">Account required</option>
                  <option value="SOURCE_UNVERIFIED">Source unverified</option>
                  <option value="READER_RELOAD_REQUIRED">Reader reload or install required</option>
                  <option value="OFFICIAL_LINK_VERIFICATION_FAILED">
                    Official link verification failed
                  </option>
                  <option value="OTHER_TECHNICAL_LIMITATION">Other technical limitation</option>
                </select>
              </label>
              <label>
                Official evidence
                <input name="evidenceUrl" required type="url" />
              </label>
              <label>
                Decision note
                <textarea maxLength={500} name="note" required rows={3} />
              </label>
            </OperatorForm>
          ) : null}

          {detail.state === "FINAL_TECHNICAL" ? (
            <OperatorForm
              action={reopenTechnicalFinalAction}
              icon={<Activity size={17} />}
              title="Reopen engineer decision"
              submitLabel="Reopen investigation"
            >
              {hidden}
              <input name="idempotencyKey" type="hidden" value={`reopen:${randomUUID()}`} />
              <label>
                New official evidence
                <input name="evidenceUrl" required type="url" />
              </label>
              <label>
                Why the evidence changed
                <textarea maxLength={500} name="note" required rows={3} />
              </label>
            </OperatorForm>
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SafeLink({ label, value }: { label: string; value: string | null }) {
  return value ? (
    <a href={value} rel="noreferrer" target="_blank">
      {label} <ExternalLink size={13} />
    </a>
  ) : (
    <p>{label}: not verified</p>
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

function OperatorForm({
  action,
  children,
  icon,
  title,
  submitLabel
}: {
  action: (formData: FormData) => Promise<void>;
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
  submitLabel: string;
}) {
  return (
    <form action={action} className="operator-action-card">
      <h2>
        {icon}
        {title}
      </h2>
      {children}
      <button type="submit">{submitLabel}</button>
    </form>
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

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York"
  }).format(value);
}
