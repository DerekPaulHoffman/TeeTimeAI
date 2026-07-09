"use client";

import { type DragEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  CirclePause,
  GripVertical,
  Pencil,
  Play,
  Save,
  Trash2,
  X
} from "lucide-react";

import {
  MAX_ADDITIONAL_ALERT_EMAILS,
  MAX_PLAYERS_PER_SEARCH
} from "@/lib/validation/search";

type SearchStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
type CoursePreferenceFormValue = {
  courseName: string;
  id: string;
  rank: number;
};

export function SearchStatusActions({
  searchId,
  status,
  initialDate,
  initialStartTime,
  initialEndTime,
  initialPlayers,
  initialCadenceMinutes,
  initialAdditionalEmails,
  initialCoursePreferences
}: {
  searchId: string;
  status: SearchStatus;
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
  initialPlayers: number;
  initialCadenceMinutes: number;
  initialAdditionalEmails: string[];
  initialCoursePreferences: CoursePreferenceFormValue[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [localStatus, setLocalStatus] = useState(status);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggedPreferenceId, setDraggedPreferenceId] = useState<string | null>(null);
  const [dropTargetPreferenceId, setDropTargetPreferenceId] = useState<string | null>(null);
  const [form, setForm] = useState({
    date: initialDate,
    startTime: initialStartTime,
    endTime: initialEndTime,
    players: initialPlayers,
    cadenceMinutes: initialCadenceMinutes,
    additionalEmails: initialAdditionalEmails.join("\n"),
    coursePreferences: [...initialCoursePreferences].sort((a, b) => a.rank - b.rank)
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
        additionalEmails: parseAdditionalEmails(form.additionalEmails),
        coursePreferences: form.coursePreferences.map((preference, index) => ({
          id: preference.id,
          rank: index + 1
        }))
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

  function moveCoursePreference(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= form.coursePreferences.length) {
      return;
    }

    setForm((currentForm) => ({
      ...currentForm,
      coursePreferences: reorderCoursePreferences(
        currentForm.coursePreferences,
        index,
        nextIndex
      )
    }));
  }

  function startCourseDrag(
    event: DragEvent<HTMLDivElement>,
    preference: CoursePreferenceFormValue
  ) {
    if (pending) {
      event.preventDefault();
      return;
    }

    setDraggedPreferenceId(preference.id);
    setDropTargetPreferenceId(preference.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", preference.id);
  }

  function updateCourseDropTarget(
    event: DragEvent<HTMLDivElement>,
    preference: CoursePreferenceFormValue
  ) {
    if (!draggedPreferenceId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropTargetPreferenceId !== preference.id) {
      setDropTargetPreferenceId(preference.id);
    }
  }

  function dropCoursePreference(
    event: DragEvent<HTMLDivElement>,
    toPreference: CoursePreferenceFormValue
  ) {
    event.preventDefault();
    const fromPreferenceId = event.dataTransfer.getData("text/plain") || draggedPreferenceId;
    setDraggedPreferenceId(null);
    setDropTargetPreferenceId(null);

    if (!fromPreferenceId || fromPreferenceId === toPreference.id) {
      return;
    }

    setForm((currentForm) => {
      const fromIndex = currentForm.coursePreferences.findIndex(
        (preference) => preference.id === fromPreferenceId
      );
      const toIndex = currentForm.coursePreferences.findIndex(
        (preference) => preference.id === toPreference.id
      );

      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return currentForm;
      }

      return {
        ...currentForm,
        coursePreferences: reorderCoursePreferences(
          currentForm.coursePreferences,
          fromIndex,
          toIndex
        )
      };
    });
  }

  return (
    <div className={`search-actions${editing ? " is-editing" : ""}`}>
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
          {form.coursePreferences.length > 0 ? (
            <div className="queue-priority-editor">
              <div>
                <strong>Course priority</strong>
                <span className="field-hint">
                  Put the courses you care about most at the top.
                </span>
              </div>
              <div className="queue-priority-list" role="list">
                {form.coursePreferences.map((preference, index) => (
                  <div
                    aria-label={`Priority ${index + 1}: ${preference.courseName}`}
                    className={[
                      "queue-priority-row",
                      draggedPreferenceId === preference.id ? "is-dragging" : "",
                      dropTargetPreferenceId === preference.id ? "is-drop-target" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    draggable={!pending}
                    key={preference.id}
                    onDragEnd={() => {
                      setDraggedPreferenceId(null);
                      setDropTargetPreferenceId(null);
                    }}
                    onDragOver={(event) => updateCourseDropTarget(event, preference)}
                    onDragStart={(event) => startCourseDrag(event, preference)}
                    onDrop={(event) => dropCoursePreference(event, preference)}
                    role="listitem"
                    title="Drag to reorder"
                  >
                    <span className="queue-priority-drag-handle" aria-hidden="true">
                      <GripVertical size={16} />
                    </span>
                    <span className="course-rank-number">{index + 1}</span>
                    <span className="queue-priority-name">{preference.courseName}</span>
                    <div className="queue-priority-controls">
                      <button
                        aria-label={`Move ${preference.courseName} up`}
                        className="button button-ghost dashboard-icon-button"
                        disabled={pending || index === 0}
                        onClick={() => moveCoursePreference(index, -1)}
                        title={`Move ${preference.courseName} up`}
                        type="button"
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        aria-label={`Move ${preference.courseName} down`}
                        className="button button-ghost dashboard-icon-button"
                        disabled={pending || index === form.coursePreferences.length - 1}
                        onClick={() => moveCoursePreference(index, 1)}
                        title={`Move ${preference.courseName} down`}
                        type="button"
                      >
                        <ArrowDown size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
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
          <div className="inline-actions queue-edit-actions">
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
          <div className="inline-actions dashboard-action-row">
            <button
              className="button button-ghost dashboard-edit-button"
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
                className="button button-ghost dashboard-icon-button"
                type="button"
                onClick={() => update("PAUSED")}
                disabled={pending}
                aria-label="Pause search"
                title="Pause search"
              >
                <CirclePause size={16} />
              </button>
            ) : (
              <button
                className="button button-ghost dashboard-icon-button"
                type="button"
                onClick={() => update("ACTIVE")}
                disabled={pending}
                aria-label="Resume search"
                title="Resume search"
              >
                <Play size={16} />
              </button>
            )}
            <button
              className="button button-ghost dashboard-icon-button"
              type="button"
              onClick={removeSearch}
              disabled={pending}
              aria-label="Remove search"
              title="Remove search"
            >
              <Trash2 size={16} />
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

function reorderCoursePreferences(
  preferences: CoursePreferenceFormValue[],
  fromIndex: number,
  toIndex: number
) {
  const nextPreferences = [...preferences];
  const [movedPreference] = nextPreferences.splice(fromIndex, 1);
  if (!movedPreference) {
    return preferences;
  }

  nextPreferences.splice(toIndex, 0, movedPreference);
  return nextPreferences.map((preference, preferenceIndex) => ({
    ...preference,
    rank: preferenceIndex + 1
  }));
}

async function readError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}
