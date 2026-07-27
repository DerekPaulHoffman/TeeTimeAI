import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  CalendarDays,
  CalendarClock,
  BookOpenText,
  CircleAlert,
  CircleOff,
  CirclePause,
  ChevronDown,
  Clock3,
  ExternalLink,
  Flag,
  Mail,
  MapPin,
  Play,
  Plus,
  ShieldAlert,
  Trees,
  Users
} from "lucide-react";

import { DashboardSignInActions } from "@/components/dashboard-sign-in-actions";
import { SearchStatusActions } from "@/components/search-status-actions";
import { getRequiredAppUser } from "@/lib/auth/current-user";
import { normalizeRequestedLayoutHoles } from "@/lib/courses/course-layout";
import {
  formatBookingWindowRelease,
  getBookingWindowForTargetDate
} from "@/lib/courses/booking-window";
import { getAlertSupportLabel, getCourseAlertSupport } from "@/lib/courses/intelligence";
import { formatDateInputValue } from "@/lib/dates/local-date";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { getGoogleMapsSearchUrl } from "@/lib/maps";
import {
  getGooglePlacePhoto,
  type GooglePlacePhoto
} from "@/lib/places/google";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import {
  getDashboardAvailabilityView,
  readDashboardAvailabilitySnapshot
} from "@/lib/searches/dashboard-availability";
import { listTeeSearchesForUser } from "@/lib/searches/service";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";
import { formatCourseDistance } from "@/lib/email/course-facts";
import {
  buildCoursePriceEstimate,
  buildObservedBookableHoleSummary,
  getHeadlineBookableHoleCount,
  getHeadlineCoursePrice,
  type CoursePriceRange
} from "@/lib/pricing/course-prices";

type DashboardSearches = Awaited<ReturnType<typeof listTeeSearchesForUser>>;

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Manage Tee Time Spot tee time alerts.",
  robots: {
    index: false,
    follow: false
  }
};

export default async function DashboardPage() {
  if (!hasDatabaseConfig()) {
    return <SetupState />;
  }

  if (!hasClerkConfig()) {
    return <AuthUnavailableState />;
  }

  const { userId } = await auth();
  if (!userId) {
    return <SignedOutState />;
  }

  let user: Awaited<ReturnType<typeof getRequiredAppUser>>;
  try {
    user = await getRequiredAppUser();
  } catch (error) {
    if (error instanceof SearchEmailDeliveryInProgressError) {
      return <EmailTransitionState />;
    }
    throw error;
  }
  const searches = await listTeeSearchesForUser(user.id);
  const coursePhotos = await loadDashboardCoursePhotos(searches);

  return (
    <DashboardView
      searches={searches}
      canManage
      coursePhotos={coursePhotos}
      showRecipientEmail
    />
  );
}

