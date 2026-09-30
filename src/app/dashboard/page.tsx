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
  ExternalLink,
  Mail,
  MapPin,
  Play,
  Plus,
  ShieldAlert,
  Trees
} from "lucide-react";

import { DashboardSignInActions } from "@/components/dashboard-sign-in-actions";
import { SearchStatusActions } from "@/components/search-status-actions";
import { getRequiredAppUser } from "@/lib/auth/current-user";
import { normalizeRequestedLayoutHoles } from "@/lib/courses/course-layout";
import {
  formatBookingWindowRelease,
  getBookingWindowForTargetDate
} from "@/lib/courses/booking-window";
import { getCourseAlertSupport } from "@/lib/courses/intelligence";
import { formatDateInputValue } from "@/lib/dates/local-date";
import { formatObservationDateTime } from "@/lib/dates/observation-date-time";
import {
  getClerkPublishableKey,
  hasClerkConfig,
  hasDatabaseConfig
} from "@/lib/env";
import { getGoogleMapsSearchUrl } from "@/lib/maps";
import { prisma } from "@/lib/prisma";
import {
  getGooglePlacePhoto,
  type GooglePlacePhoto
} from "@/lib/places/google";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { isAutomationHumanReviewProofCurrentOrPrior } from "@/lib/automation/course-monitoring-playbook";
import { hasDurableAutomationStalledEndpointProof } from "@/lib/customer-monitoring-status";
import {
  getDashboardAlertSummary,
  getDashboardCourseStatus
} from "@/lib/searches/dashboard-alert-summary";
import { listTeeSearchesForUser } from "@/lib/searches/service";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";
import { formatCourseDistance } from "@/lib/email/course-facts";
import { getOwnerEmailState, type OwnerEmailState } from "@/lib/email/owner-email-state";
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
  const [coursePhotos, ownerEmailStates] = await Promise.all([
    loadDashboardCoursePhotos(searches),
    loadOwnerEmailStates(user.id, searches),
  ]);

  return (
    <DashboardView
      searches={searches}
      canManage
      coursePhotos={coursePhotos}
      ownerEmailStates={ownerEmailStates}
      showRecipientEmail
    />
  );
}

