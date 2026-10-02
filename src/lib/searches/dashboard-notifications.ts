import { zonedDateTimeToDate } from "@/lib/timezones";

type NotificationSearch = {
  status: string;
  preferences: readonly { course: { id: string; name: string } }[];
};

export function getNotificationTitle(preferences: NotificationSearch["preferences"]) {
  const names = preferences.map(preference => preference.course.name);
  if (!names.length) return "Tee time alert";
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} ${names.length === 2 ? "other course" : "other courses"}`;
}

export function groupDashboardNotifications<T extends NotificationSearch>(searches: readonly T[]) {
  const active = searches.filter(search => search.status === "ACTIVE");
  const paused = searches.filter(search => search.status === "PAUSED");
  const history = searches.filter(search => search.status !== "ACTIVE" && search.status !== "PAUSED");
  return {
    active, paused, history,
    slotsUsed: active.length + paused.length,
    monitoredCourseCount: new Set(active.flatMap(search => search.preferences.map(preference => preference.course.id))).size
  };
}

export function notificationWindowEnded(date: string, endTime: string, timeZones: readonly string[], now: Date) {
  if (!timeZones.length) return false;
  return timeZones.every(timeZone => {
    try { return zonedDateTimeToDate(`${date}T${endTime}:00`, timeZone).getTime() <= now.getTime(); }
    catch { return false; }
  });
}
