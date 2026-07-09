"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CirclePause, Pencil, Play, Save, Trash2, X } from "lucide-react";

import {
  MAX_ADDITIONAL_ALERT_EMAILS,
  MAX_PLAYERS_PER_SEARCH
} from "@/lib/validation/search";

type SearchStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

export function SearchStatusActions({
  searchId,
  status,
  initialDate,
  initialStartTime,
  initialEndTime,
  initialPlayers,
  initialCadenceMinutes,
  initialAdditionalEmails
}: {
  searchId: string;
  status: SearchStatus;
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
  initialPlayers: number;
  initialCadenceMinutes: number;
  initialAdditionalEmails: string[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [localStatus, setLocalStatus] = useState(status);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    date: initialDate,
    startTime: initialStartTime,
    endTime: initialEndTime,
    players: initialPlayers,
    cadenceMinutes: initialCadenceMinutes,
    additionalEmails: initialAdditionalEmails.join("\n")
  });

  async function update(status: SearchStatus) {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/searches/${searchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });

    if (response.ok) {
      setLocalStatus(status);
      router.refresh();
    } else {
      setError(await readError(response, "Could not update search."));
    }
    setPending(false);
  }

  async function saveDetails() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/searches/${searchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        additionalEmails: parseAdditionalEmails(form.additionalEmails)
      })
    });

    if (response.ok) {
      setEditing(false);
      router.refresh();
    } else {
      setError(await readError(response, "Could not save changes."));
    }
    setPending(false);
  }

  async function removeSearch() {
    if (!window.confirm("Remove this search from the queue?")) {
      return;
    }

    setPending(true);
    setError(null);
    const response = await fetch(`/api/searches/${searchId}`, {
      method: "DELETE"
    });

    if (response.ok) {
      router.refresh();
    } else {
      setError(await readError(response, "Could not remove search."));
    }
    setPending(false);
  }

  return (
    <div className="search-actions">
      {editing ? (
        <div className="queue-edit-form">
          <label>
            Date
            <input
              type="date"
              value={form.date}
              onChange={(event) => setForm({ ...form, date: event.target.value })}
            />
          </label>
          <label>
            Start
            <input
              type="time"
              value={form.startTime}
              onChange={(event) => setForm({ ...form, startTime: event.target.value })}
            />
          </label>
          <label>
            End
            <input
              type="time"
              value={form.endTime}
              onChange={(event) => setForm({ ...form, endTime: event.target.value })}
            />
          </label>
          <label>
            Players
            <select
              value={form.players}
              onChange={(event) => setForm({ ...form, players: Number(event.target.value) })}
            >
              {Array.from({ length: MAX_PLAYERS_PER_SEARCH }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cadence
            <select
              value={form.cadenceMinutes}
              onChange={(event) =>
                setForm({ ...form, cadenceMinutes: Number(event.target.value) })
              }
            >
              {[15, 30, 60, 120].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min
                </option>
              ))}
            </select>
          </label>
          <label>
            Extra emails
            <textarea
              rows={3}
              value={form.additionalEmails}
              placeholder="friend@example.com"
              onChange={(event) =>
                setForm({ ...form, additionalEmails: event.target.value })
              }
            />
            <span className="field-hint">
              Up to {MAX_ADDITIONAL_ALERT_EMAILS} more recipients, one per line or comma.
            </span>
          </label>
          <div className="inline-actions">
            <button
              className="button button-dark"
              type="button"
              onClick={saveDetails}
              disabled={pending}
              title="Save search changes"
            >
              <Save size={16} />
              Save
            </button>
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
              title="Cancel editing"
            >
              <X size={16} />
              Close
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="inline-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setEditing(true)}
              disabled={pending}
              title="Edit search"
            >
              <Pencil size={16} />
              Edit
            </button>
            {localStatus === "ACTIVE" ? (
              <button
                className="button button-ghost"
                type="button"
                onClick={() => update("PAUSED")}
                disabled={pending}
                title="Pause search"
              >
                <CirclePause size={16} />
                Pause
              </button>
            ) : (
              <button
                className="button button-ghost"
                type="button"
                onClick={() => update("ACTIVE")}
                disabled={pending}
                title="Resume search"
              >
                <Play size={16} />
                Resume
              </button>
            )}
            <button
              className="button button-ghost"
              type="button"
              onClick={removeSearch}
              disabled={pending}
              title="Remove search"
            >
              <Trash2 size={16} />
              Remove
            </button>
          </div>
          {initialAdditionalEmails.length > 0 ? (
            <p className="meta recipient-count">
              {initialAdditionalEmails.length} extra recipient
              {initialAdditionalEmails.length === 1 ? "" : "s"}
            </p>
          ) : null}
        </>
      )}
      {error ? <p className="meta queue-action-error">{error}</p> : null}
    </div>
  );
}

function parseAdditionalEmails(value: string) {
  return value
    .split(/[\n,]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_ADDITIONAL_ALERT_EMAILS);
}

async function readError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}