function DashboardView({
  searches,
  canManage,
  coursePhotos,
  showRecipientEmail,
  notice
}: {
  searches: DashboardSearches;
  canManage: boolean;
  coursePhotos: ReadonlyMap<string, GooglePlacePhoto>;
  showRecipientEmail: boolean;
  notice?: string;
}) {
  const now = new Date();
  const activeSearches = searches.filter((search) => search.status === "ACTIVE");
  const inactiveSearches = searches.filter((search) => search.status !== "ACTIVE");
  const activeCount = activeSearches.length;
  const availableMatches = searches.flatMap((search) =>
    search.matches.filter(
      (match) =>
        match.availabilityStatus === "AVAILABLE" &&
        match.startsAt > now &&
        evaluateMonitoringGate({ ...match.course, now }).disposition === "ACTIONABLE"
    )
  );
  const selectedCourseCount = new Set(
    searches.flatMap((search) =>
      search.preferences.map((preference) => preference.course.id)
    )
  ).size;
  const totalAlerts = searches.length;
  const alertStatusCopy = `${activeCount} ${
    activeCount === 1 ? "alert" : "alerts"
  } running. We'll email you when a spot opens at a supported course.`;
  const readyMessage =
    activeCount > 0
      ? "You’re all set — we’re checking supported courses and will email you when a matching spot opens."
      : searches.length > 0
        ? "You don’t have an active alert right now. Resume a previous search or start a new one."
        : "No alerts yet. Find a tee time to start watching your preferred public courses.";
  const inactiveHeading = inactiveSearches.every((search) => search.status === "CANCELLED")
    ? "Cancelled"
    : "Paused and completed";

  return (
    <main className="dashboard-page">
      <div className="dashboard-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            My Alerts
          </p>
          <h1>My Alerts Dashboard</h1>
        </div>
        <Link className="button button-dark" href="/search">
          <Plus size={16} />
          Find a tee time
        </Link>
      </div>

      <div className="alert alert-info dashboard-alert dashboard-ready-message">
        <p>{readyMessage}</p>
        {notice ? <small>{notice}</small> : null}
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-panel">
          <div className="panel-title-row">
            <h2>Watching now</h2>
            <span className="status-pill active-count">{activeCount} active</span>
          </div>
          {activeSearches.length === 0 ? (
            <div className="empty-state">
              <CalendarClock size={28} />
              <h3>{searches.length === 0 ? "No alerts yet" : "No active alerts"}</h3>
              <p className="meta">
                Find a tee time so Tee Time Spot can start watching your ranked courses.
              </p>
            </div>
          ) : (
            <div className="dashboard-list">
              {activeSearches.map((search) => (
                <DashboardSearchCard
                  canManage={canManage}
                  coursePhotos={coursePhotos}
                  key={search.id}
                  search={search}
                  showRecipientEmail={showRecipientEmail}
                />
              ))}
            </div>
          )}
          {inactiveSearches.length > 0 ? (
            <>
              <div className="dashboard-section-divider">
                <h2>{inactiveHeading}</h2>
              </div>
              <div className="dashboard-list dashboard-list-inactive">
                {inactiveSearches.map((search) => (
                  <DashboardSearchCard
                    canManage={canManage}
                    coursePhotos={coursePhotos}
                    key={search.id}
                    search={search}
                    showRecipientEmail={showRecipientEmail}
                  />
                ))}
              </div>
            </>
          ) : null}
        </section>

        <aside className="dashboard-panel dashboard-sidebar">
          <h2>Alerts overview</h2>
          <p className="meta">{alertStatusCopy}</p>
          <dl className="sidebar-stat-list">
            <div>
              <dt>Matching now</dt>
              <dd>
                {availableMatches.length === 0
                  ? "0 so far"
                  : `${availableMatches.length} available now`}
              </dd>
            </div>
            <div>
              <dt>Courses selected</dt>
              <dd>{selectedCourseCount}</dd>
            </div>
            <div>
              <dt>Total alerts</dt>
              <dd>{totalAlerts}</dd>
            </div>
          </dl>
          <div className="alert alert-info">
            We watch all your courses and only email you when something new opens up — no repeats.
          </div>
          <Link className="button button-dark dashboard-add-search" href="/search">
            <Plus size={16} />
            Add another search
          </Link>
        </aside>
      </div>
    </main>
  );
}

