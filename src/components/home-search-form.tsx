"use client";

import { LocateFixed, Search } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  addLocalDays,
  formatDateInputValue,
  getNextSaturdayDateInputValue
} from "@/lib/dates/local-date";
import {
  CURRENT_LOCATION_LABEL,
  LOCATION_INPUT_PLACEHOLDER
} from "@/lib/places/location-input";
import { DEFAULT_COURSE_SEARCH_RADIUS_MILES } from "@/lib/places/radius";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search";

type HoleFilter = "any" | "9" | "18";

function tomorrow() {
  return formatDateInputValue(addLocalDays(new Date(), 1));
}

export function HomeSearchForm() {
  const router = useRouter();
  const [location, setLocation] = useState("");
  const [email, setEmail] = useState("");
  const [players, setPlayers] = useState(4);
  const [date, setDate] = useState(getNextSaturdayDateInputValue);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [holes, setHoles] = useState<HoleFilter>("any");
  const [radius, setRadius] = useState(DEFAULT_COURSE_SEARCH_RADIUS_MILES);

  function searchUrl(extra?: Record<string, string>) {
    const params = new URLSearchParams({
      location,
      email,
      players: String(players),
      date,
      startTime,
      endTime,
      holes,
      radius: String(radius),
      ...extra
    });
    return `/search?${params}` as Route;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    router.push(searchUrl());
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      router.push(searchUrl());
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation(CURRENT_LOCATION_LABEL);
        router.push(
          searchUrl({
            location: CURRENT_LOCATION_LABEL,
            latitude: String(position.coords.latitude),
            longitude: String(position.coords.longitude)
          })
        );
      },
      () => router.push(searchUrl())
    );
  }

  const progress = ((radius - 1) / 49) * 100;

  return (
    <form className="home-search-form" onSubmit={submit}>
      <div className="home-form-row home-form-row-primary">
        <label>
          <span>Location</span>
          <input
            name="location"
            onChange={(event) => setLocation(event.target.value)}
            placeholder={LOCATION_INPUT_PLACEHOLDER}
            required
            value={location}
          />
        </label>
        <label>
          <span>Alert email</span>
          <input
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            type="email"
            value={email}
          />
        </label>
      </div>
      <div className="home-form-row home-form-row-details">
        <label>
          <span>Players</span>
          <select value={players} onChange={(event) => setPlayers(Number(event.target.value))}>
            {Array.from({ length: MAX_PLAYERS_PER_SEARCH }, (_, index) => index + 1).map((count) => (
              <option key={count} value={count}>
                {count} {count === 1 ? "player" : "players"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Date</span>
          <input min={tomorrow()} onChange={(event) => setDate(event.target.value)} type="date" value={date} />
        </label>
        <label>
          <span>Start time</span>
          <input onChange={(event) => setStartTime(event.target.value)} type="time" value={startTime} />
        </label>
        <label>
          <span>End time</span>
          <input onChange={(event) => setEndTime(event.target.value)} type="time" value={endTime} />
        </label>
      </div>
      <div className="home-form-filter-row">
        <div className="home-hole-filter" aria-label="Course layout">
          <strong>Course layout</strong>
          {(["any", "9", "18"] as const).map((value) => (
            <button
              aria-pressed={holes === value}
              className={holes === value ? "is-active" : ""}
              key={value}
              onClick={() => setHoles(value)}
              type="button"
            >
              {value === "any" ? "Any" : `${value}-hole`}
            </button>
          ))}
        </div>
        <span className="home-filter-divider" aria-hidden="true" />
        <label className="home-distance-filter">
          <strong>Distance from you</strong>
          <span><em>1 mi</em><b>within {radius} mi</b><em>50 mi</em></span>
          <input
            aria-label="Distance from me"
            max="50"
            min="1"
            onChange={(event) => setRadius(Number(event.target.value))}
            style={{
              background: `linear-gradient(to right, #18332b 0 ${progress}%, #d9e4df ${progress}% 100%)`
            }}
            type="range"
            value={radius}
          />
        </label>
      </div>
      <div className="home-form-actions">
        <button className="button button-dark" type="submit">
          <Search size={17} />
          Browse courses
        </button>
        <button className="button button-ghost" onClick={useMyLocation} type="button">
          <LocateFixed size={17} />
          Use my location
        </button>
        <p>
          Enter a city and state, ZIP code, or street address — or use your current
          location — to find courses near you.
        </p>
      </div>
    </form>
  );
}
