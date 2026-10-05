"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bell, ExternalLink, Search, X } from "lucide-react";
import { DeferredSignInButton } from "@/components/deferred-sign-in-button";
import { TeeTimeSearchControls } from "@/components/tee-time-search-controls";
import type { CourseCandidate } from "@/lib/places/google";
import { DEFAULT_COURSE_SEARCH_RADIUS_MILES, milesToMeters } from "@/lib/places/radius";
import { getNextSaturdayDateInputValue, getMinimumSearchDateInputValue } from "@/lib/dates/local-date";
import { WEBSITE_TRAFFIC_CLASS_HEADER, detectWebsiteTrafficClass } from "@/lib/engagement/traffic-class";
import type { TeeTimeIntakeInitialValues } from "@/components/tee-time-intake";
import { assertSimulatorSessionFitsWindow } from "@/lib/searches/simulator-window";

const DRAFT_KEY = "tee-time-spot:simulator-draft:v1";
type Coordinates = { latitude: number; longitude: number };
type SimulatorDraft = { location: string; date: string; startTime: string; endTime: string; players: number; durationMinutes: number; radius: number };
type StoredSimulatorDraft = Partial<SimulatorDraft> & { selectedVenues?: CourseCandidate[]; coordinates?: Coordinates };

function restoredSimulatorVenues(value: unknown): CourseCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((venue): venue is CourseCandidate => {
    if (!venue || typeof venue !== "object" || venue.mode !== "SIMULATOR" || typeof venue.offeringId !== "string" ||
      typeof venue.googlePlaceId !== "string" || typeof venue.name !== "string" || typeof venue.timeZone !== "string" ||
      !Number.isFinite(venue.latitude) || !Number.isFinite(venue.longitude) || seen.has(venue.offeringId)) return false;
    seen.add(venue.offeringId); return true;
  }).slice(0, 5).map(venue => ({ ...venue, monitoringReadiness: "VERIFYING", monitoringSupport: "UNCONFIRMED" }));
}

export function simulatorSelectionProblem(venue: CourseCandidate, players: number, durationMinutes: number) {
  if (venue.mode !== "SIMULATOR" || !venue.offeringId || venue.publicAccessStatus !== "PUBLIC") return "Simulator rental verification pending";
  if (!venue.maxPartySize || venue.maxPartySize < players) return venue.maxPartySize ? `Up to ${venue.maxPartySize} players per bay` : "Bay capacity verification pending";
  if (!venue.supportedDurationsMinutes?.includes(durationMinutes)) return "This session duration is not available here";
  return null;
}

