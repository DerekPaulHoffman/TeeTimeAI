import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  Bell,
  CalendarDays,
  CalendarClock,
  CirclePause,
  Clock3,
  ExternalLink,
  Flag,
  Mail,
  MapPin,
  Play,
  ShieldAlert,
  Users
} from "lucide-react";

import { SearchStatusActions } from "@/components/search-status-actions";
import { getRequiredAppUser } from "@/lib/auth/current-user";
import { formatDateInputValue } from "@/lib/dates/local-date";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { getGoogleMapsSearchUrl } from "@/lib/maps";
import { listRecentTeeSearches, listTeeSearchesForUser } from "@/lib/searches/service";
import { MAX_QUEUED_SEARCHES_PER_USER } from "@/lib/validation/search";

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
        canManage
        notice="Email alerts are active. Dashboard management is available while account sign-in is being prepared."
      />
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return <SignedOutState />;
  }

  const user = await getRequiredAppUser();
  const searches = await listTeeSearchesForUser(user.id);

  return <DashboardView searches={searches} canManage />;
}

function DashboardView({
  searches,
  canManage,
  notice
}: {
  searches: DashboardSearches;
  canManage: boolean;
  notice?: string;
}) {
  const activeCount = searches.filter((search) => search.status === "ACTIVE").length;
  const pendingMatches = searches.flatMap((search) =>
    search.matches.filter((match) => match.alertStatus === "PENDING")
  );
  const watchedCourseCount = searches.reduce(
    (count, search) => count + search.preferences.length,
    0
  );
  const totalAlerts = searches.length;
  const alertStatusCopy = `${activeCount} ${
    activeCount === 1 ? "alert" : "alerts"
  } running. We'll email you the moment a spot opens up.`;

  return (
    <main className="dashboard-page">
      <div className="dashboard-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Your alerts
          </p>
          <h1>Your tee time alerts</h1>
        </div>
      </div>

      {notice ? <div className="alert alert-info dashboard-alert">{notice}</div> : null}
      <div className="alert alert-success dashboard-alert">
        You&apos;re all set. We&apos;re watching for open tee times and will email you the
        moment one shows up.
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-panel">
          <div className="panel-title-row">
            <h2>Watching now</h2>
            <span className="status-pill active-count">{activeCount} active</span>
          </div>
          <p className="meta">
            Keep up to {MAX_QUEUED_SEARCHES_PER_USER} active or paused searches in the queue.
          </p>
          {searches.length === 0 ? (
            <div className="empty-state">
              <CalendarClock size={28} />
              <h3>No searches yet</h3>
              <p className="meta">
                Create a search from the homepage so Tee Time Spot can start watching your ranked courses.
              </p>
            </div>
          ) : (
            <div className="dashboard-list">
              {searches.map((search) => (
                <article className="dashboard-row" key={search.id}>
                  <div className="dashboard-card-main">
                    <div className="dashboard-card-topline">
                      <div className="dashboard-card-title">
                        <span className={`status-pill ${search.status.toLowerCase()}`}>
                          {search.status === "ACTIVE" ? (
                            <Play size={13} />
                          ) : (
                            <CirclePause size={13} />
                          )}
                          {search.status === "ACTIVE" ? "Watching" : search.status}
                        </span>
                        <h3>
                          <CalendarDays size={16} />
                          {formatDashboardDate(search.date)}
                        </h3>
                      </div>
                      {canManage ? (
                        <SearchStatusActions
                          searchId={search.id}
                          status={search.status}
                          initialDate={formatDateInputValue(search.date)}
                          initialStartTime={search.startTime}
                          initialEndTime={search.endTime}
                          initialPlayers={search.players}
                          initialCadenceMinutes={search.cadenceMinutes}
                          initialAdditionalEmails={search.additionalEmails}
                          initialCoursePreferences={search.preferences.map((preference) => ({
                            id: preference.id,
                            courseName: preference.course.name,
                            rank: preference.rank
                          }))}
                        />
                      ) : (
                        <span className="meta">
                          Sign in to pause, edit, or cancel this alert.
                        </span>
                      )}
                    </div>
                    <div className="watch-stat-grid" aria-label="Alert details">
                      <div className="watch-stat">
                        <Clock3 size={18} />
                        <span>Your window</span>
                        <strong>
                          {formatTimeLabel(search.startTime)} - {formatTimeLabel(search.endTime)}
                        </strong>
                      </div>
                      <div className="watch-stat">
                        <Users size={18} />
                        <span>Group size</span>
                        <strong>
                          {search.players} {search.players === 1 ? "golfer" : "golfers"}
                        </strong>
                      </div>
                      <div className="watch-stat">
                        <Flag size={18} />
                        <span>Courses</span>
                        <strong>
                          {search.preferences.length}{" "}
                          {search.preferences.length === 1 ? "on watch" : "on watch"}
                        </strong>
                      </div>
                      <div className="watch-stat">
                        <Mail size={18} />
                        <span>Emails</span>
                        <strong>
                          {search.additionalEmails.length > 0
                            ? `+${search.additionalEmails.length} extra`
                            : "Just you"}
                        </strong>
                      </div>
                    </div>
                    <div className="watch-course-list">
                      {search.preferences.map((preference) => (
                        <div className="watch-course-row" key={preference.id}>
                          <span className="course-rank-number">{preference.rank}</span>
                          <CourseImage name={preference.course.name} index={preference.rank - 1} />
                          <div className="watch-course-copy">
                            <strong>{preference.course.name}</strong>
                            <p className="meta">
                              <MapPin size={14} />
                              {getCompactLocation(preference.course.address)}
                            </p>
                          </div>
                          <div className="watch-course-links">
                            <a
                              href={getGoogleMapsSearchUrl(preference.course)}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Google Maps <ExternalLink size={13} />
                            </a>
                            {preference.course.detectedBookingUrl ?? preference.course.website ? (
                              <a
                                href={
                                  preference.course.detectedBookingUrl ??
                                  preference.course.website ??
                                  "#"
                                }
                                rel="noreferrer"
                                target="_blank"
                              >
                                Official site <ExternalLink size={13} />
                              </a>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="dashboard-panel dashboard-sidebar">
          <h2>Alert status</h2>
          <p className="meta">{alertStatusCopy}</p>
          <dl className="sidebar-stat-list">
            <div>
              <dt>Matches found</dt>
              <dd>{pendingMatches.length} so far</dd>
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
            We watch all your courses and only email you when something new opens up.
          </div>
          {pendingMatches.length > 0 ? (
            <div className="match-list">
              {pendingMatches.slice(0, 3).map((match) => (
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
          <Link className="button button-dark dashboard-add-search" href="/#start">
            <Bell size={17} />
            Add another search
          </Link>
        </aside>
      </div>
    </main>
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

function CourseImage({ index, name }: { index: number; name: string }) {
  const imageUrl = dashboardCourseImages[index % dashboardCourseImages.length];

  return (
    <div
      aria-hidden="true"
      className="dashboard-course-image"
      style={{ backgroundImage: `url("${imageUrl}")` }}
      title={name}
    >
      <span />
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
