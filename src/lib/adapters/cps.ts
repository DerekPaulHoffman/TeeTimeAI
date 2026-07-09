import type { TeeTimeSlot } from "@/lib/tee-times/matching";

export type CpsMetadata = {
  provider: "CPS";
  siteName: string;
  bookingBaseUrl: string;
  courseIds: number[];
  holes?: number[];
  clientId?: string;
  websiteId?: string;
  onlineApi?: string;
  authorityBaseUrl?: string;
};

type CpsConfiguration = {
  clientId: string;
  authorityBaseUrl: string;
  onlineApi: string;
  websiteId: string;
  siteName: string;
};

type CpsTokenResponse = {
  access_token?: string;
};

type CpsSearchResponse = {
  transactionId?: string;
  content?: CpsApiSlot[] | unknown;
};

type CpsApiSlot = {
  teeSheetId?: number;
  startTime?: string;
  courseId?: number;
  availableParticipantNo?: number[];
  participants?: number;
  minPlayer?: number;
  maxPlayer?: number;
  holes?: number;
  defaultHoles?: number;
  teeSheetPrice?: number;
  displayPrice?: number;
  shItemPrices?: Array<{
    displayPrice?: number;
    shItemCode?: string;
  }>;
};

export function isCpsMetadata(value: unknown): value is CpsMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<CpsMetadata>;
  return (
    metadata.provider === "CPS" &&
    typeof metadata.siteName === "string" &&
    typeof metadata.bookingBaseUrl === "string" &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every((courseId) => typeof courseId === "number") &&
    (metadata.holes === undefined ||
      (Array.isArray(metadata.holes) &&
        metadata.holes.length > 0 &&
        metadata.holes.every((holes) => holes === 9 || holes === 18)))
  );
}

export async function fetchCpsSlots(input: {
  courseId: string;
  date: Date;
  players: number;
  metadata: CpsMetadata;
}): Promise<TeeTimeSlot[]> {
  const configuration = await loadConfiguration(input.metadata);
  const token = await fetchShortLivedToken(configuration);
  const headers = cpsHeaders(configuration, token);
  const slots: TeeTimeSlot[] = [];
  const seen = new Set<string>();

  for (const holes of input.metadata.holes ?? [18, 9]) {
    const transactionId = crypto.randomUUID();
    await registerTransactionId(configuration.onlineApi, headers, transactionId);
    const url = buildTeeTimesUrl(configuration.onlineApi, {
      date: input.date,
      players: input.players,
      cpsCourseIds: input.metadata.courseIds,
      holes,
      transactionId
    });
    const response = await fetch(url, {
      headers
    });

    if (!response.ok) {
      throw new Error(`CPS tee times returned ${response.status}`);
    }

    const payload = (await response.json()) as CpsSearchResponse;
    if (!Array.isArray(payload.content)) {
      continue;
    }

    for (const slot of payload.content) {
      if (!slot.startTime || !slot.teeSheetId) {
        continue;
      }

      const availableSpots = getAvailableSpots(slot);
      if (availableSpots < 1) {
        continue;
      }

      const sourceId = `cps-${configuration.siteName}-${slot.teeSheetId}`;
      if (seen.has(sourceId)) {
        continue;
      }

      seen.add(sourceId);
      slots.push({
        courseId: input.courseId,
        sourceId,
        startsAt: normalizeCpsTime(slot.startTime),
        availableSpots,
        bookingUrl: withDateParam(input.metadata.bookingBaseUrl, input.date),
        priceCents: getPriceCents(slot),
        holes: slot.holes ?? slot.defaultHoles ?? holes,
        evidenceUrl: url
      });
    }
  }

  return slots;
}

