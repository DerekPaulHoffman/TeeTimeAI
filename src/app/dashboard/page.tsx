import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Bell, CalendarClock, CirclePause, ExternalLink, Play, ShieldAlert } from "lucide-react";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { listTeeSearchesForUser } from "@/lib/searches/service";
import { SearchStatusActions } from "@/components/search-status-actions";

export default async function DashboardPage() {
  if (!hasClerkConfig() || !hasDatabaseConfig()) {
    return <SetupState />;
  }

  const { userId } = await auth();
  if (!userId) {
    return <SignedOutState />;
  }

  const user = await getRequiredAppUser();
  const searches = await listTeeSearchesForUser(user.id);
  const activeCount = searches.filter((search) => search.status === "ACTIVE").length;
  const pendingMatches = searches.flatMap((search) =>
    search.matches.filter((match) => match.alertStatus === "PENDING")
  );

  return (
    <main className="dashboard-page">
      <div className="dashboard-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Watchlist dashboard
          </p>
          <h1>Your tee time searches</h1>
        </div>
        <Link className="button button-dark" href="/#start">
          <Bell size={17} />
          New search
        </Link>
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-panel">
          <h2>Active queue</h2>
          {searches.length === 0 ? (
            <div className="empty-state">
              <CalendarClock size={28} />
              <h3>No searches yet</h3>
              <p className="meta">
                Create a search from the homepage so the Codex automation has demand to poll.
              </p>
            </div>
          ) : (
            <div className="dashboard-list">
              {searches.map((search) => (
                <article className="dashboard-row" key={search.id}>
                  <div>
                    <span className={`status-pill ${search.status.toLowerCase()}`}>
                      {search.status === "ACTIVE" ? <Play size={13} /> : <CirclePause size={13} />}
                      {search.status}
                    </span>
                    <h3>
                      {search.date.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric"
                      })}{" "}
                      · {search.startTime}-{search.endTime}
                    </h3>
                    <p className="meta">
                      {search.players} players · checks every {search.cadenceMinutes} minutes ·{" "}
                      {search.preferences.length} ranked courses
                    </p>
                    <ol className="meta">
                      {search.preferences.map((preference) => (
                        <li key={preference.id}>
                          #{preference.rank} {preference.course.name}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <SearchStatusActions searchId={search.id} status={search.status} />
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="dashboard-panel">
          <h2>Automation state</h2>
          <p className="meta">
            {activeCount} active searches. {pendingMatches.length} pending match alerts.
          </p>
          <div className="match-list">
            {pendingMatches.slice(0, 5).map((match) => (
              <div className="match-row" key={match.id}>
                <div>
                  <h3>{match.course.name}</h3>
                  <p className="meta">
                    {match.startsAt.toLocaleString()} · {match.availableSpots} spots
                  </p>
                </div>
                <a className="button button-ghost" href={match.bookingUrl} target="_blank">
                  <ExternalLink size={16} />
                  Book
                </a>
              </div>
            ))}
          </div>
          <div className="alert alert-info">
            The POC records probes even when no tee time is found, matching the prior monitor
            pattern: separate per-course observations and only new matches trigger alerts.
          </div>
        </aside>
      </div>
    </main>
  );
}

function SetupState() {
  return (
    <main className="dashboard-page">
      <div className="empty-state">
        <ShieldAlert size={30} />
        <h1>Connect Clerk and Neon</h1>
        <p className="meta">
          The dashboard is ready, but full accounts and saved searches need Clerk keys,
          DATABASE_URL, and a Prisma migration.
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
        <p className="meta">Saved tee time searches are tied to a Clerk account.</p>
        <Link className="button button-dark" href="/#start">
          Back to search
        </Link>
      </div>
    </main>
  );
}
