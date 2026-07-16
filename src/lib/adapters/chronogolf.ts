import { connect } from "node:http2";

import { ProviderHttpError } from "@/lib/adapters/fetch-with-timeout";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

const CHRONOGOLF_MARKETPLACE_BASE_URL = "https://www.chronogolf.com";
const CHRONOGOLF_REQUEST_TIMEOUT_MS = 10_000;
const CHRONOGOLF_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const CHRONOGOLF_MAX_PAGES = 10;

export type ChronogolfMetadata = {
  clubId: number;
  courseIds: string[];
  bookingBaseUrl: string;
};

type ChronogolfPrice = {
  green_fee?: number;
  bookable_holes?: number;
};

type ChronogolfApiSlot = {
  uuid?: string;
  date?: string;
  start_time?: string;
  max_player_size?: number;
  frozen?: boolean;
  course?: {
    uuid?: string;
    holes?: number;
  };
  default_price?: ChronogolfPrice;
};

type ChronogolfResponse = {
  teetimes?: ChronogolfApiSlot[];
};

type ChronogolfPage = {
  payload: ChronogolfResponse;
  total: number;
  perPage: number;
};

type ChronogolfRequester = (url: string) => Promise<ChronogolfPage>;

export function isChronogolfMetadata(value: unknown): value is ChronogolfMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<ChronogolfMetadata>;
  return (
    typeof metadata.clubId === "number" &&
    Number.isInteger(metadata.clubId) &&
    metadata.clubId > 0 &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every((courseId) => typeof courseId === "string" && courseId.length > 0) &&
    typeof metadata.bookingBaseUrl === "string"
  );
}

export async function fetchChronogolfSlots(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: ChronogolfMetadata;
}, request: ChronogolfRequester = requestChronogolfJson): Promise<TeeTimeSlot[]> {
  const slots: TeeTimeSlot[] = [];

  for (let page = 1; page <= CHRONOGOLF_MAX_PAGES; page += 1) {
    const url = buildTeeTimesUrl(input.date, input.players, input.metadata.courseIds, page);
    const response = await request(url);
    const teeTimes = Array.isArray(response.payload.teetimes)
      ? response.payload.teetimes
      : [];

    slots.push(...teeTimes.flatMap((slot) => normalizeSlot(slot, input, url)));

    if (
      teeTimes.length === 0 ||
      response.perPage < 1 ||
      page * response.perPage >= response.total
    ) {
      break;
    }
  }

  return slots;
}

function normalizeSlot(
  slot: ChronogolfApiSlot,
  input: { courseId: string; date: Date; metadata: ChronogolfMetadata },
  evidenceUrl: string
): TeeTimeSlot[] {
    if (
      slot.frozen ||
      !slot.uuid ||
      !slot.date ||
      !slot.start_time ||
      typeof slot.max_player_size !== "number" ||
      slot.max_player_size < 1
    ) {
      return [];
    }

    const holes = slot.default_price?.bookable_holes ?? slot.course?.holes;
    const priceCents = toPriceCents(slot.default_price?.green_fee);

    return [{
      courseId: input.courseId,
      sourceId: `chronogolf-${slot.uuid}`,
      startsAt: `${slot.date}T${normalizeTime(slot.start_time)}`,
      availableSpots: slot.max_player_size,
      bookingUrl: withSearchDate(input.metadata.bookingBaseUrl, input.date),
      priceCents,
      holes,
      priceOptions:
        (holes === 9 || holes === 18) && priceCents !== undefined
          ? [{ holes, priceCents }]
          : undefined,
      evidenceUrl
    }];
}

async function requestChronogolfJson(urlValue: string): Promise<ChronogolfPage> {
  const url = new URL(urlValue);

  return new Promise((resolve, reject) => {
    const client = connect(url.origin);
    let body = "";
    let status = 0;
    let retryAfter: string | null = null;
    let settled = false;

    let total = 0;
    let perPage = 0;

    const finish = (error?: Error, page?: ChronogolfPage) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      client.close();
      if (error) {
        reject(error);
      } else {
        resolve(page ?? { payload: {}, total: 0, perPage: 0 });
      }
    };

    const timeout = setTimeout(() => {
      request.close();
      finish(new Error("Chronogolf tee times request timed out"));
    }, CHRONOGOLF_REQUEST_TIMEOUT_MS);

    client.once("error", (error) => finish(error));
    const request = client.request({
      ":method": "GET",
      ":path": `${url.pathname}${url.search}`,
      accept: "application/json"
    });

    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
      const retryAfterHeader = headers["retry-after"];
      retryAfter = Array.isArray(retryAfterHeader)
        ? retryAfterHeader[0] ?? null
        : retryAfterHeader ?? null;
      total = Number(headers.total ?? 0);
      perPage = Number(headers["per-page"] ?? 0);
    });
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > CHRONOGOLF_RESPONSE_LIMIT_BYTES) {
        request.close();
        finish(new Error("Chronogolf tee times response exceeded the size limit"));
      }
    });
    request.once("error", (error) => finish(error));
    request.once("end", () => {
      if (status < 200 || status >= 300) {
        const headers = new Headers();
        if (retryAfter) {
          headers.set("retry-after", retryAfter);
        }
        finish(new ProviderHttpError("Chronogolf tee times", { status, headers }));
        return;
      }

      try {
        const payload = JSON.parse(body) as ChronogolfResponse;
        const teeTimeCount = Array.isArray(payload.teetimes) ? payload.teetimes.length : 0;
        finish(undefined, {
          payload,
          total: Number.isFinite(total) && total >= 0 ? total : teeTimeCount,
          perPage: Number.isFinite(perPage) && perPage > 0 ? perPage : teeTimeCount
        });
      } catch {
        finish(new Error("Chronogolf tee times returned invalid JSON"));
      }
    });
    request.end();
  });
}

function buildTeeTimesUrl(date: Date, players: number, courseIds: string[], page: number) {
  const url = new URL("/marketplace/v2/teetimes", CHRONOGOLF_MARKETPLACE_BASE_URL);
  url.searchParams.set("start_date", date.toISOString().slice(0, 10));
  url.searchParams.set("free_slots", String(players));
  url.searchParams.set("course_ids", courseIds.join(","));
  url.searchParams.set("page", String(page));
  return url.toString();
}

function normalizeTime(value: string) {
  const [hour = "0", minute = "00"] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function toPriceCents(value?: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100)
    : undefined;
}

function withSearchDate(bookingBaseUrl: string, date: Date) {
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  url.searchParams.set("step", "teetimes");
  return url.toString();
}