function officialHref(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function SimulatorIntake({ initialValues, accountEnabled, accountSignedIn, accountEmail, clerkPublishableKey, preserveInitialValues = false, onSharedValuesChange }: {
  initialValues: TeeTimeIntakeInitialValues;
  accountEnabled: boolean;
  accountSignedIn: boolean;
  accountEmail?: string;
  clerkPublishableKey?: string;
  preserveInitialValues?: boolean;
  onSharedValuesChange?: (values: TeeTimeIntakeInitialValues) => void;
}) {
  const [form, setForm] = useState<SimulatorDraft>({
    location: initialValues.location ?? "", date: initialValues.date ?? getNextSaturdayDateInputValue(),
    startTime: initialValues.startTime ?? "09:00", endTime: initialValues.endTime ?? "18:00",
    players: initialValues.players ?? 4, durationMinutes: initialValues.durationMinutes ?? 60,
    radius: initialValues.radius ?? DEFAULT_COURSE_SEARCH_RADIUS_MILES
  });
  const [draftReady, setDraftReady] = useState(false);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(initialValues.coordinates ?? null);
  const [venues, setVenues] = useState<CourseCandidate[]>([]);
  const [selected, setSelected] = useState<CourseCandidate[]>([]);
  const [lookup, setLookup] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobileTimeEditorOpen, setMobileTimeEditorOpen] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const restoreInitial = useRef({ initialValues, preserveInitialValues });

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
    const { initialValues, preserveInitialValues } = restoreInitial.current;
    try {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as StoredSimulatorDraft | null;
      if (draft && typeof draft.location === "string" && /^\d{4}-\d{2}-\d{2}$/.test(draft.date ?? "") &&
        /^\d{2}:\d{2}$/.test(draft.startTime ?? "") && /^\d{2}:\d{2}$/.test(draft.endTime ?? "") &&
        Number.isInteger(draft.players) && Number(draft.players) >= 1 && Number(draft.players) <= 8 &&
        [60, 90, 120, 180].includes(Number(draft.durationMinutes)) &&
        Number(draft.radius) >= 5 && Number(draft.radius) <= 30) {
        setForm({ ...draft as SimulatorDraft, ...(preserveInitialValues ? {
          location: initialValues.location ?? "", date: initialValues.date ?? getNextSaturdayDateInputValue(),
          startTime: initialValues.startTime ?? "09:00", endTime: initialValues.endTime ?? "18:00", radius: initialValues.radius ?? DEFAULT_COURSE_SEARCH_RADIUS_MILES
        } : {}) });
        setSelected(restoredSimulatorVenues(draft.selectedVenues));
        if (!preserveInitialValues && draft.coordinates && Number.isFinite(draft.coordinates.latitude) && Number.isFinite(draft.coordinates.longitude)) setCoordinates(draft.coordinates);
      }
    } catch { /* Storage is optional. */ }
    setDraftReady(true);
    });
    return () => { window.cancelAnimationFrame(animationFrame); request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!draftReady) return;
    if (savedId) return;
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...form, selectedVenues: selected, coordinates })); } catch { /* Storage is optional. */ }
  }, [form, selected, coordinates, draftReady, savedId]);
  useEffect(() => {
    if (draftReady) onSharedValuesChange?.({ location: form.location, date: form.date, startTime: form.startTime, endTime: form.endTime, radius: form.radius, coordinates: coordinates ?? undefined });
  }, [form, coordinates, draftReady, onSharedValuesChange]);

  function update<K extends keyof SimulatorDraft>(key: K, value: SimulatorDraft[K]) {
    setForm(current => ({ ...current, [key]: value }));
    if (key === "location") { request.current?.abort(); setCoordinates(null); setLoading(false); }
    setSavedId(null);
  }
  const minimumDate = getMinimumSearchDateInputValue(new Date(), selected.map(venue => venue.timeZone));
  let fullSessionFits = false;
  try {
    assertSimulatorSessionFitsWindow({ ...form, timeZones: selected.length ? selected.map(venue => venue.timeZone) : ["America/New_York"] });
    fullSessionFits = true;
  } catch { /* The UI and server require the same complete venue-local interval. */ }
  const selectionProblem = selected.map(venue => simulatorSelectionProblem(venue, form.players, form.durationMinutes)).find(Boolean);
  const canSave = selected.length > 0 && fullSessionFits && form.date >= minimumDate && !selectionProblem;

  async function discover(explicitCoordinates?: Coordinates, query?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError(""); setNotice("");
    try {
      let center = explicitCoordinates ?? coordinates;
      if (!query && !center) {
        const response = await fetch(`/api/location/geocode?q=${encodeURIComponent(form.location.trim())}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Could not find that location. Try a city and state or ZIP code.");
        const geocode = await response.json() as Coordinates;
        center = { latitude: geocode.latitude, longitude: geocode.longitude };
      }
      const params = new URLSearchParams({ mode: "SIMULATOR" });
      if (center) { params.set("latitude", String(center.latitude)); params.set("longitude", String(center.longitude)); }
      if (query) params.set("q", query);
      else params.set("radiusMeters", String(milesToMeters(form.radius)));
      const response = await fetch(`/api/courses/${query ? "lookup" : "discover"}?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Could not load simulator venues. Please try again.");
      const data = await response.json() as { courses: CourseCandidate[] };
      if (controller.signal.aborted) return;
      const results = data.courses.filter(venue => venue.mode === "SIMULATOR");
      setCoordinates(center);
      setVenues(results);
      setSelected(current => current.map(choice => results.find(venue => venue.offeringId === choice.offeringId) ?? choice));
      setNotice(results.length ? `Found ${results.length} simulator ${results.length === 1 ? "venue" : "venues"}.` : "No simulator venues found yet. Try a venue name and town.");
      if (query && results.length === 0) {
        void fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json", [WEBSITE_TRAFFIC_CLASS_HEADER]: detectWebsiteTrafficClass() }, body: JSON.stringify({ sentiment: "broken", message: `[COURSE_LOOKUP_MISS] mode=SIMULATOR query=${query.slice(0, 200)}`, page: "/search" }) }).catch(() => {});
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load venues.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function useLocation() {
    if (!navigator.geolocation) { setError("Location is unavailable. Enter a city and state or ZIP code."); return; }
    navigator.geolocation.getCurrentPosition(position => {
      update("location", "Current location");
      void discover({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, () => setError("Enter a city and state or ZIP code to search."));
  }
  function move(index: number, delta: number) {
    setSelected(current => {
      const next = [...current]; const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSavedId(null);
  }
  async function save() {
    if (!accountSignedIn || !canSave || saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/searches", {
        method: "POST", headers: { "Content-Type": "application/json", [WEBSITE_TRAFFIC_CLASS_HEADER]: detectWebsiteTrafficClass() },
        body: JSON.stringify({ mode: "SIMULATOR", durationMinutes: form.durationMinutes,
          date: form.date, startTime: form.startTime, endTime: form.endTime,
          players: form.players, userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
          additionalEmails: [], requestedLayoutHoles: null,
          courses: selected.map((venue, index) => ({ ...venue, rank: index + 1 })) })
      });
      if (!response.ok) throw new Error("Could not save this simulator alert. Check your selections and try again.");
      const data = await response.json() as { search: { id: string } };
      setSavedId(data.search.id);
      setNotice("Simulator alert saved. We'll check your selected venues and show the result in My alerts.");
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Storage is optional. */ }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save this alert."); }
    finally { setSaving(false); }
  }

  return <div className="simulator-intake">
    <p className="simulator-introduction">Find one simulator bay for your group and session. Matching openings link to the official site. You book direct.</p>
    <TeeTimeSearchControls mode="SIMULATOR" durationMinutes={form.durationMinutes} onDurationChange={value => update("durationMinutes", value)}
      date={form.date} endTime={form.endTime} startTime={form.startTime} players={form.players} holeFilter="any"
      isDateFuture={form.date >= minimumDate} isTimeWindowValid={fullSessionFits} loading={loading}
      locationErrorId="simulator-location-error" locationInputInvalid={false} locationText={form.location}
      minSearchDate={minimumDate} mobileTimeEditorOpen={mobileTimeEditorOpen} searchRadiusMiles={form.radius}
      onDateChange={value => update("date", value)} onEndTimeChange={value => update("endTime", value)} onStartTimeChange={value => update("startTime", value)}
      onHoleFilterChange={() => {}} onLocationChange={value => { update("location", value); setCoordinates(null); }}
      onPlayersChange={value => update("players", value)} onRadiusChange={value => update("radius", value)}
      onResetFilters={() => { update("radius", DEFAULT_COURSE_SEARCH_RADIUS_MILES); update("durationMinutes", 60); }}
      onSelectCurrentLocation={useLocation} onSubmit={() => void discover()} onTimeEditorOpenChange={setMobileTimeEditorOpen} />
    {!fullSessionFits ? <p role="alert">Choose a window long enough for the full {form.durationMinutes}-minute session.</p> : null}
    <form className="simulator-lookup" onSubmit={event => { event.preventDefault(); if (lookup.trim().length >= 2) void discover(undefined, lookup.trim()); }}>
      <label htmlFor="simulator-name">Find a simulator venue by name and town</label>
      <div><input id="simulator-name" value={lookup} onChange={event => setLookup(event.target.value)} placeholder="Venue name and town" maxLength={200} />
        <button className="button button-secondary" disabled={loading || lookup.trim().length < 2}><Search size={16} />Find venue</button></div>
    </form>
    {error ? <p role="alert" className="simulator-error">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="simulator-workspace">
      <section aria-label="Simulator venues" className="simulator-venues">
        {venues.map(venue => {
          const problem = simulatorSelectionProblem(venue, form.players, form.durationMinutes);
          const isSelected = selected.some(choice => choice.offeringId === venue.offeringId && choice.googlePlaceId === venue.googlePlaceId);
          const href = officialHref(venue.website);
          return <article className="simulator-venue" key={venue.googlePlaceId}>
            <div><h2>{venue.name}</h2><p>{venue.address}</p>
              <p>{venue.maxPartySize ? `Up to ${venue.maxPartySize} players per bay · ` : ""}{venue.supportedDurationsMinutes?.length ? `${venue.supportedDurationsMinutes.join(", ")} minute sessions` : "Rental details being verified"}</p>
              <p>{problem ?? (venue.monitoringReadiness === "READY" ? "Automatic alerts supported" : "Monitoring verdict after the first check")}</p></div>
            <div className="simulator-venue-actions">
              {href ? <a href={href} target="_blank" rel="noreferrer">Official simulator page <ExternalLink size={14} /></a> : null}
              <button className="button button-secondary" type="button" disabled={Boolean(problem) || isSelected || selected.length >= 5}
                onClick={() => { setSelected(current => [...current, venue]); setSavedId(null); }}>{isSelected ? "Selected" : "Add to alert"}</button>
            </div>
          </article>;
        })}
      </section>
      <aside className="simulator-shortlist" aria-label="Ranked simulator venues">
        <h2>Your simulator alert</h2><p>Rank up to five venues. We look for one bay for {form.players} players for {form.durationMinutes} minutes.</p>
        <ol>{selected.map((venue, index) => <li key={venue.offeringId}>
          <span>{venue.name}</span><div>
            <button aria-label={`Move ${venue.name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
            <button aria-label={`Move ${venue.name} down`} disabled={index === selected.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
            <button aria-label={`Remove ${venue.name}`} onClick={() => { setSelected(current => current.filter(choice => choice.offeringId !== venue.offeringId)); setSavedId(null); }}><X size={16} /></button>
          </div>
        </li>)}</ol>
        {selectionProblem ? <p role="alert">{selectionProblem}</p> : null}
        {accountSignedIn ? <><p>Alerts go to your account email: {accountEmail}. Add extra recipients in My alerts.</p>
          <button className="button button-primary" disabled={!canSave || saving || Boolean(savedId)} onClick={() => void save()}><Bell size={16} />{saving ? "Saving…" : savedId ? "Alert saved" : "Create simulator alert"}</button></>
          : accountEnabled && clerkPublishableKey ? <DeferredSignInButton publishableKey={clerkPublishableKey} returnTo="/search?mode=SIMULATOR" className="button button-primary">Sign in to create your alert</DeferredSignInButton>
          : <p>Sign-in is temporarily unavailable. You can browse official simulator pages.</p>}
        {savedId ? <a className="button button-secondary" href={`/dashboard?created=${encodeURIComponent(savedId)}`}>View my alert</a> : null}
        <small>The full session must fit inside your time window. You complete the booking on the official site.</small>
      </aside>
    </div>
  </div>;
}
