"use client";

import { useEffect, useState } from "react";
import type { KnownTeeTime } from "@/lib/courses/known-tee-times";
import type { CourseAlertSupport } from "@/lib/courses/intelligence";
import { getDashboardCourseAction } from "@/lib/searches/dashboard-course-action";
import { CourseStatusEmoji } from "@/components/course-status-emoji";
import type { CourseCandidate } from "@/lib/places/google";
import { CourseCheckSpinner } from "@/components/course-check-spinner";
import { filterVisibleSimulatorSessions, type PublicSimulatorSession } from "@/lib/simulators/public-sessions";

export type CourseTimeCheck = { status: "LOADING" | "CHECKED" | "FAILED" | "UNAVAILABLE" | "UNSUPPORTED_DURATION" | "BUSY" | "NOT_OPEN"; times: KnownTeeTime[]; sessions?: PublicSimulatorSession[]; facilityCourses?: CourseCandidate[] };
export function useCourseTimeChecks(courseIds: string[], date: string, players: number, revision: number, onFacility?: (id: string, courses: CourseCandidate[]) => void,
  simulator?: { startTime: string; endTime: string; durationMinutes: number | null }) {
  const isSimulator = Boolean(simulator);
  const startTime = simulator?.startTime, endTime = simulator?.endTime, durationMinutes = simulator?.durationMinutes;
  const ids = [...new Set(courseIds)].sort().slice(0, 60).join(",");
  const key = `${ids}|${date}|${isSimulator ? `${startTime}|${endTime}|${durationMinutes}` : players}|${revision}`;
  const [result, setResult] = useState<{ key: string; courses: Record<string, CourseTimeCheck> } | null>(null);
  useEffect(() => {
    if (!ids || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const controller = new AbortController();
    const pending = ids.split(",");
    const update = (id: string, check: CourseTimeCheck) => {
      if (!controller.signal.aborted) setResult(previous => ({ key, courses: { ...(previous?.key === key ? previous.courses : {}), [id]: check } }));
    };
    async function worker() {
      while (pending.length && !controller.signal.aborted) {
        const id = pending.shift()!;
        update(id, { status: "LOADING", times: [] });
        try {
          const params = isSimulator
            ? new URLSearchParams({ offeringId: id, date, startTime: startTime!, endTime: endTime!,
              ...(durationMinutes != null ? { durationMinutes: String(durationMinutes) } : {}) })
            : new URLSearchParams({ courseId: id, date, players: String(players) });
          const response = await fetch(`/api/courses/${isSimulator ? "check-sessions" : "check-times"}?${params}`, { signal: controller.signal });
          const data = response.ok ? await response.json() : { status: "FAILED", times: [] };
          if (!controller.signal.aborted && Array.isArray(data.facilityCourses)) onFacility?.(id, data.facilityCourses);
          update(id, { status: data.status ?? "FAILED", times: data.times ?? [],
            ...(isSimulator ? { sessions: data.sessions ?? [] } : {}),
            ...(Array.isArray(data.facilityCourses) ? { facilityCourses: data.facilityCourses } : {}),
          });
        } catch { update(id, { status: "FAILED", times: [] }); }
      }
    }
    const timer = setTimeout(() => { void Promise.all([worker(), worker()]); }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ids, date, players, revision, key, onFacility, isSimulator, startTime, endTime, durationMinutes]);
  return result?.key === key ? result.courses : {};
}

export function CourseTimeCheckStatus({ check, alertSupport, simulator = false }: { check?: CourseTimeCheck; alertSupport?: CourseAlertSupport; simulator?: boolean }) {
  if (simulator) {
    const status = check?.status;
    return <p className={`course-time-check${status === "LOADING" ? " is-loading" : ""}`} role="status" aria-atomic="true">
      {status === "LOADING" ? <CourseCheckSpinner /> : status !== "CHECKED" ? <CourseStatusEmoji emoji={status === "NOT_OPEN" ? "🕒" : !status || status === "BUSY" ? "⏳" : "⚠️"} /> : null}
      <span>{!status ? "Waiting to check sessions…" : status === "LOADING" ? "Checking latest sessions…" :
        status === "CHECKED" ? "Sessions checked just now" : status === "NOT_OPEN" ? "Booking is not open for this date yet." :
          status === "BUSY" ? "Checks are busy. Search again in a moment, or use the official site." :
            status === "UNSUPPORTED_DURATION" ? "No supported session length fits these filters. Change the time window or session length." :
            status === "UNAVAILABLE" ? "Live sessions aren't available here yet. Check the official site." :
              "We couldn't check current sessions. Use the official site."}</span>
    </p>;
  }
  if (!check || check.status === "LOADING") return <p className={`course-time-check${check ? " is-loading" : ""}`} role="status" aria-atomic="true">
    {check ? <CourseCheckSpinner /> : <CourseStatusEmoji emoji="⏳" />}
    <span>{check ? "Checking latest tee times…" : "Waiting to check tee times…"}</span>
  </p>;
  if (check.status === "CHECKED") return <p className="course-time-check">Tee times checked just now</p>;
  if (check.status === "UNAVAILABLE" && alertSupport) {
    const action = getDashboardCourseAction(alertSupport);
    return <div>
      <p className="course-time-check" role="status"><CourseStatusEmoji emoji={action.emoji} /><span>{alertSupport === "PHONE_ONLY" ? "Call the course for tee times." : `${action.label}.`}</span></p>
      <p className="course-time-check-detail">{alertSupport === "PHONE_ONLY" ? "This course does not publish an online tee sheet." : action.detail}</p>
    </div>;
  }
  return <p className="course-time-check" role="status"><CourseStatusEmoji emoji={check.status === "NOT_OPEN" ? "🕒" : check.status === "BUSY" ? "⏳" : "⚠️"} /><span>{check.status === "NOT_OPEN" ? "Booking is not open for this date yet." : check.status === "BUSY" ? "Checks are busy. Search again in a moment, or use the official site." : "We couldn't check current tee times. Use the official site."}</span></p>;
}

export function SimulatorSessions({ sessions, timeZone, date, startTime, endTime, durationMinutes }: {
  sessions: PublicSimulatorSession[]; timeZone: string; date: string; startTime: string; endTime: string; durationMinutes: number | null;
}) {
  const visible = filterVisibleSimulatorSessions(sessions, timeZone, date, startTime, endTime, durationMinutes);
  if (!visible.length) return <p className="course-time-check"><CourseStatusEmoji emoji="🔎" /><span>No matching sessions found for this date, time window, and session length.</span></p>;
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(visible[0].startsAt)).find(part => part.type === "timeZoneName")?.value;
  return <section className="known-tee-times" aria-label="Available simulator sessions">
    <p><strong>Public sessions</strong> · {date} · {zone}</p>
    <div className="known-tee-time-list">{visible.map(session => {
      const duration = (Date.parse(session.endsAt) - Date.parse(session.startsAt)) / 60_000;
      return <a key={`${session.startsAt}|${session.endsAt}`} className="known-tee-time simulator-session-time" href={session.bookingUrl} target="_blank" rel="noreferrer"
        title={`${duration} minutes. Last checked ${new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(session.confirmedAt))}. You book direct on the official site.`}>
        <strong>{clock.format(new Date(session.startsAt))} – {clock.format(new Date(session.endsAt))}</strong>
      </a>;
    })}</div>
    <p>Availability can change. You book direct on the official site.</p>
  </section>;
}

export function useKnownTeeTimes(courseIds: string[], date: string) {
  const ids = [...new Set(courseIds)].sort().slice(0, 60).join(",");
  const key = `${ids}|${date}`;
  const [result, setResult] = useState<{ key: string; courses: Record<string, KnownTeeTime[]> } | null>(null);
  useEffect(() => {
    if (!ids || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ date });
    ids.split(",").forEach((id) => params.append("courseId", id));
    const refresh = () => {
      void fetch(`/api/courses/known-times?${params}`, { signal: controller.signal })
        .then(async (response) => response.ok ? response.json() : { courses: {} })
        .then((data) => { if (!controller.signal.aborted) setResult({ key, courses: data.courses ?? {} }); })
        .catch(() => {});
    };
    const timer = setTimeout(refresh, 150);
    const interval = setInterval(refresh, 60_000);
    return () => { clearTimeout(timer); clearInterval(interval); controller.abort(); };
  }, [ids, date, key]);
  return result?.key === key ? result.courses : {};
}

