const MAX_BODY_CHARACTERS = 256 * 1024;
const MAX_TREE_DEPTH = 10;
const MAX_SLOTS = 200;

const CHALLENGE_PATTERN =
  /\b(?:403200|just a moment|managed challenge|browser challenge|cf-chl-|cloudflare ray id|turnstile|captcha|recaptcha|hcaptcha|waiting room|virtual queue)\b/i;
const TEE_TIME_URL_PATTERN =
  /(?:tee[-_ ]?times?|tee[-_ ]?sheet|availability|available[-_ ]?times?|search[-_ ]?time)/i;
const JSON_MIME_PATTERN = /(?:application|text)\/(?:[\w.+-]*\+)?json/i;
const SENSITIVE_PATH_PATTERN =
  /(?:^|\/)(?:account|auth|authorize|checkout|login|oauth|order|payment|purchase|signin|signup|token)(?:\/|$)/i;
const SENSITIVE_KEY_PATTERN =
  /^(?:access_?token|api_?key|auth(?:orization)?|code|credential|jwt|key|nonce|password|secret|session(?:id|token)?|signature|sig|ticket|token|transactionid)$/i;

const TIME_KEYS = new Set([
  "starttime",
  "teetime",
  "teeofftime",
  "dateandtime",
  "datetime"
]);
const AVAILABILITY_KEYS = new Set([
  "available",
  "availablecount",
  "availableparticipantno",
  "availableplayers",
  "availableslots",
  "capacity",
  "isavailable",
  "maxplayer",
  "maxplayers",
  "openslots",
  "participants",
  "remaining"
]);
const SLOT_ID_KEYS = new Set([
  "slotid",
  "teetimeid",
  "teesheetid",
  "reservationtimeid"
]);
const PRICE_KEYS = new Set([
  "displayprice",
  "price",
  "rate",
  "teesheetprice"
]);

export function analyzePublicResponse(input) {
  const method = String(input.method || "GET").toUpperCase();
  const status = Number(input.status || 0);
  const rawUrl = String(input.url || "");
  const url = redactUrl(rawUrl);
  const headers = normalizeHeaders(input.headers);
  const mimeType = String(input.mimeType || "");
  const body = String(input.body || "").slice(0, MAX_BODY_CHARACTERS);
  const challenge =
    status === 401 ||
    status === 403 ||
    headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
    CHALLENGE_PATTERN.test(body);

  if (challenge) {
    return {
      kind: "challenge",
      method,
      status,
      url,
      title: "Managed access challenge observed",
      detail: challengeDetail(status, body)
    };
  }

  if (isSensitiveUrl(rawUrl)) {
    return {
      kind: "ignored",
      method,
      status,
      url,
      title: "Sensitive endpoint ignored",
      detail: "The reader does not inspect authentication, account, or transaction responses."
    };
  }

  const json = parseJsonBody(body, mimeType);
  if (json === undefined) {
    return { kind: "irrelevant", method, status, url };
  }

  const slots = extractTeeTimeSlots(json);
  const likelyTeeTimeResponse = TEE_TIME_URL_PATTERN.test(rawUrl) || slots.length > 0;

  if (likelyTeeTimeResponse) {
    return {
      kind: "tee_times",
      method,
      status,
      url,
      title: slots.length > 0
        ? `Readable public tee-time response (${slots.length} parsed)`
        : "Readable tee-time-shaped JSON response",
      detail: slots.length > 0
        ? "The normal browser received public slot data that the local reader could parse."
        : "The response was readable, but its schema needs an additional parser before slots can be normalized.",
      slots
    };
  }

  return {
    kind: "json",
    method,
    status,
    url,
    title: "Readable public JSON",
    detail: "Public JSON was received, but it did not look like tee-time inventory."
  };
}

export function extractTeeTimeSlots(value) {
  const results = [];
  const seen = new Set();

  visit(value, 0, (record) => {
    if (results.length >= MAX_SLOTS) {
      return;
    }
    const slot = normalizeSlot(record);
    if (!slot) {
      return;
    }
    const fingerprint = JSON.stringify(slot);
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      results.push(slot);
    }
  });

  return results;
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(normalizeKey(key))) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "").replace(
      /([?&](?:token|key|secret|signature|session|transactionid)=)[^&#]*/gi,
      "$1[redacted]"
    );
  }
}

