import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeMemberSportsPublicTeeSheet as normalize, projectMemberSportsPublicTeeSheetDom as project,
  type MemberSportsTeeSheetContext, type MemberSportsTeeSheetDomFacts, type MemberSportsTeeSheetCard } from "./membersports-public-tee-sheet";

const dateText = "Fri, Oct 23, 2026";
function context(): MemberSportsTeeSheetContext {
  return { documentUrl: "https://app.membersports.com/tee-times/123/456/0", requestUrl: "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes", requestMethod: "POST",
    requestBody: JSON.stringify({ configurationTypeId: 0, date: "2026-10-23", golfClubGroupId: 0, golfClubId: 123, golfCourseId: 456, groupSheetTypeId: 0 }),
    input: { date: "2026-10-23", players: 2, startTime: "08:00", endTime: "18:00" }, voucherApplied: false,
    metadata: { courses: [{ golfCourseId: 456, name: "Synthetic Public Course", holes: 18, isSelected: true, rotationTypeId: 0 }],
      parameters: [{ configurationTypeId: 0, isSelected: true, allowFivesomes: false, onlyClubMembersCanReserve: false, minimumNumberOfPlayers: 1,
        allowSinglesToBookOnline: true, alwaysShowBackNine: false, enableMaximumDailyTeeTimes: false }],
      bookingCounts: { hasCustomTeeTimeLimit: false, enableMaximumTeeTimes: false, limitTeeTimesPerMembership: false } } };
}
function item(id = 1, minute = 810, changes: Record<string, unknown> = {}) {
  return { teeTimeId: id, golfClubId: 123, golfCourseId: 456, configurationTypeId: 0, rotationNumber: 1,
    teeTime: minute, isBackNine: false, playerCount: 0, backNinePlayerCount: 0, minimumNumberOfPlayers: 1,
    holesRequirementTypeId: 1, threeWayHolesRequirementTypeId: 0, allowSinglesToBookOnline: true,
    ruleOverridesMinimumPlayer: false, bookingNotAllowed: false, hide: false, hasBackNineEvent: false, availableCount: 0, ...changes };
}
function card(changes: Partial<MemberSportsTeeSheetCard> = {}): MemberSportsTeeSheetCard {
  return { label: "Front", round: "9", minimumPlayers: 1, maximumPlayers: 4, hidden: false, restricted: false, ...changes };
}
function dom(groups: MemberSportsTeeSheetDomFacts["groups"] = [{ minute: 810, cards: [card()] }]): MemberSportsTeeSheetDomFacts {
  return { projectionComplete: true, settled: true, dateText, groups, eventsPresent: false, explicitEmpty: false };
}