function DashboardSearchCard({
  search,
  canManage,
  coursePhotos,
  showRecipientEmail
}: {
  search: DashboardSearches[number];
  canManage: boolean;
  coursePhotos: ReadonlyMap<string, GooglePlacePhoto>;
  showRecipientEmail: boolean;
}) {
  const now = new Date();
  const availableSearchMatches = search.matches.filter(
    (match) =>
      match.availabilityStatus === "AVAILABLE" &&
      match.startsAt > now &&
      evaluateMonitoringGate({ ...match.course, now }).disposition === "ACTIONABLE"
  );
  const latestCourseProbes = search.preferences.flatMap((preference) => {
    const probe = search.probes.find(
      (candidate) => candidate.courseId === preference.course.id
    );
    return probe ? [probe] : [];
  });
  const visibleProviderSlotCount = latestCourseProbes.reduce(
    (total, probe) =>
      total +
      (readDashboardAvailabilitySnapshot(probe.rawSummary)?.visibleSlotCount ?? 0),
    0
  );
  const summaryStatus =
    availableSearchMatches.length > 0
      ? `${availableSearchMatches.length} matching ${
          availableSearchMatches.length === 1 ? "time" : "times"
        } now`
      : visibleProviderSlotCount > 0
        ? `${visibleProviderSlotCount} ${
            visibleProviderSlotCount === 1 ? "tee time" : "tee times"
          } found in the latest check`
        : latestCourseProbes.length > 0
          ? "No matching times yet"
          : "Waiting for the first check";

  return (
    <article className="dashboard-row">
      <details
        className="dashboard-alert-accordion"
        open={availableSearchMatches.length > 0}
      >
        <summary className="dashboard-alert-summary">
          <div className="dashboard-alert-summary-heading">
            <span className={`status-pill ${search.status.toLowerCase()}`}>
              {search.status === "ACTIVE" ? <Play size={13} /> : <CirclePause size={13} />}
              {search.status === "ACTIVE" ? "Watching" : search.status}
            </span>
            <h3>
              <CalendarDays size={16} />
              {formatDashboardDate(search.date)}
            </h3>
          </div>
          <div className="dashboard-alert-summary-copy">
            <strong>{summaryStatus}</strong>
            <span>
              {formatTimeLabel(search.startTime)}–{formatTimeLabel(search.endTime)}
              {" · "}
              {search.players} {search.players === 1 ? "golfer" : "golfers"}
              {" · "}
              {search.preferences.length}{" "}
              {search.preferences.length === 1 ? "course" : "courses"}
            </span>
          </div>
          <span className="dashboard-alert-summary-checked">
            {search.lastCheckedAt
              ? `Checked ${formatObservationDateTime(search.lastCheckedAt)}`
              : "Check pending"}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="dashboard-alert-summary-chevron"
            size={20}
          />
        </summary>
        <div className="dashboard-alert-body">
          <div className="dashboard-card-main">
        <div className="dashboard-card-topline">
          <div className="dashboard-card-title">
            <h3>Availability and alert details</h3>
          </div>
          {canManage ? (
            <SearchStatusActions
              key={`${search.id}-${search.checkStatus}-${search.lastCheckedAt?.toISOString() ?? "never"}`}
              searchId={search.id}
              status={search.status}
              initialDate={formatDateInputValue(search.date)}
              initialStartTime={search.startTime}
              initialEndTime={search.endTime}
              initialUserTimeZone={search.userTimeZone}
              initialPlayers={search.players}
              initialRequestedLayoutHoles={normalizeRequestedLayoutHoles(
                search.requestedLayoutHoles
              )}
              initialCadenceMinutes={search.cadenceMinutes}
              initialAdditionalEmails={search.additionalEmails}
              initialCheckStatus={search.checkStatus}
              initialLastCheckedAt={search.lastCheckedAt?.toISOString() ?? null}
              initialNextCheckAt={search.nextCheckAt?.toISOString() ?? null}
              initialCoursePreferences={search.preferences.map((preference) => ({
                id: preference.id,
                courseName: preference.course.name,
                rank: preference.rank
              }))}
            />
          ) : (
            <span className="meta">Sign in to pause, edit, or cancel this alert.</span>
          )}
        </div>
        <div className="watch-stat-grid" aria-label="Alert details">
          <div className="watch-stat">
            <Clock3 size={16} />
            <span>Course-local window</span>
            <strong>{formatTimeLabel(search.startTime)} – {formatTimeLabel(search.endTime)}</strong>
          </div>
          <div className="watch-stat">
            <Users size={16} />
            <span>Group size</span>
            <strong>{search.players} {search.players === 1 ? "golfer" : "golfers"}</strong>
          </div>
          <div className="watch-stat">
            <Flag size={16} />
            <span>Courses / layout</span>
            <strong>
              {search.preferences.length} on watch ·{" "}
              {search.requestedLayoutHoles
                ? `${search.requestedLayoutHoles}-hole`
                : "any layout"}
            </strong>
          </div>
          <div className="watch-stat">
            <Mail size={16} />
            <span>Emails</span>
            <strong className="watch-stat-email">
              <span className="watch-stat-email-full">
                {showRecipientEmail
                  ? `${search.user.email}${
                      search.additionalEmails.length > 0
                        ? ` +${search.additionalEmails.length} extra`
                        : ""
                    }`
                  : search.additionalEmails.length > 0
                    ? `${search.additionalEmails.length + 1} recipients`
                    : "Just you"}
              </span>
              <span className="watch-stat-email-compact">
                {search.additionalEmails.length > 0
                  ? `${search.additionalEmails.length + 1} recipients`
                  : "Just you"}
              </span>
            </strong>
          </div>
        </div>
        <div className="watch-course-list">
          {search.preferences.map((preference) => {
            const isPublicCourse = preference.course.isPublic === true;
            const isPendingCourse = preference.course.isPublic === null;
            const monitoringGate = evaluateMonitoringGate({
              ...preference.course,
              now
            });
            const identityRecheckDue =
              preference.course.isPublic === false &&
              monitoringGate.requiresRevalidation;
            const alertSupport = isPublicCourse
              ? getCourseAlertSupport(preference.course)
              : null;
            const bookingWindow = isPublicCourse
              ? getBookingWindowForTargetDate(search.date, preference.course)
              : null;
            const upcomingBookingWindow =
              bookingWindow && bookingWindow.opensAt > now ? bookingWindow : null;
            const usesPhoneBooking =
              isPublicCourse &&
              ["PHONE_ONLY", "ONLINE_OR_PHONE", "CONTACT_COURSE"].includes(
                preference.course.bookingMethod
              );
            const bookingPhone = usesPhoneBooking
              ? preference.course.bookingPhone ?? preference.course.phone
              : null;
            const officialCourseUrl = isPublicCourse
              ? preference.course.detectedBookingUrl ?? preference.course.website
              : preference.course.website;
            const latestProbe = search.probes.find(
              (probe) => probe.courseId === preference.course.id
            );
            const courseMatches = availableSearchMatches.filter(
              (match) => match.courseId === preference.course.id
            );
            const availabilityView = getDashboardAvailabilityView({
              outcome: latestProbe?.outcome,
              rawSummary: latestProbe?.rawSummary,
              qualifyingMatchCount: courseMatches.length,
              players: search.players,
              startTime: search.startTime,
              endTime: search.endTime,
              bookingOpensLabel: upcomingBookingWindow
                ? upcomingBookingWindow.exactTime
                  ? `when booking opens ${formatBookingWindowRelease(
                      upcomingBookingWindow
                    )}`
                  : `around ${formatBookingWindowRelease(upcomingBookingWindow)}`
                : null
            });
            const monitoringVerdict = getDashboardMonitoringVerdict({
              alertSupport,
              automationEligibility: preference.course.automationEligibility,
              latestProbe,
              upcomingBookingWindow,
              firstTimeLookup:
                Math.abs(
                  preference.course.createdAt.getTime() - search.createdAt.getTime()
                ) <= 2 * 60 * 1000
            });
            const bookingEvidence = {
              bookingFacts: preference.course.bookingFacts,
              probes: [],
              matches: []
            };
            const priceEstimate = buildCoursePriceEstimate(bookingEvidence);
            const observedHoles = buildObservedBookableHoleSummary(bookingEvidence);
            const physicalHoleCount = getHeadlineBookableHoleCount(
              preference.course.layoutHoleCounts
            );
            const bookableHoleCount =
              physicalHoleCount ??
              getHeadlineBookableHoleCount(observedHoles.holeCounts);
            const headlinePrice = getHeadlineCoursePrice(
              priceEstimate,
              bookableHoleCount ? [bookableHoleCount] : []
            );
            const courseGuideUrl =
              preference.course.profile &&
              ["PUBLISHED", "STALE"].includes(preference.course.profile.status)
                ? `/courses/${preference.course.profile.canonicalSlug}`
                : null;

            return (
              <div className="watch-course-row" key={preference.id}>
                <CourseImage
                  name={preference.course.name}
                  photo={
                    preference.course.googlePlaceId
                      ? coursePhotos.get(preference.course.googlePlaceId)
                      : undefined
                  }
                  rank={preference.rank}
                />
                <div className="watch-course-copy">
                  <div className="figma-course-badges watch-course-badges">
                    {isPublicCourse ? (
                      <span className="figma-course-pill is-public">
                        <Trees size={11} /> Public
                      </span>
                    ) : isPendingCourse ? (
                      <span className="figma-course-pill is-unverified">
                        <CircleAlert size={11} /> Verifying course
                      </span>
                    ) : (
                      <span className="figma-course-pill is-official-site-only">
                        <CircleOff size={11} />
                        {identityRecheckDue
                          ? "Confirming course details"
                          : "Not available for alerts"}
                      </span>
                    )}
                    {typeof preference.course.rating === "number" ? (
                      <span
                        className="figma-course-pill is-detail"
                        title={
                          preference.course.ratingObservedAt
                            ? `Rating last observed ${formatObservationDate(preference.course.ratingObservedAt)}`
                            : "Last observed course rating"
                        }
                      >
                        {preference.course.rating.toFixed(1)}
                      </span>
                    ) : null}
                    {typeof preference.distanceMetersAtSelection === "number" ? (
                      <span
                        className="figma-course-pill is-detail"
                        title="Distance when this course was selected"
                      >
                        {formatCourseDistance(preference.distanceMetersAtSelection)}
                      </span>
                    ) : null}
                    {bookableHoleCount ? (
                      <span
                        className="figma-course-pill is-detail"
                        title={
                          physicalHoleCount
                            ? "Verified physical course layout"
                            : observedHoles.observedAt
                              ? `Official booking options last observed ${formatObservationDate(observedHoles.observedAt)}`
                              : "Last observed official booking options"
                        }
                      >
                        {bookableHoleCount}H
                      </span>
                    ) : null}
                    {headlinePrice ? (
                      <span
                        className="figma-course-pill is-price"
                        title={`Official ${headlinePrice.holes}-hole rates last observed ${formatObservationDate(headlinePrice.range.observedAt ?? priceEstimate?.observedAt)}`}
                      >
                        {formatCoursePriceRange(headlinePrice.range)}
                      </span>
                    ) : null}
                    {alertSupport ? (
                      <span className="figma-course-pill is-official-site-only">
                        <CircleOff size={11} /> {getAlertSupportLabel(alertSupport)}
                      </span>
                    ) : null}
                    <span className={`figma-course-pill ${monitoringVerdict.className}`}>
                      {monitoringVerdict.icon === "watching" ? (
                        <Play size={11} />
                      ) : monitoringVerdict.icon === "scheduled" ? (
                        <CalendarClock size={11} />
                      ) : (
                        <CircleOff size={11} />
                      )}
                      {monitoringVerdict.label}
                    </span>
                  </div>
                  <strong>{preference.course.name}</strong>
                  <p className="meta">
                    <MapPin size={12} />
                    {getCompactLocation(preference.course.address)} - {preference.course.timeZone}
                  </p>
                  <div
                    className={`watch-course-availability is-${availabilityView.tone}`}
                  >
                    <div className="watch-course-availability-heading">
                      <span aria-hidden="true" />
                      <strong>{availabilityView.label}</strong>
                    </div>
                    <p>{availabilityView.detail}</p>
                    {courseMatches.length > 0 ? (
                      <details className="watch-course-match-details">
                        <summary>
                          View{" "}
                          {courseMatches.length === 1
                            ? "matching time"
                            : `all ${courseMatches.length} matching times`}
                        </summary>
                        <div className="watch-course-match-list">
                          {courseMatches.map((match) => (
                            <a
                              href={match.bookingUrl}
                              key={match.id}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <strong>
                                {formatDashboardMatch(
                                  match.startsAt,
                                  match.course.timeZone
                                )}
                              </strong>
                              <span>
                                {match.availableSpots}{" "}
                                {match.availableSpots === 1 ? "spot" : "spots"}
                                {match.holes ? ` · ${match.holes} holes` : ""}
                              </span>
                              <ExternalLink aria-hidden="true" size={12} />
                            </a>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                  <p className="watch-course-release">
                    {monitoringVerdict.detail}
                    {latestProbe
                      ? ` Last checked ${formatObservationDateTime(latestProbe.observedAt)}.`
                      : ""}
                  </p>
                </div>
                <div className="watch-course-links">
                  <a
                    href={getGoogleMapsSearchUrl(preference.course)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Google Maps <ExternalLink size={11} />
                  </a>
                  {officialCourseUrl ? (
                    <a
                      href={officialCourseUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {isPublicCourse ? "Official site" : "Course information"}{" "}
                      <ExternalLink size={11} />
                    </a>
                  ) : null}
                  {courseGuideUrl ? (
                    <Link href={courseGuideUrl as `/courses/${string}`}>
                      Course Guide <BookOpenText size={11} />
                    </Link>
                  ) : null}
                  {bookingPhone ? (
                    <a href={`tel:${formatTelephoneHref(bookingPhone)}`}>
                      Call course
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
          </div>
        </div>
      </details>
    </article>
  );
}

function formatDashboardDate(date: Date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function formatObservationDate(value: Date | string | undefined) {
  if (!value) return "an earlier check";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "an earlier check";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatObservationDateTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getDashboardMonitoringVerdict(input: {
  alertSupport: ReturnType<typeof getCourseAlertSupport> | null;
  automationEligibility: string;
  latestProbe?: {
    outcome:
      | "MATCH_FOUND"
      | "NO_MATCH"
      | "BLOCKED_POLICY"
      | "BLOCKED_AUTH"
      | "BLOCKED_TOOLING"
      | "FETCH_FAILED"
      | "NEEDS_ADAPTER";
    observedAt: Date;
  };
  upcomingBookingWindow: ReturnType<typeof getBookingWindowForTargetDate>;
  firstTimeLookup: boolean;
}) {
  if (input.upcomingBookingWindow && input.latestProbe?.outcome === "NO_MATCH") {
    return {
      label: "Monitoring scheduled",
      detail: "Automatic checks will begin at the useful booking release time.",
      icon: "scheduled" as const,
      className: "is-detail"
    };
  }
  if (
    input.latestProbe?.outcome === "MATCH_FOUND" ||
    input.latestProbe?.outcome === "NO_MATCH"
  ) {
    return {
      label: "Automatic monitoring confirmed",
      detail: "The latest automatic check completed successfully.",
      icon: "watching" as const,
      className: "is-public"
    };
  }
  if (
    input.latestProbe?.outcome === "FETCH_FAILED" ||
    input.latestProbe?.outcome === "BLOCKED_TOOLING"
  ) {
    return {
      label: "Temporarily unavailable",
      detail:
        "The latest automatic check did not finish. Use the official site while Tee Time Spot retries.",
      icon: "unavailable" as const,
      className: "is-official-site-only"
    };
  }
  if (
    input.alertSupport ||
    input.latestProbe?.outcome === "NEEDS_ADAPTER" ||
    input.latestProbe?.outcome === "BLOCKED_POLICY" ||
    input.latestProbe?.outcome === "BLOCKED_AUTH"
  ) {
    return {
      label: "Automatic alerts unavailable",
      detail:
        "Use the official course site for current availability. Coverage work may continue in the background.",
      icon: "unavailable" as const,
      className: "is-official-site-only"
    };
  }
  return {
    label: input.firstTimeLookup ? "First-time course lookup" : "First verdict pending",
    detail:
      input.automationEligibility === "ALLOWED"
        ? "The first check is starting now and will confirm the current result."
        : input.firstTimeLookup
          ? "Tee Time Spot hasn't checked this course before. We'll email the verdict after the first check, usually within 10 minutes. If coverage takes longer, we'll alert our course coverage team."
          : "We’ll email the monitoring verdict after the first check, usually within 10 minutes.",
    icon: "scheduled" as const,
    className: "is-detail"
  };
}

function formatCoursePriceRange(range: CoursePriceRange) {
  const format = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value % 100 === 0 ? 0 : 2
    }).format(value / 100);
  const minimum = format(range.minPriceCents);
  const maximum = format(range.maxPriceCents);
  return minimum === maximum ? minimum : `${minimum}–${maximum}`;
}

function formatDashboardMatch(date: Date, timeZone: string) {
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short"
  });
}

function formatTimeLabel(value: string) {
  const [hourValue, minute = "00"] = value.split(":");
  const hour = Number(hourValue);
  if (!Number.isFinite(hour)) {
    return value;
  }

  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function getCompactLocation(address: string | null) {
  if (!address) {
    return "Course location";
  }

  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return `${parts.at(-3)}, ${parts.at(-2)}`;
  }

  return address;
}

function formatTelephoneHref(phone: string) {
  return phone.trim().replace(/(?!^\+)[^\d]/g, "");
}

function CourseImage({
  name,
  photo,
  rank
}: {
  name: string;
  photo?: GooglePlacePhoto;
  rank: number;
}) {
  const imageUrl = photo
    ? `/api/courses/photo?ref=${encodeURIComponent(photo.photoReference)}`
    : null;
  const attribution = photo?.authorAttributions
    .map((item) => item.displayName?.trim())
    .filter((displayName): displayName is string => Boolean(displayName))
    .join(", ");

  return (
    <div
      aria-label={imageUrl ? `${name} course photo` : `${name} photo unavailable`}
      className={`dashboard-course-image${imageUrl ? "" : " dashboard-course-image-empty"}`}
      role="img"
      style={imageUrl ? { backgroundImage: `url("${imageUrl}")` } : undefined}
      title={attribution ? `${name} photo by ${attribution}` : name}
    >
      {!imageUrl ? <Trees aria-hidden="true" className="dashboard-course-placeholder-icon" /> : null}
      <span className="dashboard-course-rank">{rank}</span>
      {attribution ? (
        <span className="dashboard-course-attribution">Photo: {attribution}</span>
      ) : null}
    </div>
  );
}

async function loadDashboardCoursePhotos(searches: DashboardSearches) {
  const googlePlaceIds = Array.from(
    new Set(
      searches.flatMap((search) =>
        search.preferences.flatMap((preference) =>
          preference.course.googlePlaceId && !preference.course.isManual
            ? [preference.course.googlePlaceId]
            : []
        )
      )
    )
  );
  const photos = await Promise.all(
    googlePlaceIds.map(async (googlePlaceId) => {
      const photo = await getGooglePlacePhoto(googlePlaceId);
      return [googlePlaceId, photo] as const;
    })
  );

  return new Map(
    photos.filter(
      (entry): entry is readonly [string, GooglePlacePhoto] => entry[1] !== null
    )
  );
}

function SetupState() {
  return (
    <main className="dashboard-page">
      <div className="empty-state">
        <ShieldAlert size={30} />
        <h1>Dashboard setup needed</h1>
        <p className="meta">
          The dashboard is ready, but saved searches need database access before they can load.
        </p>
        <Link className="button button-dark" href="/#start">
          Preview intake
        </Link>
      </div>
    </main>
  );
}

function SignedOutState() {
  return (
    <main className="dashboard-page dashboard-auth-page">
      <section className="empty-state empty-state-auth">
        <span className="empty-state-auth-icon" aria-hidden="true">
          <ShieldAlert size={26} />
        </span>
        <h1>Sign in to manage searches</h1>
        <p className="meta">
          Your saved tee time searches are tied to your account. Sign in to view, pause, or
          update them.
        </p>
        <DashboardSignInActions />
      </section>
    </main>
  );
}

function EmailTransitionState() {
  return (
    <main className="dashboard-page">
      <div className="empty-state">
        <Mail size={30} />
        <h1>Updating your alert email</h1>
        <p className="meta">
          An alert was already being finalized, so Tee Time Spot is safely finishing it before
          switching future messages to your new account email.
        </p>
        <Link className="button button-dark" href="/dashboard">
          Refresh dashboard
        </Link>
      </div>
    </main>
  );
}

function AuthUnavailableState() {
  return (
    <main className="dashboard-page">
      <div className="empty-state">
        <ShieldAlert size={30} />
        <h1>Account access is temporarily unavailable</h1>
        <p className="meta">
          Saved alerts stay private while sign-in is being configured. Email alerts continue
          running normally.
        </p>
        <Link className="button button-dark" href="/search">
          Back to search
        </Link>
      </div>
    </main>
  );
}
