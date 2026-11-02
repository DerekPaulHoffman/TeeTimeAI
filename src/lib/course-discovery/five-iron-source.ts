import { z } from "zod";
import { completeUSAddress } from "./teeitup-official-identity";

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80);
export const fiveIronMetadataSchema = z.object({ family: z.literal("FIVE_IRON"),
  locationId: z.string().uuid(), locationSlug: slug, locationName: z.string().min(3).max(100),
  timeZone: z.string().min(3).max(80) }).strict();
export type FiveIronMetadata = z.infer<typeof fiveIronMetadataSchema>;
export type FiveIronSource = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
export function parseFiveIronSource(value: string) {
  try {
    const u = new URL(value), locationSlug = u.searchParams.get("location");
    if (u.protocol !== "https:" || u.hostname !== "booking.fiveirongolf.com" || u.port || u.username || u.password || u.hash ||
      u.pathname !== "/select-experience" || u.searchParams.get("experience") !== "simulator" ||
      [...u.searchParams.keys()].length !== 2 || !slug.safeParse(locationSlug).success) return null;
    return { locationSlug: locationSlug!, bookingUrl: `https://booking.fiveirongolf.com/select-experience?location=${locationSlug}&experience=simulator` };
  } catch { return null; }
}
const location = z.object({ id: z.string().uuid(), name: z.string().min(3).max(100), urlSlug: slug.nullable(),
  timezone: z.string().min(3).max(80), experiences: z.array(z.string().max(80)).max(20) });
export function bindFiveIronLocation(source: FiveIronSource, value: unknown): FiveIronMetadata {
  const booking = parseFiveIronSource(source.bookingUrl), rows = z.array(location).min(1).max(100).safeParse(value);
  const address = source.venueAddress && completeUSAddress(source.venueAddress);
  let official: URL; try { official = new URL(source.officialUrl ?? ""); } catch { throw Error("ADAPTER_IDENTITY_MISSING"); }
  const path = /^\/locations\/([a-z0-9-]+)\/?$/u.exec(official.pathname);
  if (!booking || !rows.success || !address || official.protocol !== "https:" ||
    !["fiveirongolf.com", "www.fiveirongolf.com"].includes(official.hostname) || official.username || official.password || official.port || !path ||
    key(source.venueName) !== "fiveirongolf" || new Set(rows.data.map(r => r.id)).size !== rows.data.length ||
    new Set(rows.data.filter(r => r.urlSlug !== null).map(r => r.urlSlug)).size !== rows.data.filter(r => r.urlSlug !== null).length) throw Error("ADAPTER_IDENTITY_MISMATCH");
  const matches = rows.data.filter(r => r.urlSlug === booking.locationSlug && key(r.name) === key(path[1]) &&
    key(r.name.split(/\s+-\s+/u)[0]) === key(address.locality) && r.timezone === source.timeZone && r.experiences.includes("Golf"));
  if (matches.length !== 1) throw Error("ADAPTER_IDENTITY_MISMATCH");
  try { new Intl.DateTimeFormat("en-US", { timeZone: matches[0].timezone }); } catch { throw Error("ADAPTER_IDENTITY_MISMATCH"); }
  const r = matches[0];
  return fiveIronMetadataSchema.parse({ family: "FIVE_IRON", locationId: r.id, locationSlug: r.urlSlug, locationName: r.name, timeZone: r.timezone });
}

export const fiveIronAvailabilitySchema = z.array(z.object({
  // The public client displays these Z-suffixed strings as venue wall time.
  // They are deliberately not treated as UTC instants.
  time: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00\.000Z$/u),
  scheduleStep: z.number().int().min(1).max(60),
  availabilities: z.array(z.object({ staffId: z.number().int().positive(), staffLetter: z.string().min(1).max(10),
    durations: z.array(z.object({ duration: z.number().int().min(15).max(480), cost: z.number().finite().nonnegative() })).max(32)
  })).max(40)
})).max(100);
