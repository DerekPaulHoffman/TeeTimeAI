"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
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
import { getGoogleMapsEmbedUrl, getGoogleMapsSearchUrl } from "@/lib/maps";
import type { CourseCandidate } from "@/lib/places/google";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search";

type Notice = {
  type: "info" | "success" | "error";
  message: string;
};

declare global {
  interface Window {
    google?: GoogleMapsWindow;
    initTeeTimeSpotCourseMap?: () => void;
  }
}

type GoogleMapsWindow = {
  maps: {
    LatLngBounds: new () => {
      extend(position: { lat: number; lng: number }): void;
    };
    Map: new (
      element: HTMLElement,
      options: {
        center: { lat: number; lng: number };
        clickableIcons?: boolean;
        mapTypeControl?: boolean;
        streetViewControl?: boolean;
        zoom: number;
      }
    ) => {
      fitBounds(bounds: unknown): void;
    };
    Marker: new (options: {
      label: string;
      map: unknown;
      position: { lat: number; lng: number };
      title: string;
    }) => unknown;
  };
};

const tomorrow = () => {
  return formatDateInputValue(addLocalDays(new Date(), 1));
};

const INITIAL_VISIBLE_COURSE_COUNT = 6;
const COURSE_REVEAL_INCREMENT = 6;
const COURSE_SEARCH_RADIUS_METERS = 50000;
type SearchCoordinates = { latitude: number; longitude: number };

