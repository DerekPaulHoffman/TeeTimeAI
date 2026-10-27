"use client";

import { ChevronDown, Clock3, Flag, LocateFixed, MapPin, Monitor, Search, Users, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { AlertDatePicker } from "@/components/alert-date-picker";
import { LOCATION_INPUT_PLACEHOLDER } from "@/lib/places/location-input";
import {
  DEFAULT_COURSE_SEARCH_RADIUS_MILES,
  MAX_COURSE_SEARCH_RADIUS_MILES,
  MIN_COURSE_SEARCH_RADIUS_MILES
} from "@/lib/places/radius";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search-constraints";
import type { SearchMode } from "@/lib/searches/search-mode";
import { SIMULATOR_DURATION_OPTIONS_MINUTES } from "@/lib/searches/search-mode";
import styles from "./tee-time-search-controls.module.css";

export type CourseLayoutFilter = "any" | "9" | "18";
export const DEFAULT_COURSE_LAYOUT_FILTER: CourseLayoutFilter = "18";

const TIME_CHOICES = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

function timeChoiceLabel(value: string) {
  if (value === "24:00") return "Midnight";
  const [hours, minutes] = value.split(":");
  const hour = Number(hours);
  return `${hour % 12 || 12}:${minutes} ${hour >= 12 ? "PM" : "AM"}`;
}

export function formatCompactTimeWindow(startTime: string, endTime: string) {
  const parseTime = (value: string) => {
    const [hoursText = "0", minutes = "00"] = value.split(":");
    const hours = Number(hoursText);
    return {
      hours: hours % 12 || 12,
      minutes,
      period: hours % 24 >= 12 ? "PM" : "AM"
    };
  };
  const start = parseTime(startTime);
  const end = parseTime(endTime);

  if (start.period === end.period) {
    return `${start.hours}:${start.minutes} – ${end.hours}:${end.minutes} ${end.period}`;
  }

  const startLabel =
    start.minutes === "00" ? `${start.hours}` : `${start.hours}:${start.minutes}`;
  const endLabel =
    end.minutes === "00" ? `${end.hours}` : `${end.hours}:${end.minutes}`;
  return `${startLabel} ${start.period} – ${endLabel} ${end.period}`;
}

export function TeeTimeSearchControls({
  mode = "OUTDOOR",
  simulatorEnabled = false,
  onModeChange,
  durationMinutes = null,
  onDurationChange,
  date,
  endTime,
  holeFilter,
  isDateFuture,
  isTimeWindowValid,
  loading,
  locationErrorId,
  locationInputInvalid,
  locationText,
  minSearchDate,
  mobileTimeEditorOpen,
  onDateChange,
  onEndTimeChange,
  onHoleFilterChange,
  onLocationChange,
  onPlayersChange,
  onRadiusChange,
  onResetFilters,
  onSelectCurrentLocation,
  onStartTimeChange,
  onSubmit,
  onTimeEditorOpenChange,
  players,
  searchRadiusMiles,
  startTime
}: {
  mode?: SearchMode;
  simulatorEnabled?: boolean;
  onModeChange?: (value: SearchMode) => void;
  durationMinutes?: number | null;
  onDurationChange?: (value: number | null) => void;
  date: string;
  endTime: string;
  holeFilter: CourseLayoutFilter;
  isDateFuture: boolean;
  isTimeWindowValid: boolean;
  loading: boolean;
  locationErrorId: string;
  locationInputInvalid: boolean;
  locationText: string;
  minSearchDate: string;
  mobileTimeEditorOpen: boolean;
  onDateChange: (value: string) => void;
  onEndTimeChange: (value: string) => void;
  onHoleFilterChange: (value: CourseLayoutFilter) => void;
  onLocationChange: (value: string) => void;
  onPlayersChange: (value: number) => void;
  onRadiusChange: (value: number) => void;
  onResetFilters: () => void;
  onSelectCurrentLocation: () => void;
  onStartTimeChange: (value: string) => void;
  onSubmit: () => void;
  onTimeEditorOpenChange: (open: boolean) => void;
  players: number;
  searchRadiusMiles: number;
  startTime: string;
}) {
  const timeFieldRef = useRef<HTMLDivElement>(null);
  const timeSummaryRef = useRef<HTMLButtonElement>(null);
  const startTimeRef = useRef<HTMLSelectElement>(null);
  // Keep exact saved/prefilled minutes even when they aren't a quarter hour.
  const timeChoices = [...new Set([...TIME_CHOICES, "23:59", startTime, endTime, ...(mode === "SIMULATOR" ? ["24:00"] : [])])].sort();

  useEffect(() => {
    if (!mobileTimeEditorOpen) return;
    startTimeRef.current?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !timeFieldRef.current?.contains(event.target)) {
        onTimeEditorOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [mobileTimeEditorOpen, onTimeEditorOpenChange]);

  function finishTimeSelection() {
    onTimeEditorOpenChange(false);
    timeSummaryRef.current?.focus();
  }

  const radiusProgress =
    ((searchRadiusMiles - MIN_COURSE_SEARCH_RADIUS_MILES) /
      (MAX_COURSE_SEARCH_RADIUS_MILES - MIN_COURSE_SEARCH_RADIUS_MILES)) *
    100;

  return (
    <form
      aria-label="Course search filters"
      className={styles.toolbar}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className={styles.primary}>
        <div className={`${styles.field} ${styles.location}`} data-filter="location">
          <label htmlFor="location">Location</label>
          <div className={styles.value}>
            <MapPin aria-hidden="true" size={20} />
            <input
              aria-describedby={locationInputInvalid ? locationErrorId : undefined}
              aria-invalid={locationInputInvalid}
              id="location"
              value={locationText}
              onChange={(event) => onLocationChange(event.target.value)}
              placeholder={LOCATION_INPUT_PLACEHOLDER}
            />
          </div>
          <button
            aria-label="Use current location"
            className={styles.locate}
            disabled={loading}
            onClick={onSelectCurrentLocation}
            title="Use current location"
            type="button"
          >
            <LocateFixed size={15} />
          </button>
        </div>
        <div className={`${styles.field} ${styles.date}`} data-filter="date">
          <label htmlFor="date">
            Date
          </label>
          <div className={styles.dateValue}>
            <AlertDatePicker
              ariaLabel="Date"
              isInvalid={!isDateFuture}
              describedBy={!isDateFuture ? "search-form-guidance" : undefined}
              id="date"
              min={minSearchDate}
              value={date}
              onChange={onDateChange}
            />
          </div>
        </div>
        <div
          aria-label="Time window"
          aria-describedby="time-window-help"
          className={`${styles.field} ${styles.time}`}
          data-filter="time"
          ref={timeFieldRef}
          role="group"
          onBlur={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
              onTimeEditorOpenChange(false);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && mobileTimeEditorOpen) {
              event.preventDefault();
              finishTimeSelection();
            }
          }}
        >
          <span>Time</span>
          <div className={styles.value}>
            <Clock3 aria-hidden="true" size={20} />
            <button
              aria-controls="mobile-time-editor"
              aria-expanded={mobileTimeEditorOpen}
              className={styles.timeSummary}
              ref={timeSummaryRef}
              onClick={() => onTimeEditorOpenChange(!mobileTimeEditorOpen)}
              type="button"
            >
              {formatCompactTimeWindow(startTime, endTime)}
              <ChevronDown aria-hidden="true" size={15} />
            </button>
            <div
              className={styles.timeEditor}
              hidden={!mobileTimeEditorOpen}
              id="mobile-time-editor"
              aria-label="Choose time window"
              role="group"
            >
              <label className={styles.timeChoice} htmlFor="startTime">
                <span>From</span>
                <select
                  aria-label="From (start time)"
                  id="startTime"
                  ref={startTimeRef}
                  value={startTime}
                  onBlur={(event) => onStartTimeChange(event.currentTarget.value)}
                  onChange={(event) => onStartTimeChange(event.currentTarget.value)}
                >
                  {timeChoices.map((time) => (
                    <option disabled={time === "23:59" || time === "24:00"} key={time} value={time}>
                      {timeChoiceLabel(time)}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" size={14} />
              </label>
              <span aria-hidden="true">→</span>
              <label className={styles.timeChoice} htmlFor="endTime">
                <span>To</span>
                <select
                  aria-describedby={mode === "SIMULATOR"
                    ? (!isTimeWindowValid ? "search-form-guidance simulator-midnight-help" : "simulator-midnight-help")
                    : (!isTimeWindowValid ? "search-form-guidance" : undefined)}
                  aria-invalid={!isTimeWindowValid}
                  aria-label="To (end time)"
                  id="endTime"
                  value={endTime}
                  onBlur={(event) => onEndTimeChange(event.currentTarget.value)}
                  onChange={(event) => onEndTimeChange(event.currentTarget.value)}
                >
                  {timeChoices.map((time) => (
                    <option disabled={time <= startTime || (time === "24:00" && mode !== "SIMULATOR")} key={time} value={time}>
                      {timeChoiceLabel(time)}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" size={14} />
              </label>
              {mode === "SIMULATOR" ? (
                <span className="sr-only" id="simulator-midnight-help">
                  Midnight means the end of the selected date.
                </span>
              ) : null}
              <button
                className={styles.timeDone}
                disabled={!isTimeWindowValid}
                onClick={finishTimeSelection}
                type="button"
              >
                {isTimeWindowValid ? "Done" : "Choose a later end time"}
              </button>
            </div>
          </div>
          <span className="sr-only" id="time-window-help">
            Times use each {mode === "SIMULATOR" ? "venue" : "course"}&apos;s local time zone.
          </span>
        </div>
        <label className={`${styles.field} ${styles.players}`} data-filter="players" htmlFor="players">
          <span>Players</span>
          <div className={styles.value}>
            <Users aria-hidden="true" size={20} />
            <select
              id="players"
              value={players}
              onChange={(event) => onPlayersChange(Number(event.target.value))}
            >
              {Array.from(
                { length: MAX_PLAYERS_PER_SEARCH },
                (_, index) => index + 1
              ).map((count) => (
                <option key={count} value={count}>
                  {count} {count === 1 ? "player" : "players"}
                </option>
              ))}
            </select>
          </div>
        </label>
      </div>
      <div className={styles.secondary}>
        {simulatorEnabled ? (
          <div className={styles.filterGroup} aria-label="Venue type" role="group">
            <strong>Venue type</strong>
            <div className={styles.segments}>
              <button aria-pressed={mode === "OUTDOOR"} onClick={() => onModeChange?.("OUTDOOR")} type="button">
                <Flag aria-hidden="true" size={18} /> Golf
              </button>
              <button aria-pressed={mode === "SIMULATOR"} onClick={() => onModeChange?.("SIMULATOR")} type="button">
                <Monitor aria-hidden="true" size={18} /> Simulator
              </button>
            </div>
          </div>
        ) : null}
        {mode === "SIMULATOR" ? (
          <label className={styles.filterGroup} htmlFor="simulatorDuration">
            <strong>Number of hours</strong>
            <div className={styles.duration}>
              <Clock3 aria-hidden="true" size={18} />
              <select id="simulatorDuration" value={durationMinutes ?? "any"}
                onChange={event => onDurationChange?.(event.target.value === "any" ? null : Number(event.target.value))}>
                <option value="any">Any</option>
                {SIMULATOR_DURATION_OPTIONS_MINUTES.map(minutes => (
                  <option key={minutes} value={minutes}>{minutes / 60} {minutes === 60 ? "hour" : "hours"}</option>
                ))}
              </select>
            </div>
          </label>
        ) : (
          <div className={styles.filterGroup} aria-label="Course layout" role="group" data-filter="layout">
            <strong>Course layout</strong>
            <div className={styles.segments}>
              {(["any", "9", "18"] as const).map((value) => (
                <button
                  aria-label={value === "any" ? "Any" : `${value}-hole`}
                  aria-pressed={mode === "OUTDOOR" && holeFilter === value}
                  key={value}
                  onClick={() => onHoleFilterChange(value)}
                  type="button"
                >
                  {value === "any" ? "Any" : `${value}-hole`}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className={`${styles.filterGroup} ${styles.distance}`} data-filter="distance">
          <div className={styles.distanceHeading}>
            <label htmlFor="searchRadius">Within</label>
            <output aria-hidden="true" htmlFor="searchRadius">{searchRadiusMiles} mi</output>
          </div>
          <div className={styles.range}>
            <span>{MIN_COURSE_SEARCH_RADIUS_MILES} mi</span>
            <input
              aria-label="Distance from me"
              aria-valuetext={`${searchRadiusMiles} miles`}
              disabled={loading}
              id="searchRadius"
              max={MAX_COURSE_SEARCH_RADIUS_MILES}
              min={MIN_COURSE_SEARCH_RADIUS_MILES}
              step="5"
              type="range"
              value={searchRadiusMiles}
              onChange={(event) => onRadiusChange(Number(event.target.value))}
              style={{
                background: `linear-gradient(to right, #18332b 0 ${radiusProgress}%, #d9e4df ${radiusProgress}% 100%)`
              }}
            />
            <span>{MAX_COURSE_SEARCH_RADIUS_MILES} mi</span>
          </div>
        </div>
        <button
          className={styles.reset}
          disabled={(mode === "SIMULATOR" ? durationMinutes === null : holeFilter === DEFAULT_COURSE_LAYOUT_FILTER) &&
            searchRadiusMiles === DEFAULT_COURSE_SEARCH_RADIUS_MILES}
          onClick={onResetFilters}
          type="button"
        >
          <X size={10} />
          Clear
        </button>
      </div>
      <button className={styles.submit} disabled={loading} type="submit">
        <Search aria-hidden="true" size={19} />
        {loading ? "Searching…" : "Search"}
      </button>
    </form>
  );
}
