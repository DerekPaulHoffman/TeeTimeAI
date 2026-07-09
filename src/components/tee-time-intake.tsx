"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import {
  Bell,
  Check,
  ExternalLink,
  Flag,
  LocateFixed,
  MapPin,
  MapPinned,
  Plus,
  Search,
  Star,
  X
} from "lucide-react";

import { addLocalDays, formatDateInputValue } from "@/lib/dates/local-date";
import { trackWebsiteEvent } from "@/lib/engagement/client";
import type { CourseCandidate } from "@/lib/places/google";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search";

type Notice = {
  type: "info" | "success" | "error";
  message: string;
};

const tomorrow = () => {
  return formatDateInputValue(addLocalDays(new Date(), 1));
};

export function TeeTimeIntake() {
  const [locationText, setLocationText] = useState("Trumbull, CT");
  const [alertEmail, setAlertEmail] = useState("");
  const [date, setDate] = useState(tomorrow());
  const [startTime, setStartTime] = useState("13:40");
  const [endTime, setEndTime] = useState("16:00");
  const [players, setPlayers] = useState(3);
  const [courses, setCourses] = useState<CourseCandidate[]>([]);
  const [selected, setSelected] = useState<CourseCandidate[]>([]);
  const [notice, setNotice] = useState<Notice>({
    type: "info",
    message: "Enter a city or ZIP code, or use your current location."
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const minSearchDate = tomorrow();

  const selectedIds = useMemo(
    () => new Set(selected.map((course) => course.googlePlaceId)),
    [selected]
  );
  const searchSignature = useMemo(
    () =>
      JSON.stringify({
        alertEmail: alertEmail.trim().toLowerCase(),
        date,
        startTime,
        endTime,
        players,
        courses: selected.map((course, index) => ({
          placeId: course.googlePlaceId,
          rank: index + 1
        }))
      }),
    [alertEmail, date, endTime, players, selected, startTime]
  );
  const isCurrentSearchSaved = savedSignature === searchSignature;
  const isDateFuture = date >= minSearchDate;
  const isTimeWindowValid = endTime > startTime;
  const saveBlocker = !isDateFuture
    ? "Choose a future date for alerts."
    : !isTimeWindowValid
      ? "Choose an end time after the start time."
      : null;

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
    if (saveBlocker) {
      setNotice({ type: "error", message: saveBlocker });
      return;
    }

    if (!alertEmail.trim()) {
      setNotice({ type: "error", message: "Enter the email that should receive tee time alerts." });
      return;
    }

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
          alertEmail: alertEmail.trim(),
          courses: selected.map((course, index) => ({
            ...course,
            rank: index + 1
          }))
        })
      });

      if (!response.ok) {
        throw new Error("Could not save this search. Try again in a moment.");
      }

      setNotice({
        type: "success",
        message: "You're all set. We'll email you the moment a matching tee time opens up."
      });
      trackWebsiteEvent({
        name: "search_submitted",
        metadata: {
          selectedCourseCount: selected.length,
          players
        }
      });
      setSavedSignature(searchSignature);
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save this search. Try again in a moment."
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
            <label htmlFor="alertEmail">Alert email</label>
            <input
              id="alertEmail"
              type="email"
              value={alertEmail}
              onChange={(event) => setAlertEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="field">
            <label htmlFor="players">Players</label>
            <select
              id="players"
              value={players}
              onChange={(event) => setPlayers(Number(event.target.value))}
            >
              {Array.from({ length: MAX_PLAYERS_PER_SEARCH }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="date">Date</label>
            <input
              aria-invalid={!isDateFuture}
              aria-describedby={!isDateFuture ? "search-form-guidance" : undefined}
              id="date"
              min={minSearchDate}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
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
                aria-describedby={!isTimeWindowValid ? "search-form-guidance" : undefined}
                aria-invalid={!isTimeWindowValid}
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
              <CourseThumbnail course={course} />
              <div className="course-copy">
                <div className="course-badges">
                  <span className="mini-pill">
                    <Flag size={13} />
                    Public course
                  </span>
                  {course.rating ? (
                    <span className="mini-pill">
                      <Star size={13} />
                      {course.rating.toFixed(1)}
                    </span>
                  ) : null}
                </div>
                <h3>{course.name}</h3>
                <p className="meta">
                  {course.address ?? "Address unavailable"}
                </p>
                <PhotoCredit course={course} />
              </div>
              <div className="course-actions">
                {course.website ? (
                  <a
                    className="button button-ghost"
                    href={course.website}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink size={16} />
                    Site
                  </a>
                ) : null}
                <button
                  className="button button-dark"
                  type="button"
                  onClick={() => addCourse(course)}
                  disabled={selectedIds.has(course.googlePlaceId)}
                  title={selectedIds.has(course.googlePlaceId) ? "Already selected" : "Add course"}
                >
                  {selectedIds.has(course.googlePlaceId) ? <Check size={17} /> : <Plus size={17} />}
                  {selectedIds.has(course.googlePlaceId) ? "Added" : "Add"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <aside className="summary-panel">
        <MapPinned size={28} />
        <h2>Your favorite courses</h2>
        <p>Put your favorite at the top. We&apos;ll focus there first.</p>
        <div className="selected-list">
          {selected.length === 0 ? (
            <div className="selected-empty">
              <MapPin size={20} />
              <span>Add at least one course to start alerts.</span>
            </div>
          ) : (
            selected.map((course, index) => (
              <div className="selected-row selected-card" key={course.googlePlaceId}>
                <CourseThumbnail course={course} variant="compact" />
                <div className="selected-copy">
                  <span className="rank-badge">Priority #{index + 1}</span>
                  <h3>{course.name}</h3>
                  <p className="meta">{course.address ?? "Course address unavailable"}</p>
                  {course.website ? (
                    <a
                      className="course-link"
                      href={course.website}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink size={14} />
                      Official course link
                    </a>
                  ) : null}
                </div>
                <button
                  className="button button-secondary icon-button"
                  type="button"
                  onClick={() => removeCourse(course.googlePlaceId)}
                  title="Remove course"
                  aria-label={`Remove ${course.name}`}
                >
                  <X size={17} />
                </button>
              </div>
            ))
          )}
        </div>
        <button
          className="button button-primary"
          type="button"
          onClick={saveSearch}
          disabled={
            saving ||
            isCurrentSearchSaved ||
            Boolean(saveBlocker) ||
            selected.length === 0 ||
            !alertEmail.trim()
          }
          style={{ marginTop: 18, width: "100%" }}
        >
          {saving ? <Bell size={17} /> : isCurrentSearchSaved ? <Check size={17} /> : <Bell size={17} />}
          {saving ? "Starting alerts" : isCurrentSearchSaved ? "Search saved" : "Start getting alerts"}
        </button>
        <p className="helper" id="search-form-guidance">
          {saveBlocker ??
            "We'll email you as soon as a spot opens up. Sign in later to pause, edit, or cancel alerts."}
        </p>
      </aside>
    </div>
  );
}

function CourseThumbnail({
  course,
  variant = "default"
}: {
  course: CourseCandidate;
  variant?: "default" | "compact";
}) {
  const className =
    variant === "compact" ? "course-thumbnail course-thumbnail-compact" : "course-thumbnail";

  if (!course.photoName) {
    return (
      <div className={`${className} course-thumbnail-empty`} aria-hidden="true">
        <MapPinned size={22} />
      </div>
    );
  }

  return (
    <Image
      alt={`${course.name} course photo`}
      className={className}
      height={variant === "compact" ? 72 : 90}
      loading="lazy"
      src={`/api/courses/photo?name=${encodeURIComponent(course.photoName)}`}
      unoptimized
      width={variant === "compact" ? 96 : 120}
    />
  );
}

function PhotoCredit({ course }: { course: CourseCandidate }) {
  const attribution = course.photoAttributions?.find((credit) => credit.displayName);
  if (!attribution?.displayName) {
    return null;
  }

  const href = normalizeAttributionUri(attribution.uri);

  return (
    <p className="photo-credit">
      Photo:{" "}
      {href ? (
        <a href={href} rel="noreferrer" target="_blank">
          {attribution.displayName}
        </a>
      ) : (
        attribution.displayName
      )}
    </p>
  );
}

function Notice({ notice }: { notice: Notice }) {
  return (
    <div
      className={`alert alert-${notice.type}`}
      role={notice.type === "error" ? "alert" : "status"}
    >
      {notice.message}
    </div>
  );
}

function normalizeAttributionUri(uri?: string) {
  if (!uri) {
    return undefined;
  }

  return uri.startsWith("//") ? `https:${uri}` : uri;
}
