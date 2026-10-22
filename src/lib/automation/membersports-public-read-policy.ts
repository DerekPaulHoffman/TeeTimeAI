const endpoint = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes";
const publicOrigin = "https://app.membersports.com";
const fields = ["configurationTypeId", "date", "golfClubGroupId", "golfClubId", "golfCourseId", "groupSheetTypeId"] as const;
const member = `"(?:${fields.join("|")})"\\s*:\\s*(?:0|[1-9][0-9]{0,9}|"[0-9/]{8,10}")`;
const flatSixFields = new RegExp(`^\\s*\\{\\s*${member}(?:\\s*,\\s*${member}){5}\\s*\\}\\s*$`, "u");
const correlationNames = new Set(["x-ms-device-id", "x-ms-client-session-id", "x-ms-request-id", "x-ms-attempt-id"]);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

function calendarDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^([1-9]|1[0-2])\/([1-9]|[12][0-9]|3[01])\/([1-9][0-9]{3})$/u.exec(value);
  if (!match) return false;
  const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Published public date-read shape only. This never proves a key is public or
 * grants credentials: the native controller must separately attest the current
 * script/header/loader/request and enforce the actual POST method and route.
 * The fresh signed-out body omits undefined memberProfileId; explicit profiles,
 * including zero/null, stay closed. Cookies retain the caller's existing fresh
 * context boundary and are not treated as proof of either access or identity. */
export function isMemberSportsPublicTeeSheetPost(
  url: URL,
  headers: Headers,
  body: string,
  documentUrl: string,
): boolean {
  if (!(url instanceof URL) || url.href !== endpoint || typeof documentUrl !== "string" || documentUrl.length > 2048) return false;
  const source = /^https:\/\/app\.membersports\.com\/tee-times\/([1-9][0-9]{0,9})\/([1-9][0-9]{0,9})\/0$/u.exec(documentUrl);
  if (!source || !positiveId(Number(source[1])) || !positiveId(Number(source[2]))) return false;
  if (headers.get("origin") !== publicOrigin || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "")) return false;
  let safeHeaders = true, headerCount = 0;
  headers.forEach((value, name) => {
    headerCount++;
    if (name === "cookie" || correlationNames.has(name)) return;
    if (name === "authorization") { if (!/^Bearer null$/iu.test(value)) safeHeaders = false; return; }
    if (name === "x-api-key") return; // Actual value publicity is exclusively the opaque controller proof.
    if (/authorization|token|secret|credential|session|csrf|next-action|method-override/iu.test(name)) safeHeaders = false;
  });
  if (!safeHeaders || headerCount > 64 || typeof body !== "string" || body.length > 2048 || !flatSixFields.test(body)) return false;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>, keys = Object.keys(data);
    if (keys.length !== fields.length || !keys.every(key => fields.includes(key as typeof fields[number]))) return false;
    return data.configurationTypeId === 0 && data.golfClubGroupId === 0 && data.groupSheetTypeId === 0 &&
      positiveId(data.golfClubId) && positiveId(data.golfCourseId) && data.golfClubId === Number(source[1]) &&
      data.golfCourseId === Number(source[2]) && calendarDate(data.date);
  } catch { return false; }
}
