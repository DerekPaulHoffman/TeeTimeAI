import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  CalendarDays,
  CalendarClock,
  CircleOff,
  CirclePause,
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
import { listTeeSearchesForUser } from "@/lib/searches/service";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";

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

  return <DashboardView searches={searches} canManage showRecipientEmail />;
}

function DashboardView({
  searches,
  canManage,
  showRecipientEmail,
  notice
}: {
  searches: DashboardSearches;
  canManage: boolean;
  showRecipientEmail: boolean;
  notice?: string;
}) {
  const activeSearches = searches.filter((search) => search.status === "ACTIVE");
  const inactiveSearches = searches.filter((search) => search.status !== "ACTIVE");
  const activeCount = activeSearches.length;
  const availableMatches = searches.flatMap((search) =>
    search.matches.filter(
      (match) => match.availabilityStatus === "AVAILABLE" && match.startsAt > new Date()
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
          <h2>Alert status</h2>
          <p className="meta">{alertStatusCopy}</p>
          <dl className="sidebar-stat-list">
            <div>
              <dt>Matches found</dt>
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
          {availableMatches.length > 0 ? (
            <div className="match-list">
              {availableMatches.slice(0, 3).map((match) => (
                <div className="match-row" key={match.id}>
                  <div>
                    <h3>{match.course.name}</h3>
                    <p className="meta">
                      {formatDashboardMatch(match.startsAt, match.course.timeZone)} - {match.availableSpots} spots
                    </p>
                  </div>
                  <a
                    className="button button-ghost"
                    href={match.bookingUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink size={16} />
                    Official site
                  </a>
                </div>
              ))}
            </div>
          ) : null}
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
  showRecipientEmail
}: {
  search: DashboardSearches[number];
  canManage: boolean;
  showRecipientEmail: boolean;
}) {
  return (
    <article className="dashboard-row">
      <div className="dashboard-card-main">
        <div className="dashboard-card-topline">
          <div className="dashboard-card-title">
            <span className={`status-pill ${search.status.toLowerCase()}`}>
              {search.status === "ACTIVE" ? <Play size={13} /> : <CirclePause size={13} />}
              {search.status === "ACTIVE" ? "Watching" : search.status}
            </span>
            <h3>
              <CalendarDays size={16} />
              {formatDashboardDate(search.date)}
            </h3>
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
            const alertSupport = getCourseAlertSupport(preference.course);
            const bookingWindow = getBookingWindowForTargetDate(
              search.date,
              preference.course
            );
            const upcomingBookingWindow =
              bookingWindow && bookingWindow.opensAt > new Date() ? bookingWindow : null;
            const usesPhoneBooking = ["PHONE_ONLY", "ONLINE_OR_PHONE", "CONTACT_COURSE"].includes(
              preference.course.bookingMethod
            );
            const bookingPhone = usesPhoneBooking
              ? preference.course.bookingPhone ?? preference.course.phone
              : null;

            return (
              <div className="watch-course-row" key={preference.id}>
                <CourseImage
                  index={preference.rank - 1}
                  name={preference.course.name}
                  rank={preference.rank}
                />
                <div className="watch-course-copy">
                  <div className="figma-course-badges watch-course-badges">
                    <span className="figma-course-pill is-public">
                      <Trees size={11} /> Public
                    </span>
                    {alertSupport ? (
                      <span className="figma-course-pill is-official-site-only">
                        <CircleOff size={11} /> {getAlertSupportLabel(alertSupport)}
                      </span>
                    ) : null}
                  </div>
                  <strong>{preference.course.name}</strong>
                  <p className="meta">
                    <MapPin size={12} />
                    {getCompactLocation(preference.course.address)} - {preference.course.timeZone}
                  </p>
                  {upcomingBookingWindow ? (
                    <p className="watch-course-release">
                      <CalendarClock size={13} />
                      {upcomingBookingWindow.exactTime ? "Booking opens" : "Expected to open"}{" "}
                      {formatBookingWindowRelease(upcomingBookingWindow)}
                      {!upcomingBookingWindow.exactTime ? " (time not published)" : ""}
                    </p>
                  ) : null}
                </div>
                <div className="watch-course-links">
                  <a
                    href={getGoogleMapsSearchUrl(preference.course)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Google Maps <ExternalLink size={11} />
                  </a>
                  {preference.course.detectedBookingUrl ?? preference.course.website ? (
                    <a
                      href={preference.course.detectedBookingUrl ?? preference.course.website ?? "#"}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Official site <ExternalLink size={11} />
                    </a>
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

const dashboardCourseImages = [
  "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=240&q=80",
  "https://images.unsplash.com/photo-1592919505780-303950717480?auto=format&fit=crop&w=240&q=80",
  "https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?auto=format&fit=crop&w=240&q=80",
  "https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&crop=entropy&w=240&q=80",
  "https://images.unsplash.com/photo-1592919505780-303950717480?auto=format&fit=crop&crop=entropy&w=240&q=80"
];

function CourseImage({ index, name, rank }: { index: number; name: string; rank: number }) {
  const imageUrl = dashboardCourseImages[index % dashboardCourseImages.length];

  return (
    <div
      aria-hidden="true"
      className="dashboard-course-image"
      style={{ backgroundImage: `url("${imageUrl}")` }}
      title={name}
    >
      <span>{rank}</span>
    </div>
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