export function TeeTimeIntake() {
  const [locationText, setLocationText] = useState("Trumbull, CT");
  const [alertEmail, setAlertEmail] = useState("");
  const [date, setDate] = useState(tomorrow());
  const [startTime, setStartTime] = useState("13:40");
  const [endTime, setEndTime] = useState("16:00");
  const [players, setPlayers] = useState(3);
  const [courses, setCourses] = useState<CourseCandidate[]>([]);
  const [searchCoordinates, setSearchCoordinates] = useState<SearchCoordinates | null>(null);
  const [visibleCourseCount, setVisibleCourseCount] = useState(INITIAL_VISIBLE_COURSE_COUNT);
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
  const visibleCourses = useMemo(
    () => courses.slice(0, visibleCourseCount),
    [courses, visibleCourseCount]
  );
  const hiddenCourseCount = Math.max(courses.length - visibleCourses.length, 0);
  const selectedCourseCount = selected.length;
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

  async function discoverCourses(coordinates: SearchCoordinates) {
    try {
      const params = new URLSearchParams({
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
        radiusMeters: String(COURSE_SEARCH_RADIUS_METERS)
      });
      const response = await fetch(`/api/courses/discover?${params}`);
      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as { courses: CourseCandidate[]; demo?: boolean };
      setSearchCoordinates(coordinates);
      setCourses(sortCoursesByDistance(data.courses));
      setVisibleCourseCount(INITIAL_VISIBLE_COURSE_COUNT);
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

  function showMoreCourses() {
    setVisibleCourseCount((current) =>
      Math.min(current + COURSE_REVEAL_INCREMENT, courses.length)
    );
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

        {courses.length > 0 ? (
          <div className="search-results-header">
            <div>
              <span className="eyebrow">Course results</span>
              <h3>Nearby public courses</h3>
            </div>
            <span className="results-count-pill">
              {selectedCourseCount}/5 selected
            </span>
          </div>
        ) : null}

        <CourseResultsMap courses={courses} origin={searchCoordinates} />

        <div className="course-list" role="list" aria-label="Nearby courses">
          {visibleCourses.map((course) => {
            const selectedIndex = selected.findIndex(
              (selectedCourse) => selectedCourse.googlePlaceId === course.googlePlaceId
            );
            const isSelected = selectedIndex >= 0;

            return (
              <div className="course-row" key={course.googlePlaceId} role="listitem">
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
                    {course.distanceMeters !== undefined ? (
                      <span className="mini-pill">
                        <MapPin size={13} />
                        {formatDistance(course.distanceMeters)}
                      </span>
                    ) : null}
                    {isSelected ? (
                      <span className="mini-pill selected-course-pill">
                        <Check size={13} />
                        Priority {selectedIndex + 1}
                      </span>
                    ) : null}
                  </div>
                  <h3>{course.name}</h3>
                  <CourseAddressLink course={course} />
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
                    disabled={isSelected}
                    title={isSelected ? `Priority ${selectedIndex + 1}` : "Add course"}
                  >
                    {isSelected ? <Check size={17} /> : <Plus size={17} />}
                    {isSelected ? "Added" : "Add"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {courses.length > INITIAL_VISIBLE_COURSE_COUNT ? (
          <div className="course-list-footer">
            <span>
              Showing {visibleCourses.length} of {courses.length} locations
            </span>
            {hiddenCourseCount > 0 ? (
              <button className="button button-ghost" type="button" onClick={showMoreCourses}>
                <Plus size={16} />
                See more locations
              </button>
            ) : null}
          </div>
        ) : null}
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
                  <CourseAddressLink course={course} unavailableText="Course address unavailable" />
                  {course.website ? (
                    <div className="selected-links">
                      <a
                        className="course-link"
                        href={course.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink size={14} />
                        Official course link
                      </a>
                    </div>
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

  if (!course.photoReference) {
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
      src={`/api/courses/photo?ref=${encodeURIComponent(course.photoReference)}`}
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

function CourseAddressLink({
  course,
  unavailableText = "Address unavailable"
}: {
  course: CourseCandidate;
  unavailableText?: string;
}) {
  if (!course.address) {
    return <p className="meta">{unavailableText}</p>;
  }

  return (
    <p className="meta">
      <a
        className="course-address-link"
        href={getGoogleMapsSearchUrl(course)}
        rel="noreferrer"
        target="_blank"
      >
        <MapPin size={14} />
        {course.address}
      </a>
    </p>
  );
}

function CourseResultsMap({
  courses,
  origin
}: {
  courses: CourseCandidate[];
  origin: SearchCoordinates | null;
}) {
  const mapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY;
  const mapId = "course-results-map";
  const mapCenter = useMemo(() => getCourseMapCenter(courses, origin), [courses, origin]);
  const mapMarkers = useMemo(() => getCourseMapMarkers(courses), [courses]);
  const courseSignature = useMemo(
    () =>
      courses
        .map((course) => `${course.googlePlaceId}:${course.latitude}:${course.longitude}`)
        .join("|"),
    [courses]
  );

  useEffect(() => {
    if (!mapsApiKey || courses.length === 0) {
      return;
    }

    window.initTeeTimeSpotCourseMap = () => {
      const element = document.getElementById(mapId);
      const googleMaps = window.google?.maps;
      if (!element || !googleMaps) {
        return;
      }

      const center = { lat: mapCenter.latitude, lng: mapCenter.longitude };
      const map = new googleMaps.Map(element, {
        center,
        clickableIcons: false,
        mapTypeControl: false,
        streetViewControl: false,
        zoom: 10
      });
      const bounds = new googleMaps.LatLngBounds();

      courses.forEach((course, index) => {
        const position = { lat: course.latitude, lng: course.longitude };
        bounds.extend(position);
        new googleMaps.Marker({
          label: String(index + 1),
          map,
          position,
          title: course.name
        });
      });

      if (courses.length > 1) {
        map.fitBounds(bounds);
      }
    };

    if (window.google?.maps) {
      window.initTeeTimeSpotCourseMap();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      "script[data-tee-time-spot-google-map]"
    );
    if (existingScript) {
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.dataset.teeTimeSpotGoogleMap = "true";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      mapsApiKey
    )}&callback=initTeeTimeSpotCourseMap`;
    document.head.appendChild(script);
  }, [courses, courseSignature, mapCenter.latitude, mapCenter.longitude, mapsApiKey]);

  if (courses.length === 0) {
    return null;
  }

  return (
    <div className="course-results-map-shell">
      {mapsApiKey ? (
        <div
          aria-label={`${courses.length} nearby course locations on Google Maps`}
          className="course-results-map"
          id={mapId}
          role="img"
        />
      ) : (
        <div
          aria-label={`${courses.length} nearby course locations on Google Maps`}
          className="course-results-map-embed"
          role="img"
        >
          <iframe
            className="course-results-map-frame"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            src={getGoogleMapsEmbedUrl(mapCenter)}
            title={`${courses.length} nearby course locations on Google Maps`}
          />
          <div className="course-results-map-overlay" aria-hidden="true">
            {mapMarkers.map((marker) => (
              <span
                className="course-results-map-pin"
                key={marker.id}
                style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
              >
                {marker.index}
              </span>
            ))}
          </div>
          <div className="course-results-map-count">
            <MapPinned size={16} />
            {courses.length} course locations found
          </div>
        </div>
      )}
    </div>
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

function sortCoursesByDistance(courses: CourseCandidate[]) {
  return [...courses].sort(
    (a, b) =>
      (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) -
      (b.distanceMeters ?? Number.MAX_SAFE_INTEGER)
  );
}

function formatDistance(distanceMeters: number) {
  const miles = distanceMeters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

function getCourseMapCenter(courses: CourseCandidate[], origin: SearchCoordinates | null) {
  if (origin) {
    return origin;
  }

  if (courses.length === 0) {
    return { latitude: 41.242, longitude: -73.209 };
  }

  return {
    latitude: courses.reduce((sum, course) => sum + course.latitude, 0) / courses.length,
    longitude: courses.reduce((sum, course) => sum + course.longitude, 0) / courses.length
  };
}

function getCourseMapMarkers(courses: CourseCandidate[]) {
  if (courses.length === 0) {
    return [];
  }

  const latitudes = courses.map((course) => course.latitude);
  const longitudes = courses.map((course) => course.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const latitudeSpan = Math.max(maxLatitude - minLatitude, 0.01);
  const longitudeSpan = Math.max(maxLongitude - minLongitude, 0.01);

  return courses.slice(0, 25).map((course, index) => ({
    id: course.googlePlaceId,
    index: index + 1,
    x: 8 + ((course.longitude - minLongitude) / longitudeSpan) * 84,
    y: 8 + ((maxLatitude - course.latitude) / latitudeSpan) * 84
  }));
}
