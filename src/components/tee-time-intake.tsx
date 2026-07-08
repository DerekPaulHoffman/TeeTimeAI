"use client";

import { useMemo, useState } from "react";
import { Bell, LocateFixed, MapPinned, Plus, Save, Search, X } from "lucide-react";

import type { CourseCandidate } from "@/lib/places/google";

type Notice = {
  type: "info" | "success" | "error";
  message: string;
};

const tomorrow = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
};

export function TeeTimeIntake() {
  const [locationText, setLocationText] = useState("Trumbull, CT");
  const [date, setDate] = useState(tomorrow());
  const [startTime, setStartTime] = useState("13:40");
  const [endTime, setEndTime] = useState("16:00");
  const [players, setPlayers] = useState(3);
  const [courses, setCourses] = useState<CourseCandidate[]>([]);
  const [selected, setSelected] = useState<CourseCandidate[]>([]);
  const [notice, setNotice] = useState<Notice>({
    type: "info",
    message: "Use your current location or type a city/ZIP to load nearby golf courses."
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedIds = useMemo(
    () => new Set(selected.map((course) => course.googlePlaceId)),
    [selected]
  );

  async function discoverByCurrentLocation() {
    if (!navigator.geolocation) {
      setNotice({ type: "error", message: "This browser does not support geolocation." });
      return;
    }

    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await discoverCourses({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      () => {
        setLoading(false);
        setNotice({
          type: "error",
          message: "Location access was blocked. Type a city or ZIP instead."
        });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function discoverByTypedLocation() {
    setLoading(true);
    try {
      const geocode = await fetch(`/api/location/geocode?q=${encodeURIComponent(locationText)}`);
      if (!geocode.ok) {
        throw new Error(await geocode.text());
      }
      const coordinates = (await geocode.json()) as { latitude: number; longitude: number };
      await discoverCourses(coordinates);
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Could not geocode that location."
      });
      setLoading(false);
    }
  }

  async function discoverCourses(coordinates: { latitude: number; longitude: number }) {
    try {
      const params = new URLSearchParams({
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
        radiusMeters: "30000"
      });
      const response = await fetch(`/api/courses/discover?${params}`);
      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as { courses: CourseCandidate[]; demo?: boolean };
      setCourses(data.courses);
      setNotice({
        type: "success",
        message: data.demo
          ? "Loaded demo courses. Add Google Places keys for live discovery."
          : `Found ${data.courses.length} nearby golf courses.`
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Could not load nearby courses."
      });
    } finally {
      setLoading(false);
    }
  }

  function addCourse(course: CourseCandidate) {
    if (selected.length >= 5) {
      setNotice({ type: "error", message: "You can prioritize up to 5 courses." });
      return;
    }

    if (selectedIds.has(course.googlePlaceId)) {
      return;
    }

    setSelected((current) => [...current, course]);
  }

  function removeCourse(placeId: string) {
    setSelected((current) => current.filter((course) => course.googlePlaceId !== placeId));
  }

  async function saveSearch() {
    setSaving(true);
    try {
      const response = await fetch("/api/searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          startTime,
          endTime,
          players,
          cadenceMinutes: 15,
          courses: selected.map((course, index) => ({
            ...course,
            rank: index + 1
          }))
        })
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setNotice({
        type: "success",
        message: "Search saved. The Codex loop can now pick it up from Postgres."
      });
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save this search. Confirm Clerk and Neon are configured."
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="intake-layout">
      <div className="workspace">
        <div className="control-grid">
          <div className="field">
            <label htmlFor="location">Location</label>
            <input
              id="location"
              value={locationText}
              onChange={(event) => setLocationText(event.target.value)}
              placeholder="City, state, or ZIP"
            />
          </div>
          <div className="field">
            <label htmlFor="players">Players</label>
            <select
              id="players"
              value={players}
              onChange={(event) => setPlayers(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="date">Date</label>
            <input id="date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div className="control-grid">
            <div className="field">
              <label htmlFor="startTime">Start</label>
              <input
                id="startTime"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="endTime">End</label>
              <input
                id="endTime"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="inline-actions" style={{ marginTop: 18 }}>
          <button className="button button-dark" type="button" onClick={discoverByTypedLocation} disabled={loading}>
            <Search size={17} />
            {loading ? "Searching" : "Find courses"}
          </button>
          <button className="button button-ghost" type="button" onClick={discoverByCurrentLocation} disabled={loading}>
            <LocateFixed size={17} />
            Use current location
          </button>
        </div>

        <Notice notice={notice} />

        <div className="course-list" aria-label="Nearby courses">
          {courses.map((course) => (
            <div className="course-row" key={course.googlePlaceId}>
              <div>
                <h3>{course.name}</h3>
                <p className="meta">
                  {course.address ?? "Address unavailable"}
                  {course.rating ? ` · ${course.rating.toFixed(1)} rating` : ""}
                </p>
              </div>
              <button
                className="button button-ghost"
                type="button"
                onClick={() => addCourse(course)}
                disabled={selectedIds.has(course.googlePlaceId)}
                title={selectedIds.has(course.googlePlaceId) ? "Already selected" : "Add course"}
              >
                <Plus size={17} />
                Add
              </button>
            </div>
          ))}
        </div>
      </div>

      <aside className="summary-panel">
        <MapPinned size={28} />
        <h2>Your ranked watchlist</h2>
        <p>Select 1 to 5 courses. Rank order controls which matches get surfaced first.</p>
        <div className="selected-list">
          {selected.map((course, index) => (
            <div className="selected-row" key={course.googlePlaceId}>
              <div>
                <span className="rank-badge">#{index + 1}</span>
                <h3>{course.name}</h3>
                <p className="meta">{course.address}</p>
              </div>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => removeCourse(course.googlePlaceId)}
                title="Remove course"
              >
                <X size={17} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="button button-primary"
          type="button"
          onClick={saveSearch}
          disabled={saving || selected.length === 0}
          style={{ marginTop: 18, width: "100%" }}
        >
          {saving ? <Bell size={17} /> : <Save size={17} />}
          {saving ? "Saving search" : "Save alert search"}
        </button>
        <p className="helper">
          Full saving requires Clerk, Neon Postgres, and Prisma migrations. Demo discovery
          still works locally before setup.
        </p>
      </aside>
    </div>
  );
}

function Notice({ notice }: { notice: Notice }) {
  return <div className={`alert alert-${notice.type}`}>{notice.message}</div>;
}
