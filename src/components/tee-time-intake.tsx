"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GripVertical,
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
import { getGoogleMapsSearchUrl } from "@/lib/maps";
import type { CourseCandidate } from "@/lib/places/google";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search";

type Notice = {
  type: "info" | "success" | "error";
  message: string;
};

declare global {
  interface Window {
    gm_authFailure?: () => void;
    google?: GoogleMapsWindow;
    initTeeTimeSpotGoogleMaps?: () => void;
  }
}

type GoogleMapsWindow = {
  maps: GoogleMapsNamespace;
};

type GoogleMapsLatLng = { lat: number; lng: number };

type GoogleMapInstance = {
  fitBounds(bounds: unknown): void;
};

type GoogleMapsNamespace = {
  LatLngBounds: new () => {
    extend(position: GoogleMapsLatLng): void;
  };
  Map: new (
    element: HTMLElement,
    options: {
      center: GoogleMapsLatLng;
      clickableIcons?: boolean;
      fullscreenControl?: boolean;
      mapId?: string;
      mapTypeControl?: boolean;
      streetViewControl?: boolean;
      zoom: number;
    }
  ) => GoogleMapInstance;
  Marker: new (options: {
    label?: string;
    map: GoogleMapInstance;
    position: GoogleMapsLatLng;
    title: string;
  }) => GoogleMapsClassicMarker;
  InfoWindow: new (options: {
    ariaLabel?: string;
    content?: Node | string;
    maxWidth?: number;
  }) => {
    close(): void;
    open(options: {
      anchor?: GoogleMapsMarker;
      map: GoogleMapInstance;
      shouldFocus?: boolean;
    }): void;
    setContent(content: Node | string): void;
  };
  marker?: {
    AdvancedMarkerElement: new (options: {
      gmpClickable?: boolean;
      map: GoogleMapInstance;
      position: GoogleMapsLatLng;
      title: string;
    }) => GoogleMapsAdvancedMarker;
    PinElement: new (options: {
      background?: string;
      borderColor?: string;
      glyphColor?: string;
      glyphText?: string;
      scale?: number;
    }) => Node;
  };
};

type GoogleMapsAdvancedMarker = {
  append?: (child: Node) => void;
  addListener?: (eventName: string, handler: () => void) => { remove?: () => void };
  map?: GoogleMapInstance | null;
};

type GoogleMapsClassicMarker = {
  addListener?: (eventName: string, handler: () => void) => { remove?: () => void };
  setMap(map: GoogleMapInstance | null): void;
};

type GoogleMapsMarker = GoogleMapsAdvancedMarker | GoogleMapsClassicMarker;

const tomorrow = () => {
  return formatDateInputValue(addLocalDays(new Date(), 1));
};

