import { isMemberSportsPublicTeeSheetPost } from "../automation/membersports-public-read-policy";

export type MemberSportsTeeSheetContext = {
  documentUrl: string; requestUrl: string; requestMethod: string; requestBody: string;
  input: { date: string; players: number; startTime: string; endTime: string };
  metadata: { courses: unknown; parameters: unknown; bookingCounts: unknown };
  voucherApplied: false;
};
export type MemberSportsTeeSheetCard = {
  label: string; round: "9" | "18" | "BOTH";
  minimumPlayers: number; maximumPlayers: number; hidden: boolean; restricted: boolean;
};
export type MemberSportsTeeSheetDomFacts = {
  projectionComplete: boolean; settled?: boolean; dateText: string;
  eventsPresent: boolean; explicitEmpty: boolean;
  groups: Array<{ minute: number; cards: MemberSportsTeeSheetCard[] }>;
};
export type MemberSportsTeeSheetSlot = {
  sourceId: string; minute: number; availableSpots: number; minimumPlayers: number;
  roundHoles: 9 | 18 | null;
};
export type MemberSportsTeeSheetReason = "CONTEXT_INVALID" | "METADATA_INCOMPLETE" | "UNSUPPORTED_RULES" |
  "RESPONSE_INCOMPLETE" | "IDENTITY_MISMATCH" | "DUPLICATE_IDENTITY" | "ROW_INVALID" |
  "DOM_INCOMPLETE" | "DOM_PARITY_MISMATCH" | "EMPTY_UNPROVEN";
export type MemberSportsTeeSheetResult =
  { status: "VERIFIED"; complete: true; slots: MemberSportsTeeSheetSlot[]; emptyVerified: boolean } |
  { status: "INCOMPLETE"; complete: false; slots: []; reason: MemberSportsTeeSheetReason };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const integer = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;