export function buildShareableReport(records, inspectedUrl) {
  return {
    generatedAt: new Date().toISOString(),
    inspectedUrl: redactUrl(inspectedUrl || ""),
    localOnly: true,
    records: records
      .filter((record) => record.kind !== "ignored" && record.kind !== "irrelevant")
      .map((record) => ({
        kind: record.kind,
        method: record.method,
        status: record.status,
        url: record.url,
        title: record.title,
        detail: record.detail,
        slots: record.slots || []
      }))
  };
}

function parseJsonBody(body, mimeType) {
  const trimmed = body.trim();
  if (
    !trimmed ||
    (!JSON_MIME_PATTERN.test(mimeType) &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("["))
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function normalizeHeaders(headers) {
  const result = new Map();
  for (const header of headers || []) {
    const name = String(header?.name || "").toLowerCase();
    if (name) {
      result.set(name, String(header?.value || ""));
    }
  }
  return result;
}

function isSensitiveUrl(value) {
  try {
    const url = new URL(value);
    return SENSITIVE_PATH_PATTERN.test(url.pathname);
  } catch {
    return SENSITIVE_PATH_PATTERN.test(String(value || ""));
  }
}

function challengeDetail(status, body) {
  const signals = [];
  if (status) {
    signals.push(`HTTP ${status}`);
  }
  if (/\b403200\b/i.test(body)) {
    signals.push("provider code 403200");
  }
  if (/turnstile/i.test(body)) {
    signals.push("Turnstile");
  } else if (/captcha|recaptcha|hcaptcha/i.test(body)) {
    signals.push("CAPTCHA");
  } else if (/just a moment|managed challenge|cf-chl-|cloudflare/i.test(body)) {
    signals.push("browser challenge");
  }
  return signals.length > 0
    ? `${signals.join(" · ")}. No bypass was attempted.`
    : "The response was not publicly readable in this browser session. No bypass was attempted.";
}

function visit(value, depth, onRecord) {
  if (depth > MAX_TREE_DEPTH || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) {
      visit(item, depth + 1, onRecord);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  onRecord(value);
  for (const nested of Object.values(value).slice(0, 200)) {
    visit(nested, depth + 1, onRecord);
  }
}

function normalizeSlot(record) {
  const entries = Object.entries(record);
  const normalized = new Map(
    entries.map(([key, value]) => [normalizeKey(key), value])
  );
  const timeEntry = entries.find(([key, value]) =>
    TIME_KEYS.has(normalizeKey(key)) && isUsefulTime(value)
  );
  if (!timeEntry) {
    return null;
  }

  const hasAvailability = [...normalized.keys()].some((key) =>
    AVAILABILITY_KEYS.has(key)
  );
  const hasSlotId = [...normalized.keys()].some((key) => SLOT_ID_KEYS.has(key));
  const hasPrice = [...normalized.keys()].some((key) => PRICE_KEYS.has(key));
  if (!hasAvailability && !hasSlotId && !hasPrice) {
    return null;
  }

  const slot = {
    time: String(timeEntry[1])
  };
  const course = findValue(normalized, [
    "coursename",
    "course",
    "courseid",
    "facilityname",
    "facilityid"
  ]);
  const holes = findValue(normalized, ["holes", "defaultholes"]);
  const startingTee = findValue(normalized, ["startingtee", "teebox", "tee"]);
  const teeSuffix = findValue(normalized, ["teesuffix"]);
  const compactStartingTee = compactValue(startingTee);
  const compactTeeSuffix = compactValue(teeSuffix);
  const availability = findAvailability(normalized);
  const price = findValue(normalized, [...PRICE_KEYS]);

  if (course !== undefined) {
    slot.course = compactValue(course);
  }
  if (holes !== undefined) {
    slot.holes = compactValue(holes);
  }
  if (compactStartingTee !== undefined) {
    slot.startingTee =
      `${compactStartingTee}${compactTeeSuffix ?? ""}`.trim();
  }
  if (availability !== undefined) {
    slot.available = compactValue(availability);
  }
  if (price !== undefined) {
    slot.price = compactValue(price);
  }
  return slot;
}

function findAvailability(normalized) {
  for (const key of AVAILABILITY_KEYS) {
    if (normalized.has(key)) {
      const value = normalized.get(key);
      if (Array.isArray(value)) {
        return value.length;
      }
      return value;
    }
  }
  return undefined;
}

function findValue(normalized, keys) {
  for (const key of keys) {
    if (normalized.has(key)) {
      return normalized.get(key);
    }
  }
  return undefined;
}

function compactValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8);
  }
  return undefined;
}

function isUsefulTime(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    /(?:\d{1,2}:\d{2}|T\d{2}:\d{2})/.test(value)
  );
}

function normalizeKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}