const INITIAL_VISIBLE_COURSE_COUNT = 6;
const COURSE_REVEAL_INCREMENT = 6;
const COURSE_SEARCH_RADIUS_METERS = 50000;
const GOOGLE_MAPS_SCRIPT_CALLBACK = "initTeeTimeSpotGoogleMaps";
let googleMapsLoaderPromise: Promise<GoogleMapsNamespace> | null = null;

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
  const [draggedCourseId, setDraggedCourseId] = useState<string | null>(null);
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

  function moveSelectedCourse(placeId: string, direction: -1 | 1) {
    setSelected((current) => {
      const index = current.findIndex((course) => course.googlePlaceId === placeId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function reorderSelectedCourse(sourcePlaceId: string, targetPlaceId: string) {
    if (sourcePlaceId === targetPlaceId) {
      return;
    }

    setSelected((current) => {
      const sourceIndex = current.findIndex((course) => course.googlePlaceId === sourcePlaceId);
      const targetIndex = current.findIndex((course) => course.googlePlaceId === targetPlaceId);

      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
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
    <div className="intake-layout search-page-layout">
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
              <div
                className={isSelected ? "course-row course-row-selected" : "course-row"}
                key={course.googlePlaceId}
                role="listitem"
              >
                <CourseThumbnail course={course} />
                {isSelected ? <span className="course-rank-overlay">{selectedIndex + 1}</span> : null}
                <div className="course-copy">
                  <h3>{course.name}</h3>
                  <p className="figma-course-meta">
                    {course.distanceMeters !== undefined ? (
                      <span>{formatDistance(course.distanceMeters)}</span>
                    ) : null}
                    <span>18 holes</span>
                    <span>Par 72</span>
                    {course.rating ? (
                      <span>
                        <Star size={13} />
                        {course.rating.toFixed(1)}
                      </span>
                    ) : null}
                  </p>
                  <CourseAddressLink course={course} />
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
                    className={isSelected ? "figma-add-button is-added" : "figma-add-button"}
                    type="button"
                    onClick={() => addCourse(course)}
                    disabled={isSelected}
                    title={isSelected ? `Priority ${selectedIndex + 1}` : "Add course"}
                  >
                    {isSelected ? <Check size={13} /> : <Plus size={13} />}
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

      <aside className="summary-panel figma-selected-panel">
        <div className="figma-selected-header">
          <span className="figma-selected-icon">
            <MapPinned size={18} />
          </span>
          <h2>Your courses</h2>
          <span className="figma-count-pill">{selected.length}/5</span>
        </div>
        <p>Pick up to 5. Drag to rank them - #1 gets checked first.</p>
        <div className="selected-list">
          {selected.length === 0 ? (
            <div className="selected-empty">
              <MapPin size={20} />
              <span>Add at least one course to start alerts.</span>
            </div>
          ) : (
            selected.map((course, index) => (
              <div
                className={
                  draggedCourseId === course.googlePlaceId
                    ? "selected-row selected-card figma-selected-card is-dragging"
                    : "selected-row selected-card figma-selected-card"
                }
                draggable
                key={course.googlePlaceId}
                onDragEnd={() => setDraggedCourseId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={() => setDraggedCourseId(course.googlePlaceId)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedCourseId) {
                    reorderSelectedCourse(draggedCourseId, course.googlePlaceId);
                    setDraggedCourseId(null);
                  }
                }}
              >
                <GripVertical className="figma-drag-handle" size={16} />
                <span className="figma-selected-rank">{index + 1}</span>
                <CourseThumbnail course={course} variant="compact" />
                <div className="selected-copy">
                  <h3>{course.name}</h3>
                </div>
                <div className="figma-reorder-controls" aria-label={`Reorder ${course.name}`}>
                  <button
                    aria-label={`Move ${course.name} up`}
                    disabled={index === 0}
                    onClick={() => moveSelectedCourse(course.googlePlaceId, -1)}
                    type="button"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    aria-label={`Move ${course.name} down`}
                    disabled={index === selected.length - 1}
                    onClick={() => moveSelectedCourse(course.googlePlaceId, 1)}
                    type="button"
                  >
                    <ChevronDown size={15} />
                  </button>
                </div>
                <button
                  className="figma-remove-course"
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
      {selected.length > 0 ? (
        <div className="mobile-selection-bar">
          <span>{selected.length} {selected.length === 1 ? "course" : "courses"} selected</span>
          <a href="#search-form-guidance">Reorder</a>
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
          >
            Start alerts
          </button>
        </div>
      ) : null}
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
  const mapsApiKey = normalizeBrowserGoogleMapsApiKey(
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY
  );
  const mapsMapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim();
  const mapElementId = "course-results-map";
  const [mapLoadError, setMapLoadError] = useState(false);
  const mapCenter = useMemo(() => getCourseMapCenter(courses, origin), [courses, origin]);
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

    const apiKey = mapsApiKey;
    let isCancelled = false;
    let cleanupMarkers: (() => void) | undefined;
    const handleAuthFailure = () => {
      setMapLoadError(true);
    };
    window.gm_authFailure = handleAuthFailure;

    async function initializeMap() {
      const googleMaps = await loadGoogleMapsApi(apiKey);
      const advancedMarkers = googleMaps.marker;
      const element = document.getElementById(mapElementId);

      if (isCancelled || !element) {
        return;
      }

      const center = { lat: mapCenter.latitude, lng: mapCenter.longitude };
      const mapOptions = {
        center,
        clickableIcons: true,
        fullscreenControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        zoom: 10,
        ...(mapsMapId ? { mapId: mapsMapId } : {})
      };
      const map = new googleMaps.Map(element, {
        ...mapOptions
      });
      const bounds = new googleMaps.LatLngBounds();
      const infoWindow = new googleMaps.InfoWindow({
        ariaLabel: "Course details",
        maxWidth: 340
      });
      const markers: GoogleMapsMarker[] = [];
      const advancedMarkerApi =
        mapsMapId && advancedMarkers?.AdvancedMarkerElement && advancedMarkers.PinElement
          ? advancedMarkers
          : null;

      courses.forEach((course, index) => {
        const position = { lat: course.latitude, lng: course.longitude };
        bounds.extend(position);
        const marker = advancedMarkerApi
          ? createAdvancedCourseMarker(advancedMarkerApi, map, position, course.name, index)
          : new googleMaps.Marker({
              label: String(index + 1),
              map,
              position,
              title: `${index + 1}. ${course.name}`
            });

        marker.addListener?.("click", () => {
          infoWindow.setContent(createCourseMapInfoWindowContent(course));
          infoWindow.open({ anchor: marker, map, shouldFocus: false });
        });
        if (advancedMarkerApi) {
          marker.addListener?.("gmp-click", () => {
            infoWindow.setContent(createCourseMapInfoWindowContent(course));
            infoWindow.open({ anchor: marker, map, shouldFocus: false });
          });
        }
        markers.push(marker);
      });

      if (courses.length > 1) {
        map.fitBounds(bounds);
      }

      cleanupMarkers = () => {
        infoWindow.close();
        markers.forEach((marker) => {
          if ("setMap" in marker) {
            marker.setMap(null);
            return;
          }
          marker.map = null;
        });
      };
    }

    initializeMap().catch(() => {
      // The course list remains usable if Google Maps JS cannot initialize.
      setMapLoadError(true);
    });

    return () => {
      isCancelled = true;
      if (window.gm_authFailure === handleAuthFailure) {
        window.gm_authFailure = undefined;
      }
      cleanupMarkers?.();
    }
  }, [
    courses,
    courseSignature,
    mapCenter.latitude,
    mapCenter.longitude,
    mapsApiKey,
    mapsMapId
  ]);

  if (courses.length === 0) {
    return null;
  }

  return (
    <div className="course-results-map-shell">
      {mapsApiKey ? (
        mapLoadError ? (
          <CourseMapUnavailable message="Google Maps could not load. Check that Maps JavaScript API is enabled for the browser key." />
        ) : (
          <div
            aria-label={`${courses.length} nearby course locations on Google Maps`}
            className="course-results-map"
            id={mapElementId}
            role="region"
          />
        )
      ) : (
        <CourseMapUnavailable message="Google Maps needs a browser API key before course pins can render." />
      )}
      <div className="course-results-map-count">
        <MapPinned size={16} />
        {courses.length} course locations found
      </div>
    </div>
  );
}

function CourseMapUnavailable({ message }: { message: string }) {
  return (
    <div className="course-results-map-unavailable" role="note">
      <MapPinned size={26} />
      <div>
        <h3>Map unavailable</h3>
        <p>{message}</p>
      </div>
    </div>
  );
}

function createAdvancedCourseMarker(
  advancedMarkers: NonNullable<GoogleMapsNamespace["marker"]>,
  map: GoogleMapInstance,
  position: GoogleMapsLatLng,
  courseName: string,
  index: number
) {
  const pin = new advancedMarkers.PinElement({
    background: "#d93025",
    borderColor: "#ffffff",
    glyphColor: "#ffffff",
    glyphText: String(index + 1),
    scale: 1.18
  });
  const marker = new advancedMarkers.AdvancedMarkerElement({
    gmpClickable: true,
    map,
    position,
    title: `${index + 1}. ${courseName}`
  });

  marker.append?.(pin);
  return marker;
}

function loadGoogleMapsApi(apiKey: string) {
  if (window.google?.maps?.Map) {
    return Promise.resolve(window.google.maps);
  }

  if (googleMapsLoaderPromise) {
    return googleMapsLoaderPromise;
  }

  googleMapsLoaderPromise = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    window.initTeeTimeSpotGoogleMaps = () => {
      const googleMaps = window.google?.maps;
      if (googleMaps?.Map) {
        resolve(googleMaps);
        return;
      }
      reject(new Error("Google Maps JavaScript API loaded without maps support"));
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      "script[data-tee-time-spot-google-map]"
    );
    if (existingScript) {
      if (window.google?.maps?.Map) {
        resolve(window.google.maps);
        return;
      }
      existingScript.addEventListener(
        "load",
        () => {
          const googleMaps = window.google?.maps;
          if (googleMaps?.Map) {
            resolve(googleMaps);
            return;
          }
          reject(new Error("Google Maps JavaScript API loaded without maps support"));
        },
        { once: true }
      );
      existingScript.addEventListener("error", () => reject(new Error("Google Maps failed to load")), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.dataset.teeTimeSpotGoogleMap = "true";
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&v=weekly&libraries=marker&loading=async&callback=${GOOGLE_MAPS_SCRIPT_CALLBACK}`;
    document.head.appendChild(script);
  });

  return googleMapsLoaderPromise;
}

function normalizeBrowserGoogleMapsApiKey(apiKey?: string) {
  return apiKey?.replace(/^\uFEFF/, "").trim();
}

function createCourseMapInfoWindowContent(course: CourseCandidate) {
  const container = document.createElement("div");
  container.className = "course-map-info-window";

  const eyebrow = document.createElement("span");
  eyebrow.className = "course-map-info-eyebrow";
  eyebrow.textContent = "Golf course";
  container.appendChild(eyebrow);

  const heading = document.createElement("h3");
  heading.textContent = course.name;
  container.appendChild(heading);

  if (course.address) {
    const address = document.createElement("a");
    address.className = "course-map-info-address";
    address.href = getGoogleMapsSearchUrl(course);
    address.rel = "noreferrer";
    address.target = "_blank";
    address.textContent = course.address;
    container.appendChild(address);
  }

  const details = document.createElement("div");
  details.className = "course-map-info-meta";
  if (course.rating) {
    const rating = document.createElement("span");
    rating.textContent = `${course.rating.toFixed(1)} rating`;
    details.appendChild(rating);
  }
  if (course.distanceMeters !== undefined) {
    const distance = document.createElement("span");
    distance.textContent = formatDistance(course.distanceMeters);
    details.appendChild(distance);
  }
  if (details.childElementCount > 0) {
    container.appendChild(details);
  }

  const actions = document.createElement("div");
  actions.className = "course-map-info-actions";
  const mapsLink = document.createElement("a");
  mapsLink.className = "course-map-info-primary";
  mapsLink.href = getGoogleMapsSearchUrl(course);
  mapsLink.rel = "noreferrer";
  mapsLink.target = "_blank";
  mapsLink.textContent = "Open in Google Maps";
  actions.appendChild(mapsLink);

  if (course.website) {
    const websiteLink = document.createElement("a");
    websiteLink.className = "course-map-info-secondary";
    websiteLink.href = course.website;
    websiteLink.rel = "noreferrer";
    websiteLink.target = "_blank";
    websiteLink.textContent = "Course site";
    actions.appendChild(websiteLink);
  }

  container.appendChild(actions);
  return container;
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
