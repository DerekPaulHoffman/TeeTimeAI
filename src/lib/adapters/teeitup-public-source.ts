/** The observed public V2 tenant surfaces. The legacy book.golf host also
 * serves this bootstrap at /teetimes; its root remains in the V1 parser.
 * This is deliberately separate so accepted legacy metadata stays unchanged.
 * No booking/checkout/selected-slot route or request authority is inferred. */
export function parseTeeItUpV2PublicSource(value: string) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value), match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(book-v2|book)\.teeitup\.golf$/u.exec(url.hostname);
    if (!match || url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
        !["/", "/teetimes", "/teetimes/"].includes(url.pathname)) return null;
    if (match[2] === "book" && url.pathname !== "/teetimes") return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !["course", "date"].includes(key)) || new Set(keys).size !== keys.length) return null;
    const course = url.searchParams.get("course"), date = url.searchParams.get("date");
    if (course !== null && !/^[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,19}$/u.test(course)) return null;
    const selectedIds = course?.split(",").map(Number);
    if (selectedIds && (selectedIds.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647) || new Set(selectedIds).size !== selectedIds.length)) return null;
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) return null;
    return { alias: match[1], origin: url.origin, url: url.href, selectedIds: selectedIds?.sort((a, b) => a - b), date: date ?? undefined };
  } catch { return null; }
}
