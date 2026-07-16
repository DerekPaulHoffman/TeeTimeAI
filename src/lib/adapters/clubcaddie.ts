import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const CLUB_CADDIE_HOSTNAME = /^apimanager-cc\d{1,4}\.clubcaddie\.com$/i;
const CLUB_CADDIE_BOOKING_PATH = /^\/webapi\/view\/[a-z0-9_-]{4,128}(?:\/slots)?\/?$/i;
const MAX_PUBLIC_PAGE_BYTES = 2_000_000;

export type ClubCaddieMetadata = {
  provider: "CLUB_CADDIE";
  bookingBaseUrl: string;
};

export type ClubCaddieTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

class ClubCaddieResponseError extends Error {
  readonly failureClass: "CHALLENGE" | "SCHEMA";

  constructor(message: string, failureClass: "CHALLENGE" | "SCHEMA" = "SCHEMA") {
    super(message);
    this.name = "ClubCaddieResponseError";
    this.failureClass = failureClass;
  }
}

export function isClubCaddieMetadata(value: unknown): value is ClubCaddieMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<ClubCaddieMetadata>;
  if (
    metadata.provider !== "CLUB_CADDIE" ||
    typeof metadata.bookingBaseUrl !== "string"
  ) {
    return false;
  }

  try {
    const url = new URL(metadata.bookingBaseUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      CLUB_CADDIE_HOSTNAME.test(url.hostname) &&
      CLUB_CADDIE_BOOKING_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function fetchClubCaddieTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    metadata: ClubCaddieMetadata;
  },
  fetchImpl: typeof fetch = fetch
): Promise<ClubCaddieTeeSheetResult> {
  if (!isClubCaddieMetadata(input.metadata)) {
    throw new ClubCaddieResponseError("Club Caddie metadata is not valid");
  }

  const bookingUrl = new URL(input.metadata.bookingBaseUrl);
  const bootstrapUrl = new URL(bookingUrl);
  bootstrapUrl.searchParams.set("SetSessionIdInLocalStorage", "true");
  const bootstrapResponse = await fetchWithProviderTimeout(
    bootstrapUrl,
    {
      method: "GET",
      headers: publicHtmlHeaders(),
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    },
    fetchImpl
  );
  if (!bootstrapResponse.ok) {
    await throwForProviderResponse(
      "Club Caddie public session",
      bootstrapResponse
    );
  }
  const bootstrapHtml = await readBoundedHtml(
    bootstrapResponse,
    "Club Caddie public session"
  );
  assertNoAccessChallenge(bootstrapResponse, bootstrapHtml);

  const interaction = bootstrapResponse.headers.get("session-id");
  if (!isSafeInteractionValue(interaction)) {
    throw new ClubCaddieResponseError(
      "Club Caddie public session did not return a usable interaction"
    );
  }

  const bookingPageUrl = new URL(bookingUrl);
  bookingPageUrl.searchParams.set("Interaction", interaction);
  const bookingPageResponse = await fetchWithProviderTimeout(
    bookingPageUrl,
    {
      method: "GET",
      headers: publicHtmlHeaders(),
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    },
    fetchImpl
  );
  if (!bookingPageResponse.ok) {
    await throwForProviderResponse(
      "Club Caddie public booking page",
      bookingPageResponse
    );
  }

  const bookingPageHtml = await readBoundedHtml(
    bookingPageResponse,
    "Club Caddie public booking page"
  );
  assertNoAccessChallenge(bookingPageResponse, bookingPageHtml);
  const publicForm = parsePublicSearchForm(bookingPageHtml);

  const availabilityUrl = new URL("/webapi/TeeTimes", bookingUrl);
  const availabilityResponse = await fetchWithProviderTimeout(
    availabilityUrl,
    {
      method: "POST",
      headers: {
        ...publicHtmlHeaders(),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: buildAvailabilityBody(input, publicForm, interaction),
      credentials: "omit",
      cache: "no-store",
      redirect: "error"
    },
    fetchImpl
  );
  if (!availabilityResponse.ok) {
    await throwForProviderResponse("Club Caddie tee times", availabilityResponse);
  }

  const availabilityHtml = await readBoundedHtml(
    availabilityResponse,
    "Club Caddie tee times"
  );
  assertNoAccessChallenge(availabilityResponse, availabilityHtml);
  const parsed = parseClubCaddieSlots(availabilityHtml, {
    courseId: input.courseId,
    providerCourseId: publicForm.courseId,
    targetDate: input.date.toISOString().slice(0, 10),
    players: input.players,
    bookingBaseUrl: input.metadata.bookingBaseUrl
  });

  if (!parsed.responseRecognized) {
    throw new ClubCaddieResponseError(
      "Club Caddie tee times returned an unrecognized public response"
    );
  }

  return {
    slots: parsed.slots,
    targetDateStatus: "OPEN",
    bookingWindowEvidence: null
  };
}

export function parseClubCaddieSlots(
  html: string,
  input: {
    courseId: string;
    providerCourseId: string;
    targetDate: string;
    players: number;
    bookingBaseUrl: string;
  }
) {
  const slotElements = extractDivElementsByClasses(html, ["teetime", "bigscreen"]);
  let recognizedSlotCards = 0;
  const slots = slotElements.flatMap((slotHtml): TeeTimeSlot[] => {
    const text = htmlText(slotHtml);
    if (hasExplicitUnavailableState(text)) {
      recognizedSlotCards += 1;
      return [];
    }
    if (!hasActionableBookingMarker(slotHtml)) {
      return [];
    }
    const golferMatch = /Golfers:\s*(\d+)(?:\s*-\s*(\d+))?/i.exec(text);
    const timeMatch = /Tee Time:\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(text);
    const holesMatch = /Holes:\s*(9|18)\s*Holes?/i.exec(text);
    const priceSection = /Price:\s*(.*?)\s*Holes:/i.exec(text)?.[1] ?? "";
    const priceValues = [...priceSection.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)]
      .map((match) => match[1]);
    const startingNineMatch = /Starting 9:\s*(.*?)\s*Tee Time:/i.exec(text);
    if (!golferMatch || !timeMatch || !holesMatch) {
      return [];
    }

    const minimumPlayers = Number(golferMatch[1]);
    const availableSpots = Number(golferMatch[2] ?? golferMatch[1]);
    if (
      !Number.isInteger(minimumPlayers) ||
      !Number.isInteger(availableSpots)
    ) {
      return [];
    }

    const localTime = parseProviderTime(timeMatch[1]);
    if (!localTime) {
      return [];
    }
    recognizedSlotCards += 1;
    if (input.players < minimumPlayers || input.players > availableSpots) {
      return [];
    }
    const holes = Number(holesMatch[1]) as 9 | 18;
    const startingNine = normalizeSourcePart(startingNineMatch?.[1] ?? "course");
    const priceCents = priceValues.length === 1
      ? parsePriceCents(priceValues[0])
      : undefined;

    return [{
      sourceId: [
        "clubcaddie",
        input.providerCourseId,
        input.targetDate.replaceAll("-", ""),
        localTime.replace(":", ""),
        startingNine,
        String(holes)
      ].join("-"),
      courseId: input.courseId,
      startsAt: `${input.targetDate}T${localTime}`,
      availableSpots,
      bookingUrl: input.bookingBaseUrl,
      ...(priceCents !== undefined ? { priceCents } : {}),
      holes,
      bookableHoleCounts: [holes],
      evidenceUrl: input.bookingBaseUrl
    }];
  });

  return {
    slots,
    responseRecognized: slotElements.length > 0
      ? recognizedSlotCards === slotElements.length
      : /\b(?:no|zero)\s+(?:available\s+)?(?:tee\s*times?|slots?|availability)\b|\btee\s*times?\s+(?:are\s+)?not\s+available\b/i.test(
          htmlText(html)
        )
  };
}

