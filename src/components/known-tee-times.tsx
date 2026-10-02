"use client";

import { useEffect, useState } from "react";
import type { KnownTeeTime } from "@/lib/courses/known-tee-times";

export function useKnownTeeTimes(courseIds: string[], date: string) {
  const ids = [...new Set(courseIds)].sort().slice(0, 60).join(",");
  const key = `${ids}|${date}`;
  const [result, setResult] = useState<{ key: string; courses: Record<string, KnownTeeTime[]> } | null>(null);
  useEffect(() => {
    if (!ids || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ date });
    ids.split(",").forEach((id) => params.append("courseId", id));
    const timer = setTimeout(() => {
      void fetch(`/api/courses/known-times?${params}`, { signal: controller.signal })
        .then(async (response) => response.ok ? response.json() : { courses: {} })
        .then((data) => { if (!controller.signal.aborted) setResult({ key, courses: data.courses ?? {} }); })
        .catch(() => {});
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ids, date, key]);
  return result?.key === key ? result.courses : {};
}

export function KnownTeeTimes({ times, timeZone, date, startTime, endTime, players }: {
  times: KnownTeeTime[]; timeZone: string; date: string; startTime: string; endTime: string; players: number;
}) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const visible = times.filter((time) => time.availableSpots >= players &&
    clock.format(new Date(time.startsAt)) >= startTime && clock.format(new Date(time.startsAt)) <= endTime);
  if (!visible.length) return null;
  return <section className="known-tee-times" aria-label="Previously checked tee times">
    <p><strong>Previously checked times</strong> · {date}</p>
    <div className="known-tee-time-list">{visible.map((time) => <a
      key={`${time.startsAt}|${time.holes}`} className="known-tee-time" href={time.bookingUrl} target="_blank" rel="noreferrer"
      title={`Last confirmed ${new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(time.confirmedAt))}. You book direct on the official site.`}
    >
      <strong>{formatter.format(new Date(time.startsAt))}</strong>
      <span>{time.availableSpots} spots{time.holes ? ` · ${time.holes} holes` : ""}{time.priceCents !== null ? ` · $${(time.priceCents / 100).toFixed(2)}` : ""}</span>
      <span>Checked {formatter.format(new Date(time.confirmedAt))} · Official booking page ↗</span>
    </a>)}</div>
    <p>Availability can change. You book direct on the official site.</p>
  </section>;
}
