import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  Eye,
  Flag,
  Gauge,
  MailCheck,
  MessageSquareWarning,
  Search,
  UserPlus,
  Users
} from "lucide-react";

import {
  ResolveFeedbackControl,
  RetryIncidentControl
} from "@/components/operator-action-controls";
import { getCurrentOperator } from "@/lib/operator/auth";
import {
  loadOperatorOverview,
  type OperatorOverview
} from "@/lib/operator/overview";
import { parseOperatorRange } from "@/lib/operator/time";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Site overview",
  description: "Private Tee Time Spot site and monitoring overview.",
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false
  }
};

type OperatorPageProps = {
  searchParams: Promise<{
    range?: string;
  }>;
};

export default async function OperatorPage({
  searchParams
}: OperatorPageProps) {
  const operator = await getCurrentOperator();
  if (!operator) {
    notFound();
  }

  const params = await searchParams;
  const days = parseOperatorRange(params.range);
  const overview = await loadOperatorOverview({ days });

  return <OperatorDashboard overview={overview} />;
}

function OperatorDashboard({ overview }: { overview: OperatorOverview }) {
  const maximumPageViews = Math.max(
    ...overview.dailyActivity.map((day) => day.pageViews),
    1
  );

  return (
    <main className="operator-page">
      <header className="operator-header">
        <div>
          <p className="eyebrow operator-eyebrow">
            <Gauge size={14} />
            Private operator view
          </p>
          <h1>Site overview</h1>
          <p className="operator-header-copy">
            Demand, customer activity, delivery health, and course coverage in
            one daily view.
          </p>
        </div>
        <div className="operator-header-tools">
          <RangeTabs days={overview.range.days} />
          <span className="operator-freshness">
            Updated {formatDateTime(overview.generatedAt)}
          </span>
        </div>
      </header>

      <section aria-labelledby="today-heading" className="operator-section">
        <SectionHeading
          eyebrow="Today in Eastern Time"
          id="today-heading"
          title="What changed today"
        />
        <div className="operator-metric-grid">
          <Metric
            icon={<UserPlus size={18} />}
            label="New users"
            value={overview.today.newUsers}
          />
          <Metric
            icon={<BellRing size={18} />}
            label="Alerts created"
            value={overview.today.newAlerts}
          />
          <Metric
            icon={<Activity size={18} />}
            label="Active alerts"
            value={overview.today.activeAlerts}
          />
          <Metric
            icon={<Eye size={18} />}
            label="Page views"
            value={overview.today.pageViews}
          />
          <Metric
            icon={<Flag size={18} />}
            label="Matches found"
            value={overview.today.matchesFound}
          />
          <Metric
            icon={<MailCheck size={18} />}
            label="Match emails accepted"
            value={overview.today.matchEmailsSent}
          />
          <Metric
            tone={overview.today.openIssues > 0 ? "warning" : "positive"}
            icon={<AlertTriangle size={18} />}
            label="Open course issues"
            value={overview.today.openIssues}
          />
          <Metric
            tone={overview.today.brokenFeedback > 0 ? "warning" : "positive"}
            icon={<MessageSquareWarning size={18} />}
            label="Broken feedback"
            value={overview.today.brokenFeedback}
          />
        </div>
      </section>

      <section
        aria-labelledby="attention-heading"
        className="operator-section operator-attention"
      >
        <SectionHeading
          eyebrow="Priority queue"
          id="attention-heading"
          title="Needs attention"
          supporting="Real customer demand comes first, followed by scheduler, delivery, and feedback problems."
        />
        <div className="operator-attention-summary">
          <AttentionCount
            count={overview.attention.realDemandIncidents}
            label="real-demand course issues"
          />
          <AttentionCount
            count={overview.attention.problemSearches.length}
            label="failed or overdue searches"
          />
          <AttentionCount
            count={overview.attention.problemDeliveries.length}
            label="delivery problems"
          />
          <AttentionCount
            count={overview.attention.brokenFeedback.length}
            label="broken reports"
          />
        </div>
        <div className="operator-attention-lists">
          <AttentionSearches searches={overview.attention.problemSearches} />
          <AttentionDeliveries
            deliveries={overview.attention.problemDeliveries}
          />
        </div>
      </section>

      <section aria-labelledby="activity-heading" className="operator-section">
        <SectionHeading
          eyebrow={`${overview.range.days}-day view`}
          id="activity-heading"
          title="Activity and conversion"
          supporting="Anonymous browsing is reported as event counts. Named users appear only after a persisted account exists."
        />
        <div className="operator-activity-layout">
          <div className="operator-trend" aria-label="Daily activity trend">
            {overview.dailyActivity.map((day) => (
              <div className="operator-trend-row" key={day.key}>
                <time dateTime={day.key}>{formatShortDay(day.key)}</time>
                <div className="operator-trend-track">
                  <span
                    className="operator-trend-bar"
                    style={{
                      width: `${Math.max(
                        (day.pageViews / maximumPageViews) * 100,
                        day.pageViews > 0 ? 4 : 0
                      )}%`
                    }}
                  />
                </div>
                <span>{day.pageViews} views</span>
                <strong>{day.savedAlerts} saved</strong>
              </div>
            ))}
          </div>
          <dl className="operator-funnel">
            <FunnelStep label="Page views" value={overview.funnel.pageViews} />
            <FunnelStep
              label="Search starts"
              value={overview.funnel.searchStarts}
            />
            <FunnelStep
              label="Discoveries completed"
              value={overview.funnel.discoveries}
            />
            <FunnelStep
              label="Course selections"
              value={overview.funnel.selections}
            />
            <FunnelStep
              label="Sign-in clicks"
              value={overview.funnel.signInClicks}
            />
            <FunnelStep
              label="Submit attempts"
              value={overview.funnel.submissions}
            />
            <FunnelStep
              label="Persisted alerts"
              value={overview.funnel.savedAlerts}
              emphasized
            />
          </dl>
        </div>
        {overview.funnel.submissionFailures > 0 ? (
          <p className="operator-inline-warning">
            <AlertTriangle size={14} />
            {overview.funnel.submissionFailures} failed submission{" "}
            {overview.funnel.submissionFailures === 1 ? "event" : "events"} in
            this range.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="courses-heading" className="operator-section">
        <SectionHeading
          eyebrow="Saved demand"
          id="courses-heading"
          title="Most searched courses"
          supporting="Ranks real saved-course selections and excludes test and automation traffic."
        />
        {overview.topCourses.length > 0 ? (
          <div className="operator-table-wrap">
            <table className="operator-table">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Selections</th>
                  <th>Owners</th>
                  <th>Active alerts</th>
                  <th>Nearest date</th>
                  <th>Monitoring</th>
                </tr>
              </thead>
              <tbody>
                {overview.topCourses.map((course, index) => (
                  <tr key={course.id}>
                    <td data-label="Course">
                      <span className="operator-rank">{index + 1}</span>
                      <span>
                        <strong>{course.name}</strong>
                        <small>{formatProvider(course.providerFamilyKey)}</small>
                      </span>
                    </td>
                    <td data-label="Selections">{course.selectionCount}</td>
                    <td data-label="Owners">{course.ownerCount}</td>
                    <td data-label="Active alerts">{course.activeAlertCount}</td>
                    <td data-label="Nearest date">
                      {course.nearestRequestedDate
                        ? formatDate(course.nearestRequestedDate, true)
                        : "—"}
                    </td>
                    <td data-label="Monitoring">
                      <MonitoringStatus course={course} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No real saved-course demand in this range.</EmptyState>
        )}
      </section>

      <section aria-labelledby="incidents-heading" className="operator-section">
        <SectionHeading
          eyebrow="Course coverage"
          id="incidents-heading"
          title="Open incidents"
          supporting="Ordered by active real demand, nearest requested date, and oldest unresolved evidence."
        />
        {overview.incidents.length > 0 ? (
          <div className="operator-incident-list">
            {overview.incidents.map((incident) => (
              <article className="operator-incident-row" key={incident.id}>
                <div className="operator-incident-main">
                  <div className="operator-incident-title">
                    <span
                      className={`status-pill ${
                        incident.activeRealSearchCount > 0
                          ? "operator-status-urgent"
                          : "operator-status-neutral"
                      }`}
                    >
                      {incident.activeRealSearchCount > 0
                        ? `${incident.activeRealSearchCount} active`
                        : incident.engineeringOnly
                          ? "Engineering"
                          : "No active demand"}
                    </span>
                    <h3>{incident.course.name}</h3>
                  </div>
                  <dl className="operator-incident-facts">
                    <div>
                      <dt>Issue</dt>
                      <dd>{formatEnum(incident.kind)}</dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>{formatProvider(incident.providerFamilyKey)}</dd>
                    </div>
                    <div>
                      <dt>Attempts</dt>
                      <dd>{incident.attemptCount}</dd>
                    </div>
                    <div>
                      <dt>Nearest date</dt>
                      <dd>
                        {incident.earliestTargetDate
                          ? formatDate(incident.earliestTargetDate, true)
                          : "None"}
                      </dd>
                    </div>
                    <div>
                      <dt>First seen</dt>
                      <dd>{formatRelativeAge(incident.firstSeenAt)}</dd>
                    </div>
                  </dl>
                  {(incident.latestMessage || incident.nextAction) && (
                    <details className="operator-details">
                      <summary>Evidence and next action</summary>
                      {incident.latestMessage ? (
                        <p>{incident.latestMessage}</p>
                      ) : null}
                      {incident.nextAction ? (
                        <p>
                          <strong>Next:</strong> {incident.nextAction}
                        </p>
                      ) : null}
                    </details>
                  )}
                </div>
                <div className="operator-incident-action">
                  <IncidentQueueState
                    generatedAt={overview.generatedAt}
                    incident={incident}
                  />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState>No open course-support incidents.</EmptyState>
        )}
      </section>

      <section aria-labelledby="health-heading" className="operator-section">
        <SectionHeading
          eyebrow="Last 24 hours"
          id="health-heading"
          title="Monitoring and delivery health"
        />
        <div className="operator-health-strip">
          <HealthItem
            label="Probe success"
            value={
              overview.health.successRate === null
                ? "No checks"
                : `${overview.health.successRate}%`
            }
            detail={`${overview.health.successfulProbes} successful of ${overview.health.totalProbes}`}
          />
          <HealthItem
            label="Failed checks"
            value={overview.health.problemSearchCount}
            detail="Active searches failed or overdue"
            warning={overview.health.problemSearchCount > 0}
          />
          <HealthItem
            label="Delivery problems"
            value={overview.health.problemDeliveryCount}
            detail="Failed or retry-due email records"
            warning={overview.health.problemDeliveryCount > 0}
          />
          <HealthItem
            label="Unresolved feedback"
            value={overview.health.unresolvedFeedbackCount}
            detail="Public, non-synthetic reports"
            warning={overview.health.unresolvedFeedbackCount > 0}
          />
        </div>
      </section>

      <section aria-labelledby="users-heading" className="operator-section">
        <SectionHeading
          eyebrow="Registered accounts"
          id="users-heading"
          title="Recent users"
          supporting="This is account and saved-alert activity, not anonymous visitor identity or a last-visited timestamp."
        />
        {overview.recentUsers.length > 0 ? (
          <div className="operator-table-wrap">
            <table className="operator-table operator-user-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Joined</th>
                  <th>Total alerts</th>
                  <th>Active</th>
                  <th>Latest alert</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentUsers.map((user) => (
                  <tr key={user.id}>
                    <td data-label="Email">
                      <details className="operator-user-details">
                        <summary>{user.email}</summary>
                        <p>
                          {user.courseNames.length > 0
                            ? user.courseNames.join(", ")
                            : "No saved courses"}
                        </p>
                      </details>
                    </td>
                    <td data-label="Joined">{formatDate(user.createdAt)}</td>
                    <td data-label="Total alerts">{user.totalAlerts}</td>
                    <td data-label="Active">{user.activeAlerts}</td>
                    <td data-label="Latest alert">
                      {user.latestAlertAt
                        ? formatDateTime(user.latestAlertAt)
                        : "No alert yet"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No registered users yet.</EmptyState>
        )}
      </section>

      <section aria-labelledby="feedback-heading" className="operator-section">
        <SectionHeading
          eyebrow="Product feedback"
          id="feedback-heading"
          title="Unresolved feedback"
        />
        {overview.unresolvedFeedback.length > 0 ? (
          <div className="operator-feedback-list">
            {overview.unresolvedFeedback.map((feedback) => (
              <article className="operator-feedback-row" key={feedback.id}>
                <div>
                  <span
                    className={`status-pill operator-feedback-${feedback.sentiment.toLowerCase()}`}
                  >
                    {formatEnum(feedback.sentiment)}
                  </span>
                  <strong>{feedback.page || "Unknown page"}</strong>
                  <small>{formatDateTime(feedback.createdAt)}</small>
                  {feedback.contactEmail ? (
                    <a href={`mailto:${feedback.contactEmail}`}>
                      {feedback.contactEmail}
                    </a>
                  ) : null}
                  {feedback.message ? (
                    <details className="operator-details">
                      <summary>Read feedback</summary>
                      <p>{feedback.message}</p>
                    </details>
                  ) : null}
                </div>
                <ResolveFeedbackControl feedbackId={feedback.id} />
              </article>
            ))}
          </div>
        ) : (
          <EmptyState>No unresolved feedback.</EmptyState>
        )}
      </section>
    </main>
  );
}

function RangeTabs({ days }: { days: 7 | 30 }) {
  return (
    <nav aria-label="Overview time range" className="operator-range-tabs">
      <Link
        aria-current={days === 7 ? "page" : undefined}
        className={days === 7 ? "is-active" : undefined}
        href="/operator?range=7d"
      >
        7 days
      </Link>
      <Link
        aria-current={days === 30 ? "page" : undefined}
        className={days === 30 ? "is-active" : undefined}
        href="/operator?range=30d"
      >
        30 days
      </Link>
    </nav>
  );
}

function SectionHeading({
  eyebrow,
  id,
  title,
  supporting
}: {
  eyebrow: string;
  id: string;
  title: string;
  supporting?: string;
}) {
  return (
    <div className="operator-section-heading">
      <div>
        <p>{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      {supporting ? <span>{supporting}</span> : null}
    </div>
  );
}

function Metric({
  icon,
  label,
  tone = "default",
  value
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "warning" | "positive";
  value: number;
}) {
  return (
    <div className={`operator-metric is-${tone}`}>
      <span>{icon}</span>
      <div>
        <strong>{value.toLocaleString()}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

function AttentionCount({ count, label }: { count: number; label: string }) {
  return (
    <div className={count > 0 ? "has-issues" : "is-clear"}>
      {count > 0 ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
      <strong>{count}</strong>
      <span>{label}</span>
    </div>
  );
}

function AttentionSearches({
  searches
}: {
  searches: OperatorOverview["attention"]["problemSearches"];
}) {
  return (
    <details className="operator-attention-group" open={searches.length > 0}>
      <summary>
        <Search size={16} />
        Search scheduler
        <span>{searches.length}</span>
      </summary>
      {searches.length > 0 ? (
        <div>
          {searches.map((search) => (
            <p key={search.id}>
              <strong>{search.user.email}</strong>
              <span>
                {search.checkStatus} ·{" "}
                {search.preferences
                  .map((preference) => preference.course.name)
                  .join(", ")}
              </span>
              <small>
                Next check{" "}
                {search.nextCheckAt
                  ? formatDateTime(search.nextCheckAt)
                  : "not scheduled"}
              </small>
            </p>
          ))}
        </div>
      ) : (
        <p className="operator-clear-copy">No failed or overdue real searches.</p>
      )}
    </details>
  );
}

function AttentionDeliveries({
  deliveries
}: {
  deliveries: OperatorOverview["attention"]["problemDeliveries"];
}) {
  return (
    <details className="operator-attention-group" open={deliveries.length > 0}>
      <summary>
        <MailCheck size={16} />
        Email delivery
        <span>{deliveries.length}</span>
      </summary>
      {deliveries.length > 0 ? (
        <div>
          {deliveries.map((delivery) => (
            <p key={delivery.id}>
              <strong>{delivery.teeSearch.user.email}</strong>
              <span>
                {delivery.kind} · {delivery.status} · attempt{" "}
                {delivery.attemptCount}
              </span>
              <small>
                {delivery.nextAttemptAt
                  ? `Retry ${formatDateTime(delivery.nextAttemptAt)}`
                  : delivery.lastError || "Retry not scheduled"}
              </small>
            </p>
          ))}
        </div>
      ) : (
        <p className="operator-clear-copy">No failed or retry-due deliveries.</p>
      )}
    </details>
  );
}

function FunnelStep({
  emphasized,
  label,
  value
}: {
  emphasized?: boolean;
  label: string;
  value: number;
}) {
  return (
    <div className={emphasized ? "is-emphasized" : undefined}>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}

function MonitoringStatus({
  course
}: {
  course: OperatorOverview["topCourses"][number];
}) {
  if (course.incident && course.incident.status !== "RESOLVED") {
    return (
      <span className="operator-monitoring-status is-warning">
        <AlertTriangle size={13} />
        {formatEnum(course.incident.kind)}
      </span>
    );
  }
  if (course.latestProbe) {
    const successful =
      course.latestProbe.outcome === "MATCH_FOUND" ||
      course.latestProbe.outcome === "NO_MATCH";
    return (
      <span
        className={`operator-monitoring-status ${
          successful ? "is-positive" : "is-warning"
        }`}
      >
        {successful ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
        {formatEnum(course.latestProbe.outcome)}
      </span>
    );
  }
  return <span className="operator-monitoring-status">No probe yet</span>;
}

function IncidentQueueState({
  generatedAt,
  incident
}: {
  generatedAt: Date;
  incident: OperatorOverview["incidents"][number];
}) {
  if (incident.activeBatchId) {
    return (
      <span className="operator-queue-label is-active">
        <Activity size={14} />
        In progress
        {incident.activeBatch?.reference ? (
          <small>{incident.activeBatch.reference}</small>
        ) : null}
      </span>
    );
  }
  if (incident.status === "NEEDS_HUMAN") {
    return (
      <span className="operator-queue-label is-warning">
        <Users size={14} />
        Manual review needed
      </span>
    );
  }
  if (
    !incident.nextAttemptAt ||
    incident.nextAttemptAt.getTime() <= generatedAt.getTime()
  ) {
    return (
      <span className="operator-queue-label">
        <Clock3 size={14} />
        Queued
      </span>
    );
  }
  return (
    <>
      <span className="operator-queue-label">
        <Clock3 size={14} />
        {formatDateTime(incident.nextAttemptAt)}
      </span>
      <RetryIncidentControl incidentId={incident.id} />
    </>
  );
}

function HealthItem({
  detail,
  label,
  value,
  warning
}: {
  detail: string;
  label: string;
  value: number | string;
  warning?: boolean;
}) {
  return (
    <div className={warning ? "is-warning" : undefined}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="operator-empty">
      <CheckCircle2 size={18} />
      <span>{children}</span>
    </div>
  );
}

function formatProvider(value: string) {
  if (value === "SOURCE_MISSING") return "Source missing";
  return formatEnum(value);
}

function formatEnum(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatDate(value: Date, utc = false) {
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: utc ? "UTC" : "America/New_York"
  });
}

function formatDateTime(value: Date) {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short"
  });
}

function formatShortDay(dayKey: string) {
  return new Date(`${dayKey}T12:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York"
  });
}

function formatRelativeAge(value: Date) {
  const hours = Math.max(
    0,
    Math.floor((Date.now() - value.getTime()) / (60 * 60 * 1000))
  );
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