describe("full original public tee-sheet normalization and DOM parity", () => {
  it("derives public capacity despite raw availableCount0 and retains empty desktop time groups", () => {
    const response = [{ teeTime: 810, items: [item()] }, { teeTime: 820, items: [] }, { teeTime: 830, items: [item(2, 830, { playerCount: 2, holesRequirementTypeId: 2 })] }];
    const result = normalize(response, context(), dom([{ minute: 810, cards: [card()] }, { minute: 820, cards: [] }, { minute: 830, cards: [card({ round: "18", maximumPlayers: 2 })] }]));
    expect(result).toEqual({ status: "VERIFIED", complete: true, emptyVerified: false, slots: [
      { sourceId: "membersports-123-456-1", minute: 810, availableSpots: 4, minimumPlayers: 1, roundHoles: 9 },
      { sourceId: "membersports-123-456-2", minute: 830, availableSpots: 2, minimumPlayers: 1, roundHoles: 18 },
    ] });
  });
  it("uses the limiting back-nine count and exact three-way substitution instead of wire count", () => {
    const response = [{ teeTime: 810, items: [item()] }, { teeTime: 820, items: [item(2, 820, { holesRequirementTypeId: 0, threeWayHolesRequirementTypeId: 2, backNinePlayerCount: 3, availableCount: 999 })] }];
    const result = normalize(response, context(), dom([{ minute: 810, cards: [card()] }, { minute: 820, cards: [card({ round: "18", maximumPlayers: 1 })] }]));
    expect(result.status).toBe("VERIFIED"); expect(result.slots).toHaveLength(2);
    expect(result.slots[1]).toMatchObject({ availableSpots: 1, minimumPlayers: 1 });
  });
  it("lowers minimum only under the published partially-filled singles rule", () => {
    const input = context(); input.input.players = 1;
    const result = normalize([{ teeTime: 810, items: [item(1, 810, { playerCount: 1, minimumNumberOfPlayers: 2 })] }], input, dom([{ minute: 810, cards: [card({ maximumPlayers: 3 })] }]));
    expect(result.status).toBe("VERIFIED"); expect(result.slots[0]?.minimumPlayers).toBe(1);
    const full = normalize([{ teeTime: 810, items: [item(1, 810, { minimumNumberOfPlayers: 2 })] }], input, dom([{ minute: 810, cards: [card({ minimumPlayers: 2 })] }]));
    expect(full).toMatchObject({ status: "VERIFIED", complete: true, emptyVerified: false });
    expect(full.slots[0]?.minimumPlayers).toBe(2);
  });
  it("compares hidden/restricted cards and never counts a restricted range as available", () => {
    const response = [{ teeTime: 810, items: [item()] }, { teeTime: 820, items: [item(2, 820, { bookingNotAllowed: true })] },
      { teeTime: 830, items: [item(3, 830, { playerCount: 3, allowSinglesToBookOnline: false })] }];
    const result = normalize(response, context(), dom([{ minute: 810, cards: [card()] }, { minute: 820, cards: [card({ restricted: true })] },
      { minute: 830, cards: [card({ hidden: true, maximumPlayers: 1 })] }]));
    expect(result.status).toBe("VERIFIED"); expect(result.slots).toHaveLength(1);
  });
  it("supports explicit front/back ordering, whole list permutation and BOTH without physical layout claims", () => {
    const response = [{ teeTime: 810, items: [item(2, 810, { isBackNine: true }), item(1, 810, { holesRequirementTypeId: 0 })] }];
    const result = normalize(response, context(), dom([{ minute: 810, cards: [card({ label: "Back" }), card({ round: "BOTH" })] }]));
    expect(result.status).toBe("VERIFIED"); expect(result.slots.some(row => row.roundHoles === null)).toBe(true);
  });
  it("retains all time rows for central window filtering and still validates out-of-window rows", () => {
    const c = context(); c.input.startTime = "13:30"; c.input.endTime = "13:40";
    const response = [{ teeTime: 810, items: [item()] }, { teeTime: 820, items: [item(2, 820)] }], facts = dom([{ minute: 810, cards: [card()] }, { minute: 820, cards: [card()] }]);
    expect(normalize(response, c, facts).slots.map(row => row.minute)).toEqual([810, 820]);
    response[1].items[0].minimumNumberOfPlayers = 0;
    expect(normalize(response, c, facts)).toMatchObject({ status: "INCOMPLETE", reason: "ROW_INVALID" });
  });
  it("returns the same complete public offers across ordinary requested players and windows", () => {
    const response = [{ teeTime: 810, items: [item(1, 810, { minimumNumberOfPlayers: 3 })] },
      { teeTime: 820, items: [item(2, 820, { playerCount: 2 })] }];
    const facts = dom([{ minute: 810, cards: [card({ minimumPlayers: 3 })] }, { minute: 820, cards: [card({ maximumPlayers: 2 })] }]);
    const expected = { status: "VERIFIED", complete: true, emptyVerified: false, slots: [
      { sourceId: "membersports-123-456-1", minute: 810, availableSpots: 4, minimumPlayers: 3, roundHoles: 9 },
      { sourceId: "membersports-123-456-2", minute: 820, availableSpots: 2, minimumPlayers: 1, roundHoles: 9 },
    ] };
    for (const players of [1, 2, 3, 4]) for (const [startTime, endTime] of [["00:00", "01:00"], ["13:30", "13:40"], ["18:00", "24:00"]]) {
      const c = context(); c.input = { ...c.input, players, startTime, endTime };
      expect(normalize(response, c, facts)).toEqual(expected);
    }
  });
  it("excludes zero-capacity and unbookable ranges only after validating their complete DOM parity", () => {
    const response = [{ teeTime: 810, items: [item()] }, { teeTime: 820, items: [item(2, 820, { playerCount: 4 })] },
      { teeTime: 830, items: [item(3, 830, { playerCount: 2, minimumNumberOfPlayers: 3, allowSinglesToBookOnline: false, ruleOverridesMinimumPlayer: true })] }];
    const facts = dom([{ minute: 810, cards: [card()] }, { minute: 820, cards: [card({ maximumPlayers: 0 })] },
      { minute: 830, cards: [card({ minimumPlayers: 3, maximumPlayers: 2 })] }]);
    const result = normalize(response, context(), facts);
    expect(result).toMatchObject({ status: "VERIFIED", complete: true, emptyVerified: false });
    expect(result.slots.map(row => row.sourceId)).toEqual(["membersports-123-456-1"]);
    facts.groups[1].cards[0].maximumPlayers = 1;
    expect(normalize(response, context(), facts)).toMatchObject({ status: "INCOMPLETE", reason: "DOM_PARITY_MISMATCH" });
    facts.groups[1].cards[0].maximumPlayers = 0;
    response[1].items[0].minimumNumberOfPlayers = 0;
    expect(normalize(response, context(), facts)).toMatchObject({ status: "INCOMPLETE", reason: "ROW_INVALID" });
  });
  it.each(["playerCount", "backNinePlayerCount", "minimumNumberOfPlayers", "holesRequirementTypeId", "threeWayHolesRequirementTypeId", "allowSinglesToBookOnline", "ruleOverridesMinimumPlayer", "bookingNotAllowed", "isBackNine", "hide", "hasBackNineEvent", "rotationNumber", "teeTimeId", "teeTime"])("rejects missing necessary %s without a default or silent skip", key => {
    const row: Record<string, unknown> = item(); delete row[key];
    expect(normalize([{ teeTime: 810, items: [row] }], context(), dom()).status).toBe("INCOMPLETE");
  });
  it.each([{ playerCount: 5 }, { playerCount: -1 }, { backNinePlayerCount: 5 }, { minimumNumberOfPlayers: 0 }, { minimumNumberOfPlayers: 5 },
    { holesRequirementTypeId: 3 }, { threeWayHolesRequirementTypeId: 3 }, { teeTime: 811 }, { allowSinglesToBookOnline: "true" }, { teeTimeId: "" }, { rotationNumber: -1 }])("rejects malformed count, rule or identity %j", delta => {
    expect(normalize([{ teeTime: 810, items: [item(1, 810, delta)] }], context(), dom()).status).toBe("INCOMPLETE");
  });
  it.each([{ golfClubId: 124 }, { golfCourseId: 457 }, { configurationTypeId: 1 }])("keeps each row bound to the exact current request identity %j", delta => {
    expect(normalize([{ teeTime: 810, items: [item(1, 810, delta)] }], context(), dom())).toMatchObject({ status: "INCOMPLETE", reason: "IDENTITY_MISMATCH" });
  });
  it("rejects duplicate groups/items/rotations and unknown back-nine events", () => {
    for (const response of [[{ teeTime: 810, items: [item(), item()] }], [{ teeTime: 810, items: [item()] }, { teeTime: 810, items: [] }],
      [{ teeTime: 810, items: [item(), item(2)] }], [{ teeTime: 810, items: [item(1, 810, { hasBackNineEvent: true })] }]])
      expect(normalize(response, context(), dom()).status).toBe("INCOMPLETE");
  });
  it.each(["courses", "parameters", "bookingCounts"])("requires explicit full current %s metadata", key => {
    const c = context(); delete (c.metadata as Partial<MemberSportsTeeSheetContext["metadata"]>)[key as keyof typeof c.metadata];
    expect(normalize([{ teeTime: 810, items: [item()] }], c, dom()).status).toBe("INCOMPLETE");
  });
  it("uses raw route-bound metadata without depending on mutable selection or unused rotation fields", () => {
    const c = context();
    delete (c.metadata.courses as Record<string, unknown>[])[0].isSelected;
    delete (c.metadata.courses as Record<string, unknown>[])[0].rotationTypeId;
    delete (c.metadata.parameters as Record<string, unknown>[])[0].isSelected;
    expect(normalize([{ teeTime: 810, items: [item()] }], c, dom()).status).toBe("VERIFIED");
    (c.metadata.parameters as Record<string, unknown>[])[0].configurationTypeId = 1;
    expect(normalize([{ teeTime: 810, items: [item()] }], c, dom()).status).toBe("INCOMPLETE");
  });
  it("rejects nonpublic, multicourse, custom or ambiguous metadata", () => {
    const cases = [context(), context(), context(), context(), context(), context()];
    (cases[0].metadata.courses as unknown[]).push({ golfCourseId: 999 });
    delete (cases[1].metadata.parameters as Record<string, unknown>[])[0].configurationTypeId;
    (cases[2].metadata.parameters as Record<string, unknown>[])[0].onlyClubMembersCanReserve = true;
    (cases[3].metadata.parameters as unknown[]).push((cases[3].metadata.parameters as unknown[])[0]);
    (cases[4].metadata.bookingCounts as Record<string, unknown>).hasCustomTeeTimeLimit = true;
    delete (cases[5].metadata.parameters as Record<string, unknown>[])[0].allowFivesomes;
    for (const c of cases) expect(normalize([{ teeTime: 810, items: [item()] }], c, dom()).status).toBe("INCOMPLETE");
  });
  it("requires strict current public document/body/date and ordinary player/window context", () => {
    const cases = [context(), context(), context(), context(), context(), context(), context()];
    cases[0].documentUrl += "?profile=0"; cases[1].requestMethod = "GET"; cases[2].requestBody = cases[2].requestBody.replace("2026-10-23", "10/23/2026");
    cases[3].input.date = "2026-10-24"; cases[4].input.players = 0; cases[5].input.endTime = "08:00";
    cases[6].requestBody = cases[6].requestBody.replace("\"groupSheetTypeId\":0", "\"groupSheetTypeId\":0,\"memberProfileId\":0");
    for (const c of cases) expect(normalize([{ teeTime: 810, items: [item()] }], c, dom()).status).toBe("INCOMPLETE");
  });
  it.each([{}, { settled: false }, { projectionComplete: false }, { eventsPresent: true }, { dateText: "Fri, Oct 23" }, { dateText: "Sat, Oct 23, 2026" }])("does not infer a settled dated no-event document from %j", delta => {
    const facts = dom(); if (!Object.keys(delta).length) delete facts.settled; else Object.assign(facts, delta);
    expect(normalize([{ teeTime: 810, items: [item()] }], context(), facts)).toMatchObject({ status: "INCOMPLETE", reason: "DOM_INCOMPLETE" });
  });
  it("rejects narrowed/extra/duplicated/malformed DOM and omitted empty groups", () => {
    const response = [{ teeTime: 810, items: [item()] }, { teeTime: 820, items: [] }];
    const good = dom([{ minute: 810, cards: [card()] }, { minute: 820, cards: [] }]);
    const cases = [structuredClone(good), structuredClone(good), structuredClone(good), structuredClone(good), structuredClone(good)];
    cases[0].groups.pop(); cases[1].groups[0].cards.push(card()); cases[2].groups[0].cards[0].restricted = true;
    cases[3].groups[0].cards[0].round = "18"; cases[4].groups[0].cards[0].maximumPlayers = 3;
    for (const facts of cases) expect(normalize(response, context(), facts)).toMatchObject({ status: "INCOMPLETE", reason: "DOM_PARITY_MISMATCH" });
  });
  it("permits EMPTY only with full valid data, explicit settled no-times, no events and parity", () => {
    const facts = dom([]); facts.explicitEmpty = true;
    expect(normalize([], context(), facts)).toEqual({ status: "VERIFIED", complete: true, slots: [], emptyVerified: true });
    expect(normalize([{ teeTime: 810, items: [] }], context(), facts)).toMatchObject({ status: "VERIFIED", emptyVerified: true });
    expect(normalize([], context(), dom([]))).toMatchObject({ status: "INCOMPLETE", reason: "EMPTY_UNPROVEN" });
    expect(normalize({ data: [] }, context(), facts).status).toBe("INCOMPLETE");
    expect(normalize([{ teeTime: 810, items: null }], context(), facts).status).toBe("INCOMPLETE");
  });
  it("bounds the full collection and never reads or persists wire capacity/private extras", () => {
    const row = item(); Object.defineProperty(row, "availableCount", { get() { throw new Error("MUST_NOT_READ"); } });
    Object.assign(row, { unrelatedPrivateValue: "NEVER_OUTPUT_PRIVATE" });
    const result = normalize([{ teeTime: 810, items: [row] }], context(), dom());
    expect(result.status).toBe("VERIFIED"); expect(JSON.stringify(result)).not.toContain("NEVER_OUTPUT_PRIVATE");
    expect(normalize(Array.from({ length: 501 }, (_, teeTime) => ({ teeTime, items: [] })), context(), dom([])).status).toBe("INCOMPLETE");
  });
});

