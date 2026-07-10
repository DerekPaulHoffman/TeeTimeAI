import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Check, CircleOff, Flag, Users } from "lucide-react";

import { confirmEmailAlertStop } from "./actions";
import { verifyEmailStopToken } from "@/lib/email/search-actions";
import { getEmailStopSearchSummary } from "@/lib/searches/email-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Manage email alert",
  description: "Stop a Tee Time Spot email alert.",
  robots: {
    index: false,
    follow: false
  }
};

type StopAlertPageProps = {
  searchParams: Promise<{
    token?: string;
    done?: string;
    invalid?: string;
  }>;
};

export default async function StopAlertPage({ searchParams }: StopAlertPageProps) {
  const params = await searchParams;

  if (params.done === "booked" || params.done === "cancelled") {
    return <StoppedState reason={params.done} />;
  }

  const action = params.token ? safelyVerifyToken(params.token) : null;
  if (!action || params.invalid) {
    return <InvalidState />;
  }

  const search = await getEmailStopSearchSummary(action.searchId);
  if (!search) {
    return <InvalidState />;
  }

  const alreadyStopped = search.status !== "ACTIVE" && search.status !== "PAUSED";
  const booked = action.reason === "booked";
  const courseNames = search.preferences.map((preference) => preference.course.name);

  return (
    <main className="email-action-page">
      <section className="email-action-panel" aria-labelledby="stop-alert-heading">
        <div className={`email-action-icon ${booked ? "is-booked" : "is-cancelled"}`}>
          {booked ? <Flag size={26} /> : <CircleOff size={26} />}
        </div>
        <p className="eyebrow email-action-eyebrow">Tee Time Spot alert controls</p>
        <h1 id="stop-alert-heading">
          {alreadyStopped
            ? "This alert is already off."
            : booked
              ? "Nice—did you book a tee time?"
              : "Cancel this tee-time alert?"}
        </h1>
        <p className="email-action-copy">
          {alreadyStopped
            ? "We are no longer checking or sending emails for this search."
            : booked
              ? "Confirm below and we’ll mark this search complete, stop checking, and stop every email for it."
              : "Confirm below and we’ll stop checking these courses and stop every email for this search."}
        </p>

        <div className="email-action-summary">
          <div>
            <CalendarDays size={18} />
            <span>{formatSearchDate(search.date)}</span>
          </div>
          <div>
            <Users size={18} />
            <span>
              {search.players} golfer{search.players === 1 ? "" : "s"} · {formatTime(search.startTime)}–
              {formatTime(search.endTime)}
            </span>
          </div>
          <p>{courseNames.join(", ")}</p>
        </div>

        {alreadyStopped ? (
          <Link className="button button-dark email-action-button" href="/">
            Back to Tee Time Spot
          </Link>
        ) : (
          <div className="email-action-buttons">
            <form action={confirmEmailAlertStop}>
              <input name="token" type="hidden" value={params.token} />
              <button
                className={`button email-action-button ${booked ? "button-primary" : "button-danger"}`}
                type="submit"
              >
                {booked ? "Yes, I booked—stop emails" : "Yes, cancel this alert"}
              </button>
            </form>
            <Link className="button button-ghost email-action-button" href="/dashboard">
              Keep this alert active
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

function StoppedState({ reason }: { reason: "booked" | "cancelled" }) {
  return (
    <main className="email-action-page">
      <section className="email-action-panel" aria-labelledby="alert-stopped-heading">
        <div className="email-action-icon is-success">
          <Check size={28} />
        </div>
        <p className="eyebrow email-action-eyebrow">Alert turned off</p>
        <h1 id="alert-stopped-heading">
          {reason === "booked" ? "Enjoy your round!" : "This alert is cancelled."}
        </h1>
        <p className="email-action-copy">
          We stopped the search and all future emails for it. You can start a new alert whenever
          you need one.
        </p>
        <Link className="button button-primary email-action-button" href="/search">
          Create another alert
        </Link>
      </section>
    </main>
  );
}

function InvalidState() {
  return (
    <main className="email-action-page">
      <section className="email-action-panel" aria-labelledby="invalid-alert-link-heading">
        <div className="email-action-icon is-cancelled">
          <CircleOff size={26} />
        </div>
        <p className="eyebrow email-action-eyebrow">Alert link unavailable</p>
        <h1 id="invalid-alert-link-heading">This link is invalid or has expired.</h1>
        <p className="email-action-copy">
          Open your dashboard to manage the alert, or use the controls in a newer Tee Time Spot
          email.
        </p>
        <Link className="button button-dark email-action-button" href="/dashboard">
          Open dashboard
        </Link>
      </section>
    </main>
  );
}

function safelyVerifyToken(token: string) {
  try {
    return verifyEmailStopToken(token);
  } catch {
    return null;
  }
}

function formatSearchDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York"
  });
}

function formatTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return new Date(2026, 0, 1, hours, minutes).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}
