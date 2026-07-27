"use client";

import { LocateFixed, Search, X } from "lucide-react";
import type { SyntheticEvent } from "react";

import { LOCATION_INPUT_PLACEHOLDER } from "@/lib/places/location-input";
import {
  DEFAULT_COURSE_SEARCH_RADIUS_MILES,
  MAX_COURSE_SEARCH_RADIUS_MILES,
  MIN_COURSE_SEARCH_RADIUS_MILES
} from "@/lib/places/radius";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search";

export type CourseLayoutFilter = "any" | "9" | "18";

type TimeInputHandler = (event: SyntheticEvent<HTMLInputElement>) => void;

export function formatCompactTimeWindow(startTime: string, endTime: string) {
  const parseTime = (value: string) => {
    const [hoursText = "0", minutes = "00"] = value.split(":");
    const hours = Number(hoursText);
    return {
      hours: hours % 12 || 12,
      minutes,
      period: hours >= 12 ? "PM" : "AM"
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
  onDateInput,
  onEndTimeInput,
  onHoleFilterChange,
  onLocationChange,
  onPlayersChange,
  onRadiusChange,
  onResetFilters,
  onSelectCurrentLocation,
  onStartTimeInput,
  onSubmit,
  onTimeEditorOpenChange,
  players,
  searchRadiusMiles,
  startTime
}: {
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
  onDateInput: TimeInputHandler;
  onEndTimeInput: TimeInputHandler;
  onHoleFilterChange: (value: CourseLayoutFilter) => void;
  onLocationChange: (value: string) => void;
  onPlayersChange: (value: number) => void;
  onRadiusChange: (value: number) => void;
  onResetFilters: () => void;
  onSelectCurrentLocation: () => void;
  onStartTimeInput: TimeInputHandler;
  onSubmit: () => void;
  onTimeEditorOpenChange: (open: boolean) => void;
  players: number;
  searchRadiusMiles: number;
  startTime: string;
}) {
  const radiusProgress =
    ((searchRadiusMiles - MIN_COURSE_SEARCH_RADIUS_MILES) /
      (MAX_COURSE_SEARCH_RADIUS_MILES - MIN_COURSE_SEARCH_RADIUS_MILES)) *
    100;

  return (
    <form
      aria-label="Course search filters"
      className="figma-search-toolbar"
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
        <label className="figma-search-field" htmlFor="date">
          <span>Date</span>
          <div className="figma-search-value">
            <span className="figma-search-value-icon" aria-hidden="true">
              📅
            </span>
            <input
              aria-invalid={!isDateFuture}
              aria-describedby={!isDateFuture ? "search-form-guidance" : undefined}
              id="date"
              min={minSearchDate}
              type="date"
              value={date}
              onBlur={onDateInput}
              onChange={onDateInput}
              onInput={onDateInput}
            />
          </div>
        </label>
      </div>
      <div className="figma-filter-strip">
        <div
          aria-label="Time window"
          aria-describedby="time-window-help"
          className="figma-search-field figma-time-field"
          role="group"
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
              onClick={() => onTimeEditorOpenChange(!mobileTimeEditorOpen)}
              type="button"
            >
              {formatCompactTimeWindow(startTime, endTime)}
            </button>
            <div
              className={`figma-time-inputs${mobileTimeEditorOpen ? " is-mobile-open" : ""}`}
              id="mobile-time-editor"
            >
              <input
                aria-label="Start time"
                id="startTime"
                type="time"
                value={startTime}
                onBlur={onStartTimeInput}
                onChange={onStartTimeInput}
                onInput={onStartTimeInput}
              />
              <span aria-hidden="true">–</span>
              <input
                aria-describedby={
                  !isTimeWindowValid ? "search-form-guidance" : undefined
                }
                aria-invalid={!isTimeWindowValid}
                aria-label="End time"
                id="endTime"
                type="time"
                value={endTime}
                onBlur={onEndTimeInput}
                onChange={onEndTimeInput}
                onInput={onEndTimeInput}
              />
              <button
                className="figma-time-editor-done"
                onClick={() => onTimeEditorOpenChange(false)}
                type="button"
              >
                Done
              </button>
            </div>
          </div>
          <span className="sr-only" id="time-window-help">
            Times use each course&apos;s local time zone.
          </span>
        </div>
        <div className="figma-hole-filter" aria-label="Course layout" role="group">
          <strong>
            <span className="figma-desktop-copy">Course layout</span>
            <span className="figma-mobile-copy">Holes</span>
          </strong>
          <div className="figma-hole-options">
            {(["any", "9", "18"] as const).map((value) => (
              <button
                aria-label={value === "any" ? "Any" : `${value}-hole`}
                aria-pressed={holeFilter === value}
                className={holeFilter === value ? "is-active" : ""}
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
          </div>
        </div>
        <span className="figma-filter-divider" aria-hidden="true" />
        <div className="figma-distance-group">
          <div className="figma-distance-heading">
            <strong className="figma-distance-label">Within</strong>
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
          {holeFilter !== "any" ||
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
        <button
          className="figma-search-submit"
          disabled={loading || locationText.trim().length === 0}
          type="submit"
        >
          <Search size={15} />
          {loading ? "Searching" : "Search"}
        </button>
      </div>
    </form>
  );
}
