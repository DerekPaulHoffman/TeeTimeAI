import type { TeeTimeSlot } from "@/lib/tee-times/matching";

export type TeesnapMetadata = {
  provider: "TEESNAP";
  courseId: number;
  bookingBaseUrl: string;
  defaultHoles?: 9 | 18;
  defaultAddons?: string;
};

type TeesnapBooking = {
  bookingId?: number;
  golfers?: unknown[];
};

type TeesnapPrice = {
  roundType?: "NINE_HOLE" | "EIGHTEEN_HOLE";
  price?: string;
};

type TeesnapSection = {
  teeOff?: string;
  bookings?: number[];
  isHeld?: boolean;
};

type TeesnapApiSlot = {
  teeTime?: string;
  prices?: TeesnapPrice[];
  teeOffSections?: TeesnapSection[];
};

type TeesnapResponse = {
  errors?: string;
  teeTimes?: {
    bookings?: TeesnapBooking[];
    teeTimes?: TeesnapApiSlot[];
  };
};

export function isTeesnapMetadata(value: unknown): value is TeesnapMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<TeesnapMetadata>;
  return (
    metadata.provider === "TEESNAP" &&
    typeof metadata.courseId === "number" &&
    typeof metadata.bookingBaseUrl === "string" &&
    (metadata.defaultHoles === undefined || metadata.defaultHoles === 9 || metadata.defaultHoles === 18) &&
    (metadata.defaultAddons === undefined || typeof metadata.defaultAddons === "string")
  );
}

export async function fetchTeesnapSlots(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: TeesnapMetadata;
}): Promise<TeeTimeSlot[]> {
  const holes = input.metadata.defaultHoles ?? 18;
  const url = buildTeeTimesUrl(input.metadata, input.date, input.players, holes);
  const response = await fetch(url, {
    headers: teesnapHeaders(input.metadata.bookingBaseUrl)
  });
  const payload = (await response.json().catch(() => null)) as TeesnapResponse | null;

  if (!response.ok) {
    if (payload?.errors === "date_not_allowed") {
      return [];
    }
    throw new Error(`Teesnap tee times returned ${response.status}`);
  }

  const teeTimes = payload?.teeTimes?.teeTimes;
  if (!Array.isArray(teeTimes)) {
    return [];
  }

  const bookingSizes = new Map(
    (payload?.teeTimes?.bookings ?? [])
      .filter((booking) => typeof booking.bookingId === "number")
      .map((booking) => [booking.bookingId as number, booking.golfers?.length ?? 0])
  );
  const slots: TeeTimeSlot[] = [];

  for (const teeTime of teeTimes) {
    if (!teeTime.teeTime) {
      continue;
    }

    for (const section of teeTime.teeOffSections ?? []) {
      if (section.isHeld) {
        continue;
      }

      const availableSpots = getAvailableSpots(section, bookingSizes);
      if (availableSpots < 1) {
        continue;
      }

      const priceOptions = getPriceOptions(teeTime.prices);

      slots.push({
        courseId: input.courseId,
        sourceId: `teesnap-${input.metadata.courseId}-${teeTime.teeTime}-${section.teeOff ?? "tee"}`,
        startsAt: teeTime.teeTime.slice(0, 16),
        availableSpots,
        bookingUrl: withDateParam(input.metadata.bookingBaseUrl, input.date),
        priceCents: priceOptions.find((option) => option.holes === holes)?.priceCents,
        holes,
        priceOptions,
        evidenceUrl: url
      });
    }
  }

  return slots;
}

function teesnapHeaders(bookingBaseUrl: string) {
  const origin = new URL(bookingBaseUrl).origin;
  return {
    accept: "application/json, text/plain, */*",
    referer: `${origin}/`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  };
}

function buildTeeTimesUrl(
  metadata: TeesnapMetadata,
  date: Date,
  players: number,
  holes: 9 | 18
) {
  const url = new URL("/customer-api/teetimes-day", metadata.bookingBaseUrl);
  url.searchParams.set("course", String(metadata.courseId));
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  url.searchParams.set("players", String(players));
  url.searchParams.set("holes", String(holes));
  url.searchParams.set("addons", metadata.defaultAddons ?? "off");
  url.searchParams.set("profileId", "");
  return url.toString();
}

function getAvailableSpots(section: TeesnapSection, bookingSizes: Map<number, number>) {
  const bookedPlayers = (section.bookings ?? []).reduce(
    (total, bookingId) => total + (bookingSizes.get(bookingId) ?? 0),
    0
  );
  return Math.max(0, 4 - bookedPlayers);
}

function getPriceOptions(prices: TeesnapPrice[] = []) {
  return prices.flatMap((entry) => {
    const holes = entry.roundType === "NINE_HOLE" ? 9 : entry.roundType === "EIGHTEEN_HOLE" ? 18 : null;
    const parsed = Number(entry.price);

    return holes && Number.isFinite(parsed) && parsed >= 0
      ? [{ holes: holes as 9 | 18, priceCents: Math.round(parsed * 100) }]
      : [];
  });
}

function withDateParam(bookingBaseUrl: string, date: Date) {
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  return url.toString();
}
