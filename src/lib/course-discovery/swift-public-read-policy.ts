import { isSafePublicSwiftBootstrapReadUrl } from "./public-bootstrap-read-url";
import { isSafeRecipeUrl } from "./recipe";

/** Observed signed-out Swift calendar GET. No selected slots or customers. */
export function isSwiftPublicSlotsUrl(value: string) {
  const match = /^https:\/\/book\.runswiftapp\.com\/api\/booking\/availableSlots\?startTime=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)&endTime=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)&duration=60&serviceId=([1-9][0-9]{0,9})$/u.exec(value);
  if (!match || Number(match[3]) > 2_147_483_647) return false;
  const start = new Date(match[1]), end = new Date(match[2]);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start.toISOString() === match[1] && end.toISOString() === match[2] &&
    end.getTime() - start.getTime() >= 22 * 3_600_000 && end.getTime() - start.getTime() < 26 * 3_600_000 && isSafeRecipeUrl(value);
}

/** The public client sends the literal non-credential `Bearer null` on its
 * price and calendar GETs. Native Chrome preserves it unchanged. Never admit
 * a real bearer, cookie, other credential, method or current document. */
export function isSwiftAnonymousPlaceholderRead(value: string, method: string, original: Record<string, string>, frameUrl: string) {
  // A fresh public client sets only Clerk's signed-out timestamp markers on
  // this booking host. Nonzero values, real session cookies and duplicates
  // remain ineligible. No cookie is copied into another transport.
  const cookie = original.cookie ?? "", parts = cookie ? cookie.split("; ") : [];
  const anonymousCookie = parts.length <= 2 && new Set(parts.map(part => part.split("=", 1)[0])).size === parts.length &&
    parts.every(part => /^__client_uat(?:_[A-Za-z0-9]{8})?=0$/u.test(part));
  if (method !== "GET" || original.authorization !== "Bearer null" ||
      Object.keys(original).some(key => key !== "authorization" && !(key === "cookie" && anonymousCookie) &&
        /authorization|cookie|token|secret|credential|password|session|api.?key|csrf|next-action|(?:http-)?method-override/iu.test(key)) ||
      !/^https:\/\/book\.runswiftapp\.com\/facilities\/[a-z0-9][a-z0-9-]{0,99}\/rentals$/u.test(frameUrl)) return false;
  return value.startsWith("https://book.runswiftapp.com/api/public/price?") && isSafePublicSwiftBootstrapReadUrl(value, "xhr", method, isSafeRecipeUrl) ||
    isSwiftPublicSlotsUrl(value);
}