export function filterVisibleTeeTimes(times: KnownTeeTime[], timeZone: string, startTime: string, endTime: string, players: number) {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return times.filter(time => time.availableSpots >= players &&
    clock.format(new Date(time.startsAt)) >= startTime && clock.format(new Date(time.startsAt)) <= endTime);
}

export function KnownTeeTimes({ times, timeZone, date, startTime, endTime, players, showEmpty = false, showDetails = false }: {
  times: KnownTeeTime[]; timeZone: string; date: string; startTime: string; endTime: string; players: number;
  showEmpty?: boolean;
  showDetails?: boolean;
}) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(times[0]?.startsAt ?? `${date}T12:00:00Z`)).find(part => part.type === "timeZoneName")?.value;
  const visible = filterVisibleTeeTimes(times, timeZone, startTime, endTime, players);
  if (!visible.length) return showEmpty ? <p className="course-time-check"><CourseStatusEmoji emoji="🔎" /><span>No matching public tee times found for this date and time window.</span></p> : null;
  return <section className="known-tee-times" aria-label="Previously checked tee times">
    <p><strong><CourseStatusEmoji emoji="⛳" /> {showEmpty ? "Public tee times" : "Previously checked times"}</strong> · {date} · {zone}</p>
    <div className="known-tee-time-list">{visible.map((time) => <a
      key={`${time.startsAt}|${time.holes}`} className="known-tee-time" href={time.bookingUrl} target="_blank" rel="noreferrer"
      title={`${time.availableSpots} spots${time.holes ? ` · ${time.holes} holes` : ""}${time.priceCents !== null ? ` · $${(time.priceCents / 100).toFixed(2)}` : ""}. Last checked ${new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(time.confirmedAt))}. You book direct on the official site.`}
    >
      <strong>{formatter.format(new Date(time.startsAt))}</strong>
      {showDetails ? <span className="facility-time-detail">{time.availableSpots} spots{time.holes ? ` · ${time.holes}-hole round` : ""}{time.priceCents !== null ? ` · $${(time.priceCents / 100).toFixed(2)}` : " · Price unavailable"}</span> : null}
    </a>)}</div>
    <p>Availability can change. You book direct on the official site.</p>
  </section>;
}