function hasExplicitUnavailableState(value: string) {
  return /\b(?:sold\s*out|fully\s+booked|unavailable|not\s+(?:currently\s+)?available|closed)\b/i.test(
    value
  );
}

function hasActionableBookingMarker(html: string) {
  for (const control of html.matchAll(
    /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  )) {
    const attributes = control[2] ?? "";
    const searchable = `${attributes} ${htmlText(control[3] ?? "")}`;
    if (
      /\b(?:book|reserve)\b/i.test(searchable) &&
      !isDisabledBookingControl(attributes)
    ) {
      return true;
    }
  }

  for (const control of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attributes = parseHtmlAttributes(control[1] ?? "");
    if (
      ["button", "submit"].includes(attributes.type?.toLowerCase() ?? "") &&
      /\b(?:book|reserve)\b/i.test(
        `${attributes.value ?? ""} ${attributes.name ?? ""} ${attributes.id ?? ""} ${attributes.class ?? ""}`
      ) &&
      !isDisabledBookingControl(control[1] ?? "")
    ) {
      return true;
    }
  }

  return false;
}

function isDisabledBookingControl(attributes: string) {
  return (
    /(?:^|\s)disabled(?:\s|=|$)/i.test(attributes) ||
    /\baria-disabled\s*=\s*["']?true["']?/i.test(attributes) ||
    /\bclass\s*=\s*(?:["'][^"']*\bdisabled\b[^"']*["']|[^\s>]*\bdisabled\b)/i.test(
      attributes
    )
  );
}

function buildAvailabilityBody(
  input: { date: Date; players: number },
  publicForm: { courseId: string; apiKey: string; holeGroup: string },
  interaction: string
) {
  const targetDate = input.date.toISOString().slice(0, 10);
  const [year, month, day] = targetDate.split("-");
  return new URLSearchParams({
    date: `${month}/${day}/${year}`,
    player: String(Math.max(1, Math.min(4, input.players))),
    holes: "any",
    fromtime: "4",
    totime: "23",
    minprice: "0",
    maxprice: "9999",
    ratetype: "any",
    HoleGroup: publicForm.holeGroup,
    CourseId: publicForm.courseId,
    apikey: publicForm.apiKey,
    Interaction: interaction
  });
}

function parsePublicSearchForm(html: string) {
  const formHtml = /<form\b[^>]*\bid=["']SearchForm["'][^>]*>([\s\S]*?)<\/form>/i.exec(
    html
  )?.[1];
  if (!formHtml) {
    throw new ClubCaddieResponseError(
      "Club Caddie public booking page did not include its search form"
    );
  }

  const courseId = getInputValue(formHtml, "CourseId");
  const apiKey = getInputValue(formHtml, "apikey");
  const holeGroup = getInputValue(formHtml, "HoleGroup") ?? "front";
  if (
    !courseId ||
    !/^\d{1,12}$/.test(courseId) ||
    !apiKey ||
    !/^[a-z0-9_-]{4,128}$/i.test(apiKey) ||
    !/^[a-z0-9 _-]{1,40}$/i.test(holeGroup)
  ) {
    throw new ClubCaddieResponseError(
      "Club Caddie public booking page metadata was incomplete"
    );
  }
  return { courseId, apiKey, holeGroup };
}

function getInputValue(formHtml: string, name: string) {
  for (const input of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attributes = parseHtmlAttributes(input[1]);
    if (attributes.name?.toLowerCase() === name.toLowerCase()) {
      return attributes.value;
    }
  }
  return undefined;
}

function parseHtmlAttributes(value: string) {
  return Object.fromEntries(
    [...value.matchAll(/\b([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? ""])
  ) as Record<string, string>;
}

function extractDivElementsByClasses(html: string, requiredClasses: string[]) {
  const results: string[] = [];
  const openTag = /<div\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = openTag.exec(html))) {
    const classValue = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
    const classes = new Set((classValue?.[1] ?? classValue?.[2] ?? "").split(/\s+/));
    if (!requiredClasses.every((className) => classes.has(className))) {
      continue;
    }

    const tag = /<\/?div\b[^>]*>/gi;
    tag.lastIndex = match.index;
    let depth = 0;
    let current: RegExpExecArray | null;
    while ((current = tag.exec(html))) {
      if (/^<\/div/i.test(current[0])) {
        depth -= 1;
        if (depth === 0) {
          results.push(html.slice(match.index, tag.lastIndex));
          openTag.lastIndex = tag.lastIndex;
          break;
        }
      } else {
        depth += 1;
      }
    }
  }
  return results;
}

async function readBoundedHtml(response: Response, label: string) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PUBLIC_PAGE_BYTES) {
    throw new ClubCaddieResponseError(`${label} exceeded the public response limit`);
  }
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_PUBLIC_PAGE_BYTES) {
    throw new ClubCaddieResponseError(`${label} exceeded the public response limit`);
  }
  return html;
}

