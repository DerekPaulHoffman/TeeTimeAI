"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PendingRecoveryDemandView, RecoveryDemandView } from "@/lib/course-recovery/demand";

export function PendingCourseRequests({ demands }: { demands: PendingRecoveryDemandView[] }) {
  const router = useRouter();
  const snapshot = JSON.stringify(demands.map(({ id, revision, status }) => [id, revision, status]));
  const [outcomes, setOutcomes] = useState<{ snapshot: string; values: Record<string, RecoveryDemandView> }>({ snapshot, values: {} });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const currentOutcomes = outcomes.snapshot === snapshot ? outcomes.values : {};
  const visible = demands.filter((demand) => demand.status === "WAITING" &&
    (!currentOutcomes[demand.id] || currentOutcomes[demand.id].status === "WAITING"));

  async function cancel(demand: PendingRecoveryDemandView) {
    if (pendingId) return;
    setPendingId(demand.id);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/courses/recovery/${encodeURIComponent(demand.requestId)}/demand`, { method: "DELETE" });
      const body = await response.json().catch(() => null) as { demand?: RecoveryDemandView; error?: string } | null;
      if (!response.ok) {
        setError(response.status < 500 && typeof body?.error === "string" ? body.error :
          "We couldn't cancel this saved request right now. Refresh the dashboard and try again.");
        // Activation or an owner-account transition may have won the race.
        if ([400, 404, 409].includes(response.status)) router.refresh();
        return;
      }
      if (!body?.demand || body.demand.id !== demand.id || body.demand.status === "WAITING") {
        throw new Error("Cancellation could not be confirmed.");
      }
      const result = body.demand;
      setOutcomes((current) => ({ snapshot, values: {
        ...(current.snapshot === snapshot ? current.values : {}), [demand.id]: result
      } }));
      setMessage(result.status === "CANCELLED" ? `${demand.courseName}'s saved alert request was cancelled.` :
        result.status === "ACTIVATED" ? "This alert has already started. Refreshing your dashboard to show it." : result.message);
      router.refresh();
    } catch {
      setError("We couldn't confirm cancellation. Refresh the dashboard to check this saved request before trying again.");
    } finally { setPendingId(null); }
  }

  if (!demands.length && !message && !error) return null;
  return <section className="dashboard-panel pending-course-requests" aria-labelledby="pending-course-requests-title">
    <div className="panel-title-row">
      <h2 id="pending-course-requests-title">Pending course requests</h2>
      <span className="status-pill">{visible.length} saved</span>
    </div>
    <p className="meta">These requests are saved to your account while we verify the courses. They use alert slots and are not checking tee times yet. Browsing or correcting another course does not cancel them.</p>
    {visible.length ? <ul className="pending-course-request-list">
      {visible.map((demand) => <li className="pending-course-request-row" key={demand.id}>
        <div>
          <h3>{demand.courseName}</h3>
          <p>{demand.town}</p>
          <dl>
            <div><dt>Date</dt><dd>{formatRequestedDate(demand.date)}</dd></div>
            <div><dt>Time window</dt><dd>{formatRequestedTime(demand.startTime)} – {formatRequestedTime(demand.endTime)}</dd></div>
            <div><dt>Players</dt><dd>{demand.players}</dd></div>
          </dl>
        </div>
        <button className="button button-ghost" type="button" disabled={Boolean(pendingId)}
          onClick={() => void cancel(demand)} aria-label={`Cancel saved alert request for ${demand.courseName}`}>
          {pendingId === demand.id ? "Cancelling…" : "Cancel saved request"}
        </button>
      </li>)}
    </ul> : <p className="meta">No course requests are waiting for verification.</p>}
    {message ? <p className="pending-course-request-message" role="status">{message}</p> : null}
    {error ? <p className="pending-course-request-message" role="alert">{error}</p> : null}
    <div className="pending-course-request-refresh">
      <button className="button button-ghost" type="button" disabled={Boolean(pendingId)} onClick={() => router.refresh()}>Refresh dashboard</button>
    </div>
  </section>;
}

function formatRequestedDate(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function formatRequestedTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}