function DashboardView({
  searches,
  canManage,
  coursePhotos,
  ownerEmailStates,
  showRecipientEmail,
  notice
}: {
  searches: DashboardSearches;
  canManage: boolean;
  coursePhotos: ReadonlyMap<string, GooglePlacePhoto>;
  ownerEmailStates: ReadonlyMap<string, OwnerEmailState>;
  showRecipientEmail: boolean;
  notice?: string;
}) {
  const now = new Date();
  const activeSearches = searches.filter((search) => search.status === "ACTIVE");
  const inactiveSearches = searches.filter((search) => search.status !== "ACTIVE");
  const activeCount = activeSearches.length;
  const availableMatches = activeSearches.flatMap((search) =>
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
  } active. See each course's status for what we can check.`;
  const readyMessage =
    activeCount > 0
      ? "Your alerts are saved and active. See each course’s status below. We’ll email confirmed matches and important alert updates."
      : searches.length > 0
        ? inactiveSearches.some((search) => search.status === "PAUSED")
          ? "You don’t have an active alert right now. Resume a paused alert or start a new one."
          : "You don’t have an active alert right now. Start a new one when you’re ready to play."
        : "No alerts yet. Find public courses and save your preferred date and time.";
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
            <h2>Active alerts</h2>
            <span className="status-pill active-count">{activeCount} active</span>
          </div>
          {activeSearches.length === 0 ? (
            <div className="empty-state">
              <CalendarClock size={28} />
              <h3>{searches.length === 0 ? "No alerts yet" : "No active alerts"}</h3>
              <p className="meta">
                Find public courses and save when you want to play. Each course’s status explains what we can check.
              </p>
            </div>
          ) : (
            <div className="dashboard-list">
              {activeSearches.map((search) => (
                <DashboardSearchCard
                  canManage={canManage}
                  coursePhotos={coursePhotos}
                  ownerEmailState={ownerEmailStates.get(search.id) ?? "FIRST_CHECK_PENDING"}
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
                    ownerEmailState={ownerEmailStates.get(search.id) ?? "FIRST_CHECK_PENDING"}
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
            See each course’s status for what we can check. We’ll email new confirmed matches and alert updates.
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
  ownerEmailState,
  showRecipientEmail
}: {
  search: DashboardSearches[number];
  canManage: boolean;
  coursePhotos: ReadonlyMap<string, GooglePlacePhoto>;
  ownerEmailState: OwnerEmailState;
  showRecipientEmail: boolean;
}) {
  const now = new Date();
  const availableSearchMatches = search.matches.filter(
    (match) =>
      match.availabilityStatus === "AVAILABLE" &&
      match.startsAt > now &&
      evaluateMonitoringGate({ ...match.course, now }).disposition === "ACTIONABLE"
  );
  const courseStatusById = new Map(search.preferences.map((preference) => {
    const course = preference.course;
    const isPublicCourse = course.isPublic === true;
    const latestProbe = search.probes.find((probe) => probe.courseId === course.id);
    const bookingWindow = isPublicCourse
      ? getBookingWindowForTargetDate(search.date, course)
      : null;
    const upcomingBookingWindow =
      bookingWindow && bookingWindow.opensAt > now &&
      latestProbe?.outcome !== "MATCH_FOUND" ? bookingWindow : null;
    const usesPhoneBooking = isPublicCourse &&
      ["PHONE_ONLY", "ONLINE_OR_PHONE", "CONTACT_COURSE"].includes(course.bookingMethod);
    const courseStatus = getDashboardCourseStatus({
      availability: {
        alertStatus: search.status,
        outcome: latestProbe?.outcome,
        rawSummary: latestProbe?.rawSummary,
        qualifyingMatchCount: availableSearchMatches.filter(
          (match) => match.courseId === course.id
        ).length,
        players: search.players,
        startTime: search.startTime,
        endTime: search.endTime,
        bookingOpensLabel: upcomingBookingWindow
          ? upcomingBookingWindow.exactTime
            ? `when booking opens ${formatBookingWindowRelease(upcomingBookingWindow)}`
            : `around ${formatBookingWindowRelease(upcomingBookingWindow)}`
          : null
      },
      monitoring: {
        alertStatus: search.status,
        alertSupport: isPublicCourse ? getCourseAlertSupport(course) ?? null : null,
        bookingPhone: usesPhoneBooking ? course.bookingPhone ?? course.phone : null,
        automationEligibility: course.automationEligibility,
        automationReason: course.automationReason,
        latestProbe,
        upcomingBookingWindow,
        monitoringState: course.monitoringStatus?.state ?? null,
        monitoringStateChangedAt: course.monitoringStatus?.stateChangedAt ?? null,
        supportIncidentStatus: course.supportIncident?.status ?? null,
        humanReviewReason: course.supportIncident?.humanReviewReason ?? null,
        incidentEscalatedAt: course.supportIncident?.escalatedAt ?? null,
        escalationDeadlineAt: course.supportIncident?.escalationDeadlineAt ?? null,
        automationPlaybookExhausted: course.supportIncident
          ? isAutomationHumanReviewProofCurrentOrPrior(
              course.supportIncident.attemptLedger,
              course.supportIncident.cycle
            )
          : null,
        automationStalledAtEndpoint: course.supportIncident
          ? hasDurableAutomationStalledEndpointProof({
              incidentId: course.supportIncident.id,
              incidentCycle: course.supportIncident.cycle,
              incidentStatus: course.supportIncident.status,
              humanReviewReason: course.supportIncident.humanReviewReason,
              incidentEscalatedAt: course.supportIncident.escalatedAt,
              escalationDeadlineAt: course.supportIncident.escalationDeadlineAt,
              monitoringState: course.monitoringStatus?.state ?? null,
              endpointEvents: course.supportIncident.monitoringEvents
            })
          : false,
        firstTimeLookup: Math.abs(
          course.createdAt.getTime() - search.createdAt.getTime()
        ) <= 2 * 60 * 1000
      }
    });
    return [course.id, courseStatus] as const;
  }));
  const summary = getDashboardAlertSummary({
    alertStatus: search.status,
    qualifyingMatchCount: availableSearchMatches.length,
    courseStatuses: [...courseStatusById.values()]
  });

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
              {summary.lifecycleLabel}
            </span>
            <h3>
              <CalendarDays size={16} />
              {formatDashboardDate(search.date)}
            </h3>
          </div>
          <div className="dashboard-alert-summary-copy">
            <strong>{summary.headline}</strong>
            {summary.coverageNotice ? <span>{summary.coverageNotice}</span> : null}
            <span>
              {formatTimeLabel(search.startTime)}–{formatTimeLabel(search.endTime)}
              {" · "}
              {search.players} {search.players === 1 ? "golfer" : "golfers"}
              {" · "}
              {search.preferences.length}{" "}
              {search.preferences.length === 1 ? "course" : "courses"}
            </span>
            <span className={`dashboard-email-status${ownerEmailState === "NOT_SENT" ? " dashboard-email-not-sent" : ""}`}>
              <Mail aria-hidden="true" size={12} />
              {ownerEmailState === "SENT"
                ? "Alert email sent for these settings"
                : ownerEmailState === "PREVIOUSLY_SENT"
                  ? "An alert email was sent previously"
                : ownerEmailState === "PENDING"
                  ? "Alert email pending for these settings"
                  : ownerEmailState === "NOT_SENT"
                    ? "No email sent for these alert settings"
                    : "First email pending initial check"}
            </span>
          </div>
          <span className="dashboard-alert-summary-checked">
            {search.lastCheckedAt
              ? `Checked ${formatObservationDateTime(
                  search.lastCheckedAt,
                  search.userTimeZone
                )}`
              : search.status === "ACTIVE" ? "Check pending" : "Checks stopped"}
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
            <h3>Ranked courses</h3>
            <p className="dashboard-card-context">
              {search.requestedLayoutHoles
                ? `${search.requestedLayoutHoles}-hole courses`
                : "Any course layout"}
              {" · "}
              {showRecipientEmail
                ? `Alerts to ${search.alertEmail ?? search.user.email}${
                    search.additionalEmails.length > 0
                      ? ` +${search.additionalEmails.length} more`
                      : ""
                  }`
                : search.additionalEmails.length > 0
                  ? `${search.additionalEmails.length + 1} alert recipients`
                  : "Alerts to you"}
            </p>
          </div>
          {canManage ? (
            <SearchStatusActions
              key={search.id}
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
              initialScheduleVersion={search.scheduleVersion}
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
            const latestProbe = search.probes.find(
              (probe) => probe.courseId === preference.course.id
            );
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
            const officialCourseLinkLabel = !isPublicCourse
              ? "Course information"
              : preference.course.detectedBookingUrl
                ? preference.course.bookingMethod === "CONTACT_COURSE"
                  ? "Official request page"
                  : "Official booking page"
                : "Official site";
            const courseMatches = availableSearchMatches.filter(
              (match) => match.courseId === preference.course.id
            );
            const courseStatus = courseStatusById.get(preference.course.id)!;
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
                  </div>
                  <strong>{preference.course.name}</strong>
                  <p className="meta">
                    <MapPin size={12} />
                    {getCompactLocation(preference.course.address)} - {preference.course.timeZone}
                  </p>
                  <div
                    className={`watch-course-availability is-${courseStatus.tone}`}
                  >
                    <div className="watch-course-availability-heading">
                      <span
                        aria-hidden="true"
                        className="watch-course-status-emoji"
                      >
                        {courseStatus.emoji}
                      </span>
                      <strong>{courseStatus.label}</strong>
                    </div>
                    <p>
                      {courseStatus.detail}
                      {latestProbe
                        ? ` Checked ${formatObservationDateTime(
                            latestProbe.observedAt,
                            search.userTimeZone
                          )}.`
                        : ""}
                    </p>
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
                      {officialCourseLinkLabel}{" "}
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
                      Call {bookingPhone}
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

async function loadOwnerEmailStates(userId: string, searches: DashboardSearches) {
  const states = new Map<string, OwnerEmailState>();
  if (searches.length === 0) return states;

  const currentGenerationBySearch = new Map(
    searches.map((search) => [search.id, search.alertGeneration]),
  );
  const [deliveries, generationClocks] = await Promise.all([
    prisma.searchEmailDelivery.groupBy({
      by: ["teeSearchId", "alertGeneration", "status"],
      where: {
        teeSearchId: { in: searches.map((search) => search.id) },
        isOwnerRecipient: true,
        kind: { not: "DAILY" },
      },
    }),
    prisma.teeSearch.findMany({
      where: { userId, id: { in: searches.map((search) => search.id) } },
      select: {
        id: true,
        alertGeneration: true,
        createdAt: true,
        statusEmailSnapshot: true,
      },
    }),
  ]);
  const generationClockBySearch = new Map(
    generationClocks.map((search) => [search.id, search]),
  );
  const statusesBySearch = new Map<string, Set<string>>();
  const previouslySentSearches = new Set<string>();
  for (const delivery of deliveries) {
    if (delivery.alertGeneration !== currentGenerationBySearch.get(delivery.teeSearchId)) {
      if (delivery.status === "SENT") previouslySentSearches.add(delivery.teeSearchId);
      continue;
    }
    const statuses = statusesBySearch.get(delivery.teeSearchId) ?? new Set<string>();
    statuses.add(delivery.status);
    statusesBySearch.set(delivery.teeSearchId, statuses);
  }

  for (const search of searches) {
    const statuses = statusesBySearch.get(search.id);
    const generationClock = generationClockBySearch.get(search.id);
    states.set(search.id, getOwnerEmailState({
      statuses,
      previouslySent: previouslySentSearches.has(search.id),
      status: search.status,
      alertGeneration: search.alertGeneration,
      createdAt: generationClock?.createdAt ?? search.createdAt,
      statusEmailSnapshot: generationClock?.statusEmailSnapshot,
      lastCheckedAt: search.lastCheckedAt,
    }));
  }
  return states;
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
        <DashboardSignInActions publishableKey={getClerkPublishableKey()!} />
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