function own(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function id(value: unknown): string | null {
  if (integer(value, 1, Number.MAX_SAFE_INTEGER)) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value) &&
    (!/^\d+$/u.test(value) || /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value))) ? value : null;
}
function minutes(value: string): number | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value) && value !== "24:00") return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function displayedDate(date: string) {
  const value = new Date(`${date}T12:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(value);
}

/** Interpretation only. The fixed caller owns current-document/generation,
 * original completed response, request/header proof and two stable DOM samples.
 * This grants no request, credential, navigation, recipe or transaction authority.
 * The initial supported subset is one unfiltered public course, standard rotation,
 * no events/voucher/custom membership limits; unknown needed facts fail closed.
 * Return every bookable public offer after whole-source parity. The central
 * executor owns requested party/window/current-time filtering and final EMPTY. */
export function normalizeMemberSportsPublicTeeSheet(response: unknown, context: MemberSportsTeeSheetContext,
  dom: MemberSportsTeeSheetDomFacts): MemberSportsTeeSheetResult {
  const fail = (reason: MemberSportsTeeSheetReason): MemberSportsTeeSheetResult => ({ status: "INCOMPLETE", complete: false, slots: [], reason });
  try {
    const input = context?.input;
    if (!input || !integer(input.players, 1, 4) || context.requestMethod !== "POST" || context.voucherApplied !== false) return fail("CONTEXT_INVALID");
    const start = minutes(input.startTime), end = minutes(input.endTime);
    // This validation copy tests only the already-observed public body shape.
    // Actual header/public-key authority remains exclusively with the caller.
    if (start === null || end === null || start >= end || !isMemberSportsPublicTeeSheetPost(new URL(context.requestUrl),
      new Headers({ origin: "https://app.membersports.com", "content-type": "application/json" }), context.requestBody, context.documentUrl)) return fail("CONTEXT_INVALID");
    const body = JSON.parse(context.requestBody) as Record<string, unknown>;
    if (body.date !== input.date) return fail("CONTEXT_INVALID");
    const courses = context.metadata?.courses, parameters = context.metadata?.parameters, limits = context.metadata?.bookingCounts;
    if (!Array.isArray(courses) || courses.length !== 1 || !record(courses[0]) || id(own(courses[0], "golfCourseId")) !== String(body.golfCourseId) ||
      !Array.isArray(parameters) || parameters.length < 1 || parameters.length > 32 ||
      !parameters.every(row => record(row) && integer(own(row, "configurationTypeId"), 0, Number.MAX_SAFE_INTEGER))) return fail("METADATA_INCOMPLETE");
    // The public route fixes group/configuration to zero and omits the optional
    // three-way route parameter. The published client selects Front/Back from
    // that route and the complete course count, not mutable isSelected flags or
    // a course rotationTypeId field. Bind settings to the explicit route config.
    const selected = parameters.filter(row => own(row, "configurationTypeId") === body.configurationTypeId);
    if (selected.length !== 1 || !record(limits)) return fail("METADATA_INCOMPLETE");
    const rules = selected[0];
    if (!["allowFivesomes", "onlyClubMembersCanReserve", "alwaysShowBackNine", "enableMaximumDailyTeeTimes"].every(key => own(rules, key) === false) ||
      typeof own(rules, "allowSinglesToBookOnline") !== "boolean" || !integer(own(rules, "minimumNumberOfPlayers"), 1, 4) ||
      !["hasCustomTeeTimeLimit", "enableMaximumTeeTimes", "limitTeeTimesPerMembership"].every(key => own(limits, key) === false)) return fail("UNSUPPORTED_RULES");
    if (!dom || dom.projectionComplete !== true || dom.settled !== true || dom.eventsPresent !== false || typeof dom.explicitEmpty !== "boolean" ||
      dom.dateText !== displayedDate(input.date) || !Array.isArray(dom.groups) || dom.groups.length > 500) return fail("DOM_INCOMPLETE");
    if (!Array.isArray(response) || response.length > 500) return fail("RESPONSE_INCOMPLETE");
    const identities = new Set<string>(), groupMinutes = new Set<number>();
    const expected: MemberSportsTeeSheetDomFacts["groups"] = [], slots: MemberSportsTeeSheetSlot[] = [];
    let visited = response.length, anyDisplayed = false;
    for (const group of response) {
      if (!record(group) || !integer(own(group, "teeTime"), 0, 1439) || !Array.isArray(own(group, "items"))) return fail("ROW_INVALID");
      const minute = own(group, "teeTime") as number, items = own(group, "items") as unknown[];
      if (groupMinutes.has(minute)) return fail("DUPLICATE_IDENTITY"); groupMinutes.add(minute);
      if ((visited += items.length) > 500) return fail("RESPONSE_INCOMPLETE");
      const display = new Map<string, { front?: MemberSportsTeeSheetCard; back?: MemberSportsTeeSheetCard }>();
      for (const item of items) {
        if (!record(item)) return fail("ROW_INVALID");
        if (id(own(item, "golfClubId")) !== String(body.golfClubId) || id(own(item, "golfCourseId")) !== String(body.golfCourseId) || own(item, "configurationTypeId") !== 0) return fail("IDENTITY_MISMATCH");
        const teeTimeId = id(own(item, "teeTimeId")), rotation = own(item, "rotationNumber"), back = own(item, "isBackNine"), players = own(item, "playerCount"),
          backPlayers = own(item, "backNinePlayerCount"), minimum = own(item, "minimumNumberOfPlayers"), holeRule = own(item, "holesRequirementTypeId"),
          threeWay = own(item, "threeWayHolesRequirementTypeId"), singles = own(item, "allowSinglesToBookOnline"), override = own(item, "ruleOverridesMinimumPlayer"), restricted = own(item, "bookingNotAllowed");
        if (!teeTimeId || !integer(rotation, 0, 100) || typeof back !== "boolean" || own(item, "teeTime") !== minute || !integer(players, 0, 4) ||
          !integer(backPlayers, 0, 4) || !integer(minimum, 1, 4) || !integer(holeRule, 0, 2) || !integer(threeWay, 0, 2) ||
          typeof singles !== "boolean" || typeof override !== "boolean" || typeof restricted !== "boolean" || typeof own(item, "hide") !== "boolean" ||
          typeof own(item, "hasBackNineEvent") !== "boolean") return fail("ROW_INVALID");
        if (own(item, "hasBackNineEvent") !== false) return fail("UNSUPPORTED_RULES");
        if (identities.has(teeTimeId)) return fail("DUPLICATE_IDENTITY"); identities.add(teeTimeId);
        const effective = holeRule === 0 && threeWay > 0 ? threeWay : holeRule;
        const available = effective === 1 ? 4 - players : Math.min(4 - players, 4 - backPlayers);
        const min = (players > 0 || effective !== 1 && backPlayers > 0) && singles ? 1 : minimum;
        const hidden = !singles && !override && 4 - players < 2;
        // Wire availableCount and hide are not the public consumer's computed
        // capacity/filter state; unknown extras are never copied to the result.
        const card: MemberSportsTeeSheetCard = { label: back ? "Back" : "Front", round: effective === 1 ? "9" : effective === 2 ? "18" : "BOTH",
          minimumPlayers: min, maximumPlayers: available, hidden, restricted };
        const key = `${rotation}:0`, pair = display.get(key) ?? {};
        if (pair[back ? "back" : "front"]) return fail("DUPLICATE_IDENTITY"); pair[back ? "back" : "front"] = card; display.set(key, pair);
        if (!hidden && players < 4) anyDisplayed = true;
        if (!hidden && !restricted && available > 0 && min <= available) {
          slots.push({ sourceId: `membersports-${body.golfClubId}-${body.golfCourseId}-${teeTimeId}`, minute, availableSpots: available,
            minimumPlayers: min, roundHoles: effective === 1 ? 9 : effective === 2 ? 18 : null });
        }
      }
      expected.push({ minute, cards: [...display.values()].flatMap(pair => [pair.front, pair.back].filter((card): card is MemberSportsTeeSheetCard => Boolean(card))) });
    }
    const normalized = (groups: MemberSportsTeeSheetDomFacts["groups"]) => groups.map(group => {
      if (!integer(group.minute, 0, 1439) || !Array.isArray(group.cards) || group.cards.length > 500) throw new Error("DOM");
      return { minute: group.minute, cards: group.cards.map(card => {
        if (!card || !["Front", "Back"].includes(card.label) || !["9", "18", "BOTH"].includes(card.round) || !integer(card.minimumPlayers, 1, 4) ||
          !integer(card.maximumPlayers, 0, 4) || typeof card.hidden !== "boolean" || typeof card.restricted !== "boolean") throw new Error("DOM");
        return { label: card.label, round: card.round, minimumPlayers: card.minimumPlayers, maximumPlayers: card.maximumPlayers, hidden: card.hidden, restricted: card.restricted };
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    }).sort((a, b) => a.minute - b.minute);
    // applyFilter clears all groups only when there is no unfiltered item with
    // playerCount < 4. Otherwise desktop retains even zero-offer time groups.
    if (JSON.stringify(normalized(dom.groups)) !== JSON.stringify(normalized(anyDisplayed ? expected : []))) return fail("DOM_PARITY_MISMATCH");
    if (!slots.length && (!dom.explicitEmpty || anyDisplayed) || slots.length && dom.explicitEmpty) return fail("EMPTY_UNPROVEN");
    return { status: "VERIFIED", complete: true, slots, emptyVerified: slots.length === 0 };
  } catch { return fail("RESPONSE_INCOMPLETE"); }
}

/** Self-contained passive projection of published primary component classes.
 * No framework/component state, actions, hrefs, IDs, arbitrary selectors, full
 * text or response bodies are read. The fixed caller supplies settled only after
 * two equal current-document samples and its normal pending-read checks. */
export function projectMemberSportsPublicTeeSheetDom(root: Element): MemberSportsTeeSheetDomFacts {
  const output: MemberSportsTeeSheetDomFacts = { projectionComplete: false, dateText: "", eventsPresent: false, explicitEmpty: false, groups: [] };
  const dom = {
    text(element: Element | null, maximum: number) { const value = (element?.textContent ?? "").replace(/\s+/gu, " ").trim(); if (value.length > maximum) throw new Error("LIMIT"); return value; },
    hidden(element: Element) {
      let current: Element | null = element;
      for (let depth = 0; current && depth < 80; depth++, current = current.parentElement) {
        const style = current.ownerDocument.defaultView?.getComputedStyle(current);
        if (current.classList.contains("hidden") || current.hasAttribute("hidden") || current.hasAttribute("inert") ||
          current.getAttribute("aria-hidden")?.toLowerCase() === "true" || style?.display === "none" ||
          ["hidden", "collapse"].includes(style?.visibility ?? "") || style?.opacity !== "" && Number(style?.opacity) === 0) return true;
        if (current === root) return false;
      }
      return true;
    },
    minute(value: string) { const match = /^(0?[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/u.exec(value); if (!match) throw new Error("TIME"); return Number(match[1]) % 12 * 60 + Number(match[2]) + (match[3] === "PM" ? 720 : 0); },
  };
  try {
    const containers = [...root.querySelectorAll(".teeTimes")].filter(element => !dom.hidden(element));
    const dates = [...root.querySelectorAll(".dateFormat")].filter(element => !dom.hidden(element));
    if (containers.length !== 1 || dates.length !== 1) return output;
    output.dateText = dom.text(dates[0], 48);
    output.eventsPresent = root.querySelectorAll("app-booking-event-block").length > 0;
    const empties = [...root.querySelectorAll(".noTeeTimes")].filter(element => !dom.hidden(element));
    if (empties.length > 1 || empties.some(element => dom.text(element, 80) !== "No tee times available on this day")) return output;
    output.explicitEmpty = empties.length === 1;
    const groups = [...containers[0].querySelectorAll(":scope > .teeTime")];
    if (groups.length > 500) return output;
    let count = groups.length;
    for (const group of groups) {
      const times = group.querySelectorAll(":scope > .timeCol"), offers = group.querySelectorAll(":scope > .availableBookings");
      if (dom.hidden(group) || times.length !== 1 || offers.length !== 1) return output;
      const result = { minute: dom.minute(dom.text(times[0], 16)), cards: [] as MemberSportsTeeSheetCard[] };
      const cards = [...offers[0].querySelectorAll("app-tee-time-card.bookingCard")];
      if ((count += cards.length) > 500) return output;
      for (const card of cards) {
        const parts = card.querySelectorAll(":scope > .teeTimeCard"); if (parts.length !== 1) return output;
        const part = parts[0], labels = part.querySelectorAll(":scope > .name"), ranges = part.querySelectorAll(".rightCells > .iconCell.first > span");
        if (labels.length !== 1 || ranges.length !== 1) return output;
        const label = dom.text(labels[0], 32), range = dom.text(ranges[0], 12), hidden = dom.hidden(card);
        const rounds = part.querySelectorAll(".iconCell.holes9,.iconCell.holes18,.iconCell.holesBoth");
        // Published desktop emits a hidden blank front placeholder for a
        // back-only pair. It is not an offer; all substantive cards remain.
        if (hidden && label === "" && ["", "-"].includes(range) && rounds.length === 0) continue;
        const match = /^([1-4])-([0-4])$/u.exec(range); if (!match || rounds.length !== 1) return output;
        const round = rounds[0], flags = [round.classList.contains("holes9"), round.classList.contains("holes18"), round.classList.contains("holesBoth")];
        if (flags.filter(Boolean).length !== 1) return output;
        result.cards.push({ label, round: flags[0] ? "9" : flags[1] ? "18" : "BOTH", minimumPlayers: Number(match[1]), maximumPlayers: Number(match[2]), hidden, restricted: part.classList.contains("restricted") });
      }
      output.groups.push(result);
    }
    output.projectionComplete = true; return output;
  } catch { return output; }
}