const htmlCard = (label = "Front", range = "1-4", round = "holes9", extra = "") => `<div class="courseRow ${extra}"><app-tee-time-card class="bookingCard"><div class="teeTimeCard"><div class="name">${label}</div><div class="rightCells"><div class="iconCell first"><span>${range}</span></div><div class="iconCell ${round}"></div></div></div></app-tee-time-card></div>`;
const html = (cards = htmlCard()) => `<div class="dateFormat">${dateText}</div><div class="teeTimes"><div class="teeTime"><div class="timeCol">01:30 PM</div><div class="availableBookings">${cards}</div></div><div class="teeTime"><div class="timeCol">01:40 PM</div><div class="availableBookings"></div></div></div>`;
describe("passive primary-class DOM projection", () => {
  it("captures complete groups/cards, empty time labels, round/range and hidden/restricted state only", () => {
    document.body.innerHTML = html(htmlCard() + htmlCard("Back", "1-3", "holes18", "hidden").replace('class="teeTimeCard"', 'class="teeTimeCard restricted"'));
    const facts = project(document.body);
    expect(facts).toMatchObject({ projectionComplete: true, eventsPresent: false, explicitEmpty: false, dateText, groups: [
      { minute: 810, cards: [card(), card({ label: "Back", round: "18", maximumPlayers: 3, hidden: true, restricted: true })] }, { minute: 820, cards: [] },
    ] });
    expect(facts.settled).toBeUndefined();
  });
  it.each([
    (s: string) => s.replace("01:30 PM", "13:30"),
    (s: string) => s.replace("1-4", "up to 4"),
    (s: string) => s.replace("holes9", "holes9 holes18"),
    (s: string) => s.replace('class="dateFormat"', 'class="unprovenDate"'),
  ])("fails closed on a changed or incomplete primary DOM shape", change => {
    document.body.innerHTML = change(html()); expect(project(document.body).projectionComplete).toBe(false);
  });
  it("retains actual event presence and exact explicit empty text rather than treating absence as success", () => {
    document.body.innerHTML = `<div class="dateFormat">${dateText}</div><div class="teeTimes"></div><div class="noTeeTimes">No tee times available on this day</div><app-booking-event-block></app-booking-event-block>`;
    expect(project(document.body)).toMatchObject({ projectionComplete: true, eventsPresent: true, explicitEmpty: true, groups: [] });
    document.body.querySelector(".noTeeTimes")!.textContent = "Something failed";
    expect(project(document.body).projectionComplete).toBe(false);
  });
  it.each(["opacity", "inert", "depth"])("does not certify content behind an outer %s visibility boundary", boundary => {
    const content = boundary === "opacity" ? `<div style="opacity:0">${html()}</div>` : boundary === "inert" ? `<div inert>${html()}</div>` :
      "<div>".repeat(81) + html() + "</div>".repeat(81);
    document.body.innerHTML = content;
    const facts = project(document.body);
    expect(facts.projectionComplete).toBe(false);
    expect(normalize([{ teeTime: 810, items: [item()] }], context(), { ...facts, settled: true }).status).toBe("INCOMPLETE");
  });
  it("survives actual tsx serialization as a self-contained passive function", () => {
    const program = `import {JSDOM} from 'jsdom';import * as loaded from './src/lib/course-discovery/membersports-public-tee-sheet.ts';const project=loaded.projectMemberSportsPublicTeeSheetDom??loaded.default?.projectMemberSportsPublicTeeSheetDom;const serialized=(0,eval)('('+project.toString()+')');const d=new JSDOM(${JSON.stringify(html())});const result=serialized(d.window.document.body);process.stdout.write(JSON.stringify(result));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { cwd: process.cwd(), encoding: "utf8", timeout: 10000, maxBuffer: 16000, windowsHide: true });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ projectionComplete: true, groups: [{ minute: 810, cards: [card()] }, { minute: 820, cards: [] }] });
  });
});
