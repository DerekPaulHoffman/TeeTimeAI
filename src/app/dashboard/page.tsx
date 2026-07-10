import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  CalendarDays,
  CalendarClock,
  CirclePause,
  Clock3,
  ExternalLink,
  Flag,
  Mail,
  MapPin,
  Play,
  Plus,
  ShieldAlert,
  Users
} from "lucide-react";

import { SearchStatusActions } from "@/components/search-status-actions";
import { getRequiredAppUser } from "@/lib/auth/current-user";
import { formatDateInputValue } from "@/lib/dates/local-date";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { getGoogleMapsSearchUrl } from "@/lib/maps";
import { listRecentTeeSearches, listTeeSearchesForUser } from "@/lib/searches/service";

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
    const searches = await listRecentTeeSearches();
    return (
      <DashboardView
        searches={searches}
        canManage={false}
        showRecipientEmail={false}
        notice="Email alerts are active. Sign-in is being prepared, so recipient details and management controls stay private for now."
      />
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return <SignedOutState />;
  }

  const user = await getRequiredAppUser();
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
  const watchedCourseCount = new Set(
    searches.flatMap((search) =>
      search.preferences.map((preference) => preference.course.id)
    )
  ).size;
  const totalAlerts = searches.length;
  const alertStatusCopy = `${activeCount} ${
    activeCount === 1 ? "alert" : "alerts"
  } running. We'll email you the moment a spot opens up.`;
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
        <p>
          You&apos;re all set — we&apos;re watching for open tee times and will email you the moment one shows up.
        </p>
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
              <dt>Courses watched</dt>
              <dd>{watchedCourseCount}</dd>
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
                      {match.startsAt.toLocaleString()} - {match.availableSpots} spots
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
              initialPlayers={search.players}
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
            <span>Your window</span>
            <strong>{formatTimeLabel(search.startTime)} – {formatTimeLabel(search.endTime)}</strong>
          </div>
          <div className="watch-stat">
            <Users size={16} />
            <span>Group size</span>
            <strong>{search.players} {search.players === 1 ? "golfer" : "golfers"}</strong>
          </div>
          <div className="watch-stat">
            <Flag size={16} />
            <span>Courses</span>
            <strong>{search.preferences.length} on watch</strong>
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
          {search.preferences.map((preference) => (
            <div className="watch-course-row" key={preference.id}>
              <CourseImage
                index={preference.rank - 1}
                name={preference.course.name}
                rank={preference.rank}
              />
              <div className="watch-course-copy">
                <strong>{preference.course.name}</strong>
                <p className="meta">
                  <MapPin size={12} />
                  {getCompactLocation(preference.course.address)}
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
                {preference.course.detectedBookingUrl ?? preference.course.website ? (
                  <a
                    href={preference.course.detectedBookingUrl ?? preference.course.website ?? "#"}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Official site <ExternalLink size={11} />
                  </a>
                ) : null}
              </div>
            </div>
          ))}
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
    <main className="dashboard-page">
      <div className="empty-state">
        <ShieldAlert size={30} />
        <h1>Sign in to manage searches</h1>
        <p className="meta">Saved tee time searches are tied to your account.</p>
        <Link className="button button-dark" href="/#start">
          Back to search
        </Link>
      </div>
    </main>
  );
}
