"use client";

import { Bell, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { CourseTimeCheckStatus, KnownTeeTimes, type CourseTimeCheck } from "./known-tee-times";
import { DeferredSignInButton } from "@/components/deferred-sign-in-button";
import type { CourseCandidate } from "@/lib/places/google";
import { getCourseLayoutCompatibility, getCourseLayoutLabel, type CourseLayoutHoleCount } from "@/lib/courses/course-layout";
import { storeSearchPrefill } from "@/lib/searches/search-prefill";
import type { KnownTeeTime } from "@/lib/courses/known-tee-times";

export function FacilityCourseRows({ courses, checks = {}, timeFilters, onNotify, signInKey, requestedLayoutHoles = null, savedStatuses, savedTimes = {} }: {
  courses: CourseCandidate[];
  checks?: Record<string, CourseTimeCheck>;
  timeFilters?: { date: string; startTime: string; endTime: string; players: number };
  onNotify?: (course: CourseCandidate) => void;
  signInKey?: string;
  requestedLayoutHoles?: CourseLayoutHoleCount | null;
  savedStatuses?: Record<string, { label: string; detail: string }>;
  savedTimes?: Record<string, KnownTeeTime[]>;
}) {
  const router = useRouter();
  function notify(course: CourseCandidate) {
    if (onNotify) return onNotify(course);
    // Existing alerts never change here. Start the normal signed-in creation
    // flow with exactly one canonical course and no recipients or stale date.
    storeSearchPrefill({ mode: "OUTDOOR", holes: "any", location: course.address,
      coordinates: { latitude: course.latitude, longitude: course.longitude }, selectedCourse: course });
    router.push("/search");
  }
  return <div className="facility-course-list">{courses.map(course => {
    const check = course.courseId ? checks[course.courseId] : undefined;
    const saved = course.courseId ? savedStatuses?.[course.courseId] : undefined;
    const incompatible = !savedStatuses && getCourseLayoutCompatibility(course.layoutHoleCounts, requestedLayoutHoles) === "incompatible";
    const content = <><Bell aria-hidden="true" size={12} />Notify me</>;
    return <section className="facility-course-row" aria-label={course.name} key={course.courseId}>
      <div className="facility-course-copy">
        <div className="facility-course-heading"><strong>{course.name}</strong><span>· {course.layoutHoleCounts?.length ? `${getCourseLayoutLabel(course.layoutHoleCounts)} course` : "Physical layout unverified"}</span></div>
        {savedStatuses ? <><p className="course-time-check"><strong>{saved?.label ?? "Not included in this alert"}</strong></p><p className="course-time-check-detail">{saved?.detail ?? "Use Notify me to create a separate alert for this course."}</p></> : <>
          <CourseTimeCheckStatus check={check} alertSupport={course.alertSupport} />
          {check?.status === "CHECKED" && timeFilters ? <KnownTeeTimes times={check.times} timeZone={course.timeZone} {...timeFilters} showEmpty showDetails /> : null}
        </>}
        {savedStatuses && course.courseId && timeFilters && savedTimes[course.courseId]?.length ? <KnownTeeTimes times={savedTimes[course.courseId]} timeZone={course.timeZone} {...timeFilters} showDetails /> : null}
        {course.website ? <a className="facility-booking-link" href={course.website} target="_blank" rel="noreferrer">Official booking page <ExternalLink aria-hidden="true" size={10} /></a> : null}
        {incompatible ? <p className="course-time-check-detail">Does not match your {requestedLayoutHoles}-hole course filter.</p> : null}
      </div>
      <div className="facility-course-action">{signInKey ? <DeferredSignInButton ariaLabel={`Notify me for ${course.name}`} className="figma-add-button" disabled={incompatible} onClick={() => notify(course)} publishableKey={signInKey} returnTo="/search">{content}</DeferredSignInButton> :
        <button type="button" className="figma-add-button" disabled={incompatible} aria-label={`Notify me for ${course.name}`} onClick={() => notify(course)}>{content}</button>}
      </div>
    </section>;
  })}</div>;
}
