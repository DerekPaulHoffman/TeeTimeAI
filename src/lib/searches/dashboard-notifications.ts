import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";
import { formatDateInputValue } from "@/lib/dates/local-date";

type NotificationSearch = {
  status: string;
  date: Date;
  endTime: string;
  preferences: readonly { course: { id: string; name: string; timeZone: string } }[];
};

export function getNotificationTitle(preferences: NotificationSearch["preferences"]) {
  const names = preferences.map(preference => preference.course.name);
  if (!names.length) return "Tee time alert";
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} ${names.length === 2 ? "other course" : "other courses"}`;
}

export function groupDashboardNotifications<T extends NotificationSearch>(searches: readonly T[], now = new Date()) {
  const isCurrent = (search: T) => search.status === "ACTIVE" && !notificationWindowEnded(
    formatDateInputValue(search.date), search.endTime,
    search.preferences.map(preference => preference.course.timeZone), now
  );
  const active = searches.filter(isCurrent);
  const paused = searches.filter(search => search.status === "PAUSED");
  const history = searches.filter(search => !isCurrent(search));
  return {
    active, paused, history,
    slotsUsed: searches.filter(search => search.status === "ACTIVE" || search.status === "PAUSED").length,
    monitoredCourseCount: new Set(active.flatMap(search => search.preferences.map(preference => preference.course.id))).size
  };
}

export function notificationWindowEnded(date: string, endTime: string, timeZones: readonly string[], now: Date) {
  if (!timeZones.length) return false;
  return timeZones.every(timeZone => {
    try { return parseCourseLocalWindowEnd(date, endTime, timeZone).getTime() <= now.getTime(); }
    catch { return false; }
  });
}