async function throwForProviderResponse(label: string, response: Response): Promise<never> {
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
    throw new ClubCaddieResponseError(
      "Club Caddie public availability requires an access challenge",
      "CHALLENGE"
    );
  }
  const html = await readBoundedHtml(response, label);
  assertNoAccessChallenge(response, html);
  throw providerHttpError(label, response);
}

function assertNoAccessChallenge(response: Response, html: string) {
  if (
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
    /\b(?:captcha|recaptcha|hcaptcha|managed challenge|waiting room|virtual queue|queue position|you are in line|estimated wait)\b/i.test(
      html
    )
  ) {
    throw new ClubCaddieResponseError(
      "Club Caddie public availability requires an access challenge",
      "CHALLENGE"
    );
  }
}

function isSafeInteractionValue(value: string | null): value is string {
  return Boolean(
    value &&
    value.length >= 4 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function publicHtmlHeaders() {
  return {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9",
    "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
  };
}

function parseProviderTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const providerHour = Number(match[1]);
  const minute = Number(match[2]);
  if (providerHour < 1 || providerHour > 12 || minute < 0 || minute > 59) {
    return null;
  }
  let hour = providerHour % 12;
  if (match[3].toUpperCase() === "PM") {
    hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function parsePriceCents(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : undefined;
}

function normalizeSourcePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "course";
}

function htmlText(value: string) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
