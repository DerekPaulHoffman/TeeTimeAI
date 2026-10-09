"use client";

import { ChevronDown, LocateFixed, Search, X } from "lucide-react";
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
      className="figma-search-toolbar"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="figma-search-primary">
        <div className="figma-search-field figma-location-field">
          <label htmlFor="location">Location</label>
          <div className="figma-search-value">
            <span className="figma-search-value-icon" aria-hidden="true">
              📍
            </span>
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
            className="figma-use-location"
            disabled={loading}
            onClick={onSelectCurrentLocation}
            title="Use current location"
            type="button"
          >
            <LocateFixed size={15} />
          </button>
        </div>
        <label className="figma-search-field" htmlFor="players">
          <span>Players</span>
          <div className="figma-search-value">
            <span className="figma-search-value-icon" aria-hidden="true">
              🏌️
            </span>
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
        <div className="figma-search-field figma-date-field">
          <label htmlFor="date">
            <span className="figma-filter-label-icon" aria-hidden="true">📅</span>
            Date
          </label>
          <div className="figma-search-value">
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
      </div>
      <div className="figma-filter-strip">
        <div
          aria-label="Time window"
          aria-describedby="time-window-help"
          className="figma-search-field figma-time-field"
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
          <span className="figma-time-label">Time</span>
          <div className="figma-search-value">
            <span className="figma-search-value-icon" aria-hidden="true">
              ⏰
            </span>
            <button
              aria-controls="mobile-time-editor"
              aria-expanded={mobileTimeEditorOpen}
              className="figma-time-summary"
              ref={timeSummaryRef}
              onClick={() => onTimeEditorOpenChange(!mobileTimeEditorOpen)}
              type="button"
            >
              {formatCompactTimeWindow(startTime, endTime)}
            </button>
            <div
              className={`figma-time-inputs${mobileTimeEditorOpen ? " is-mobile-open" : ""}`}
              id="mobile-time-editor"
              aria-label="Choose time window"
              role="group"
            >
              <label className="figma-time-choice" htmlFor="startTime">
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
              <label className="figma-time-choice" htmlFor="endTime">
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
                className="figma-time-editor-done"
                disabled={!isTimeWindowValid}
                onClick={finishTimeSelection}
                type="button"
              >
                {isTimeWindowValid ? "Done" : "Choose a later end time"}
              </button>
            </div>
          </div>
          <span className="sr-only" id="time-window-help">
            Times use each course&apos;s local time zone.
          </span>
        </div>
        <div className={`figma-hole-filter${simulatorEnabled ? " has-simulator" : ""}`} aria-label="Course layout" role="group">
          <strong>
            <span className="figma-filter-label-icon" aria-hidden="true">⛳</span>
            <span className="figma-desktop-copy">Course layout</span>
            <span className="figma-mobile-copy">Holes</span>
          </strong>
          <div className="figma-hole-options">
            {(["any", "9", "18"] as const).map((value) => (
              <button
                aria-label={value === "any" ? "Any" : `${value}-hole`}
                aria-pressed={mode === "OUTDOOR" && holeFilter === value}
                className={mode === "OUTDOOR" && holeFilter === value ? "is-active" : ""}
                key={value}
                onClick={() => onHoleFilterChange(value)}
                type="button"
              >
                {value === "any" ? (
                  "Any"
                ) : (
                  <>
                    <span className="figma-desktop-copy">{value}-hole</span>
                    <span className="figma-mobile-copy">{value}H</span>
                  </>
                )}
              </button>
            ))}
            {simulatorEnabled ? (
              <button
                aria-pressed={mode === "SIMULATOR"}
                className={mode === "SIMULATOR" ? "is-active" : ""}
                onClick={() => onModeChange?.("SIMULATOR")}
                type="button"
              >
                Simulator
              </button>
            ) : null}
          </div>
        </div>
        <span className="figma-filter-divider" aria-hidden="true" />
        <div className="figma-distance-group">
          <div className="figma-distance-heading">
            <strong className="figma-distance-label">
              <span className="figma-filter-label-icon" aria-hidden="true">📏</span>
              Within
            </strong>
          </div>
          <label className="figma-distance-filter" htmlFor="searchRadius">
            <span>
              <em>{MIN_COURSE_SEARCH_RADIUS_MILES} mi</em>
              <b>
                <span className="figma-distance-prefix">within </span>
                {searchRadiusMiles} mi
              </b>
              <em>{MAX_COURSE_SEARCH_RADIUS_MILES} mi</em>
            </span>
            <input
              aria-label="Distance from me"
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
          </label>
        </div>
        <div className="figma-search-actions">
          <button
            className="figma-search-submit"
            disabled={loading}
            type="submit"
          >
            <Search size={15} />
            {loading ? "Searching" : "Search"}
          </button>
          {mode === "SIMULATOR" || holeFilter !== DEFAULT_COURSE_LAYOUT_FILTER ||
          searchRadiusMiles !== DEFAULT_COURSE_SEARCH_RADIUS_MILES ? (
            <button
              className="figma-reset-filters"
              onClick={onResetFilters}
              type="button"
            >
              <X size={10} />
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