async function loadConfiguration(metadata: CpsMetadata): Promise<CpsConfiguration> {
  if (metadata.onlineApi && metadata.authorityBaseUrl && metadata.websiteId) {
    return {
      clientId: metadata.clientId ?? "onlineresweb",
      authorityBaseUrl: metadata.authorityBaseUrl,
      onlineApi: metadata.onlineApi,
      websiteId: metadata.websiteId,
      siteName: metadata.siteName
    };
  }

  const url = new URL("/onlineresweb/Home/Configuration", metadata.bookingBaseUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CPS configuration returned ${response.status}`);
  }

  return (await response.json()) as CpsConfiguration;
}

async function fetchShortLivedToken(configuration: CpsConfiguration) {
  const response = await fetch(`${configuration.authorityBaseUrl}/myconnect/token/short`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: "onlinereswebshortlived",
      client_secret: "v4secret",
      grant_type: "client_credentials"
    })
  });

  if (!response.ok) {
    throw new Error(`CPS token returned ${response.status}`);
  }

  const token = (await response.json()) as CpsTokenResponse;
  if (!token.access_token) {
    throw new Error("CPS token response did not include an access token");
  }

  return token.access_token;
}

async function registerTransactionId(onlineApi: string, headers: Record<string, string>, transactionId: string) {
  const response = await fetch(`${onlineApi}/RegisterTransactionId`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      transactionId,
      action: "homepage"
    })
  });

  if (!response.ok) {
    throw new Error(`CPS transaction registration returned ${response.status}`);
  }
}

function buildTeeTimesUrl(
  onlineApi: string,
  input: {
    date: Date;
    players: number;
    cpsCourseIds: number[];
    holes: number;
    transactionId: string;
  }
) {
  const url = new URL(`${onlineApi}/TeeTimes`);
  url.searchParams.set("searchDate", input.date.toDateString());
  url.searchParams.set("holes", String(input.holes));
  url.searchParams.set("numberOfPlayer", String(input.players));
  url.searchParams.set("courseIds", input.cpsCourseIds.join(","));
  url.searchParams.set("searchTimeType", "0");
  url.searchParams.set("transactionId", input.transactionId);
  url.searchParams.set("teeOffTimeMin", "0");
  url.searchParams.set("teeOffTimeMax", "23");
  url.searchParams.set("isChangeTeeOffTime", "true");
  url.searchParams.set("teeSheetSearchView", "5");
  url.searchParams.set("classCode", "R");
  url.searchParams.set("defaultOnlineRate", "N");
  url.searchParams.set("isUseCapacityPricing", "false");
  url.searchParams.set("memberStoreId", "1");
  url.searchParams.set("searchType", "1");
  return url.toString();
}

function cpsHeaders(configuration: CpsConfiguration, token: string) {
  return {
    accept: "application/json, text/plain, */*",
    authorization: `Bearer ${token}`,
    "client-id": configuration.clientId,
    "x-terminalid": "1",
    "x-requestid": crypto.randomUUID(),
    "x-websiteid": configuration.websiteId,
    "x-ismobile": "false",
    "x-productid": "1",
    "x-componentid": "1",
    "x-siteid": "1",
    "x-timezone-offset": "240",
    "x-timezoneid": "America/New_York",
    "x-moduleid": "7",
    referer: new URL(configuration.onlineApi).origin + "/"
  };
}

function getAvailableSpots(slot: CpsApiSlot) {
  if (Array.isArray(slot.availableParticipantNo) && slot.availableParticipantNo.length > 0) {
    return Math.max(...slot.availableParticipantNo);
  }

  if (typeof slot.maxPlayer === "number") {
    return slot.maxPlayer;
  }

  if (typeof slot.participants === "number") {
    return slot.participants;
  }

  return 0;
}

function getPriceCents(slot: CpsApiSlot) {
  const price =
    slot.teeSheetPrice ??
    slot.displayPrice ??
    slot.shItemPrices?.find((item) => item.shItemCode?.toLowerCase().includes("greenfee"))
      ?.displayPrice;

  return typeof price === "number" ? Math.round(price * 100) : undefined;
}

function normalizeCpsTime(value: string) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value.slice(0, 16);
  }

  return value.replace(" ", "T").slice(0, 16);
}

function withDateParam(bookingBaseUrl: string, date: Date) {
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("date", date.toISOString().slice(0, 10));
  return url.toString();
}
