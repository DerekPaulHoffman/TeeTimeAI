import { describe, expect, it, vi } from "vitest";

import {
  FOREUP_STANDARD_PUBLIC_SCOPE,
  foreupPublicScheduleCatalogSha256,
  hasCompleteForeupPublicScheduleScope,
  parseForeupPublicConfiguration,
  readForeupPublicConfiguration,
  readForeupStandardPublicSchedule,
  isStandardForeupPublicClass,
} from "./foreup-public-configuration";

const bookingUrl = "https://foreupsoftware.com/index.php/booking/19021#/teetimes";
const schedules = [
  { course_id: "19021", title: "Bridges", teesheet_id: "792", booking_classes: [
    { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0" },
  ] },
  { course_id: "19021", title: "Columbia", teesheet_id: "781", booking_classes: [
    { teesheet_id: "781", booking_class_id: "4930", active: "1", hidden: "0" },
  ] },
];
const html = `<html><script>SCHEDULES = ${JSON.stringify(schedules)};</script></html>`;

describe("explicitly unrestricted public Online Booking", () => {
  const online = { ...schedules[0].booking_classes[0], name: "Online Booking", online_booking_protected: "0", block_online_booking: "0", deleted: "0", pass_item_ids: [""] };
  const document = (value: unknown) => `SCHEDULES=${JSON.stringify([{ ...schedules[0], booking_classes: [value] }])};`;
  it("selects its sole public class with complete schedule coverage", () => {
    expect(isStandardForeupPublicClass(online)).toBe(true);
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Bridges", html: document(online) })).toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(hasCompleteForeupPublicScheduleScope({ html: document(online), facilityId: 19021, scheduleId: 792, inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE })).toBe(true);
  });
  it.each([{ online_booking_protected: "1" }, { block_online_booking: "1" }, { deleted: "1" }, { pass_item_ids: ["123"] },
    { pass_item_ids: undefined }, { online_booking_protected: undefined }, { name: "Online Booking Members" }])("rejects absent public flags or restrictions %j", delta => {
    const row = { ...online, ...delta };
    expect(isStandardForeupPublicClass(row)).toBe(false);
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Bridges", html: document(row) })).toBeNull();
    expect(hasCompleteForeupPublicScheduleScope({ html: document(row), facilityId: 19021, scheduleId: 792, inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE })).toBe(false);
  });
});

describe("managed ForeUP single-sheet coverage", () => {
  const selected = { ...schedules[0], booking_classes: [{ ...schedules[0].booking_classes[0], name: "Public" }] };
  const other = { ...selected, title: "Another Nine", teesheet_id: "999", booking_classes: [{ ...selected.booking_classes[0], teesheet_id: "999", booking_class_id: "9999" }] };
  const covered = (rows: unknown[]) => hasCompleteForeupPublicScheduleScope({ html: `SCHEDULES=${JSON.stringify(rows)};`, facilityId: 19021, scheduleId: 792 });
  it("retains the unique public sheet and existing unlabelled legacy class", () => {
    expect(covered([selected])).toBe(true); expect(covered([schedules[0]])).toBe(true);
  });
  it.each(["same ID", "different ID"])("does not infer a foreign physical venue from %s or a different sheet label", mode => {
    expect(covered([selected, { ...other, course_id: mode === "same ID" ? selected.course_id : "19022", course_name: "Bridges" }])).toBe(false);
  });
  it.each(["Members", "Member Only", "Twilight Member"])("ignores an explicitly member-only sibling: %s", name => {
    expect(covered([selected, { ...other, booking_classes: [{ ...other.booking_classes[0], name }] }])).toBe(true);
  });
  it.each(["hidden", "inactive"])("does not count a publicly labelled but %s sibling", mode => {
    expect(covered([selected, { ...other, booking_classes: [{ ...other.booking_classes[0], ...(mode === "hidden" ? { hidden: "1" } : { active: "0" }) }] }])).toBe(true);
  });
  it.each(["Visitors", "Public Members", "General Tee Times", ""])("keeps ambiguous visible class %s unverified", name => {
    expect(covered([selected, { ...other, booking_classes: [{ ...other.booking_classes[0], name }] }])).toBe(false);
  });
  it.each([undefined, null, {}, [{ ...other.booking_classes[0], hidden: "unknown" }]])("fails closed on unclassifiable sibling classes %j", booking_classes => {
    expect(covered([selected, { ...other, booking_classes }])).toBe(false);
  });
  it("rejects duplicate public rows, absent selected scope and excessive schedules", () => {
    expect(covered([selected, selected])).toBe(false); expect(covered([other])).toBe(false);
    expect(covered(Array.from({ length: 31 }, () => selected))).toBe(false);
  });
});

describe("ordinary Standard Public schedule read", () => {
  const publicClass = { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0", name: "Public" };
  const memberClass = { ...publicClass, booking_class_id: "4932", name: "Members" };
  const makeHtml = (classes: unknown[] = [publicClass, memberClass]) =>
    `<script>SCHEDULES=${JSON.stringify([{ course_id: "19021", title: "Columbia Bridges", teesheet_id: "792", booking_classes: classes }])};</script>`;
  const read = (fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof readForeupStandardPublicSchedule>[0]> = {}) =>
    readForeupStandardPublicSchedule({ bookingUrl, courseName: "Columbia Bridges", scheduleId: 792, fetchImpl, ...overrides });
  const response = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });

  it("selects only the explicit Public class from a fresh mixed catalog with one HTML request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(makeHtml()));
    await expect(read(fetchImpl)).resolves.toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://foreupsoftware.com/index.php/booking/19021");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("rejects absent, stale, duplicate, and unlabelled Public classes", async () => {
    for (const [classes, overrides] of [
      [[{ ...publicClass, name: "Member" }], {}],
      [[publicClass, memberClass], { scheduleId: 793 }],
      [[publicClass, memberClass], { bookingClassId: 4932 }],
      [[publicClass, { ...publicClass, booking_class_id: "4933" }], {}],
      [[{ ...publicClass, name: undefined }], {}],
    ] as const) {
      await expect(read(vi.fn<typeof fetch>().mockResolvedValue(response(makeHtml([...classes]))), overrides))
        .resolves.toBeNull();
    }
  });

  it("rejects a saved sheet-specific booking link to another schedule before any read", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(makeHtml()));
    await expect(read(fetchImpl, { bookingUrl: "https://foreupsoftware.com/index.php/booking/19021/781#/teetimes" }))
      .resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(read(fetchImpl, { bookingUrl: "https://foreupsoftware.com/index.php/booking/19021/792#/teetimes" }))
      .resolves.toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not follow redirects or read an untrusted booking host", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(makeHtml(), 302));
    await expect(read(fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(read(fetchImpl, { bookingUrl: "https://foreupsoftware.com.evil.test/index.php/booking/19021" }))
      .resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("declared Standard Public class inventory", () => {
  const publicClass = { ...schedules[0].booking_classes[0], name: "Public" };
  const alternate = (name: string, id = "4932") => ({ ...publicClass, booking_class_id: id, name });
  const selected = { ...schedules[0], booking_classes: [publicClass, alternate("MEMBER"), alternate("PreferredPlayer", "4933")] };
  const scoped = (rows: unknown[]) => hasCompleteForeupPublicScheduleScope({
    html: `SCHEDULES=${JSON.stringify(rows)};`, facilityId: 19021, scheduleId: 792, inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE,
  });
  it("declares only the unique explicit Public class while leaving unscoped recipes strict", () => {
    expect(scoped([selected])).toBe(true);
    expect(hasCompleteForeupPublicScheduleScope({ html: `SCHEDULES=${JSON.stringify([selected])};`, facilityId: 19021, scheduleId: 792 })).toBe(false);
    expect(foreupPublicScheduleCatalogSha256(`SCHEDULES=${JSON.stringify([selected])};`)).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("rejects duplicate visible class IDs, ambiguous Public classes and malformed selected classes", () => {
    expect(scoped([{ ...selected, booking_classes: [publicClass, alternate("PreferredPlayer", "4931")] }])).toBe(false);
    expect(scoped([{ ...selected, booking_classes: [publicClass, alternate("Public")] }])).toBe(false);
    expect(scoped([{ ...selected, booking_classes: [publicClass, { ...alternate("PreferredPlayer"), active: "unknown" }] }])).toBe(false);
    expect(scoped([{ ...selected, booking_classes: [publicClass, alternate("Preferred\u0000Player")] }])).toBe(false);
  });
  it("keeps a different unresolved sheet strict, including unknown and malformed classes", () => {
    const other = { ...selected, teesheet_id: "793", booking_classes: [{ ...alternate("PreferredPlayer"), teesheet_id: "793" }] };
    expect(scoped([selected, other])).toBe(false);
    expect(scoped([selected, { ...other, booking_classes: undefined }])).toBe(false);
    expect(scoped([selected, { ...other, booking_classes: [{ ...other.booking_classes[0], name: "Public" }] }])).toBe(false);
  });
  it("excludes an independently proven foreign physical course after validating its complete class shapes without changing the catalog digest", () => {
    const other = { ...selected, course_id: "19022", teesheet_id: "793", booking_classes: [{ ...alternate("Visitor Program"), teesheet_id: "793" }] };
    const document = `SCHEDULES=${JSON.stringify([selected, other])};`, digest = foreupPublicScheduleCatalogSha256(document);
    expect(hasCompleteForeupPublicScheduleScope({ html: document, facilityId: 19021, scheduleId: 792,
      inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE, isProvenForeignSchedule: row => row.course_id === "19022" })).toBe(true);
    expect(scoped([selected, other])).toBe(false);
    expect(foreupPublicScheduleCatalogSha256(document)).toBe(digest);
    expect(foreupPublicScheduleCatalogSha256(`SCHEDULES=${JSON.stringify([selected])};`)).not.toBe(digest);
  });
  it.each(["classes", "join", "flags", "id", "duplicate-class", "name", "empty-name", "long-name", "control-name", "hidden-name", "duplicate-sheet"])(
    "rejects malformed %s even for an independently proven foreign course", mode => {
      const other = { ...selected, course_id: "19022", teesheet_id: "793", booking_classes: [{ ...alternate("Visitor Program"), teesheet_id: "793" }] };
      const entry = other.booking_classes[0];
      if (mode === "join") entry.teesheet_id = "794";
      if (mode === "flags") entry.hidden = "unknown";
      if (mode === "id") entry.booking_class_id = "0";
      if (mode === "duplicate-class") other.booking_classes.push({ ...entry });
      if (mode === "empty-name") entry.name = " ";
      if (mode === "long-name") entry.name = "x".repeat(301);
      if (mode === "control-name") entry.name = "Visitor\u0000Program";
      const value: Record<string, unknown> = other;
      if (mode === "classes") value.booking_classes = undefined;
      if (mode === "name" || mode === "hidden-name") {
        value.booking_classes = [{ ...entry, name: undefined, ...(mode === "hidden-name" ? { hidden: "1" } : {}) }];
      }
      const rows = mode === "duplicate-sheet" ? [selected, value, value] : [selected, value];
      expect(hasCompleteForeupPublicScheduleScope({ html: `SCHEDULES=${JSON.stringify(rows)};`, facilityId: 19021, scheduleId: 792,
        inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE, isProvenForeignSchedule: row => row.course_id === "19022" })).toBe(false);
    });
});

describe("public ForeUp schedule configuration", () => {
  const ownerName = "Harbor Golf Course at Lakeside";
  const ownerSchedule = { ...schedules[0], course_name: ownerName, title: "North Tee Sheet", booking_classes: [
    { ...schedules[0].booking_classes[0], name: "Public Tee Times" },
  ] };
  const ownerParse = (rows: unknown[] = [ownerSchedule], courseName = ownerName) => parseForeupPublicConfiguration({
    bookingUrl, courseName, html: `<script>SCHEDULES = ${JSON.stringify(rows)};</script>`,
  });
  it("binds the explicit same-facility owner name independently of its tee-sheet title", () => {
    expect(ownerParse()).toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(ownerParse([{ ...ownerSchedule, course_name: " HARBOR Golf Club at Lakeside " }])).toMatchObject({ scheduleId: 792 });
    expect(ownerParse([{ ...ownerSchedule, course_name: "Harbor Golf Course" }])).toBeNull();
    expect(ownerParse([{ ...ownerSchedule, course_id: "999" }])).toBeNull();
    expect(ownerParse([{ ...ownerSchedule, title: "" }])).toBeNull();
    expect(ownerParse([ownerSchedule, { ...ownerSchedule, teesheet_id: "793" }])).toBeNull();
    expect(ownerParse([{ ...ownerSchedule, booking_classes: [ownerSchedule.booking_classes[0], { ...ownerSchedule.booking_classes[0], booking_class_id: "4932" }] }])).toBeNull();
    expect(ownerParse([{ ...ownerSchedule, booking_classes: [{ ...ownerSchedule.booking_classes[0], hidden: "1" }] }])).toBeNull();
    expect(ownerParse([{ ...ownerSchedule, booking_classes: [{ ...ownerSchedule.booking_classes[0], teesheet_id: "781" }] }])).toBeNull();
  });
  it.each([null, 42, {}, [], "", "   ", "x".repeat(301), "Harbor\u0000 at Lakeside"])
  ("rejects a present malformed owner even with an otherwise matching title: %j", course_name => {
    expect(ownerParse([{ ...ownerSchedule, title: ownerName, course_name }])).toBeNull();
  });
  it("accepts a legitimate different owner descriptor with the matching same-facility tee-sheet title", () => {
    for (const course_name of ["Harbor Leisure Company", "Harbor at Lakeside Annex", "City"])
      expect(ownerParse([{ ...ownerSchedule, title: ownerName, course_name }])).toMatchObject({ scheduleId: 792 });
    expect(ownerParse([{ ...ownerSchedule, title: "Another North Tee Sheet", course_name: "Another Harbor at Lakeside" }])).toBeNull();
    expect(ownerParse([{ ...ownerSchedule, course_id: "999", title: ownerName, course_name: "Harbor Leisure Company" }])).toBeNull();
  });
  it("retains the absent-owner legacy title path without accepting malformed owner data", () => {
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html })).toMatchObject({ scheduleId: 792 });
    expect(ownerParse([{ ...ownerSchedule, title: ownerName, course_name: null }])).toBeNull();
  });
  it("compares a sole course schedule after only an anchored comma hospitality descriptor", () => {
    const schedule = { ...schedules[0], title: "Harbor Golf Course", booking_classes: [
      { ...schedules[0].booking_classes[0], name: "Public Tee Times" },
    ] };
    const parse = (courseName: string, rows: unknown[] = [schedule]) => parseForeupPublicConfiguration({
      bookingUrl, courseName, html: `<script>SCHEDULES = ${JSON.stringify(rows)};</script>`,
    });
    for (const name of ["Harbor Golf Course, Restaurant and Banquet Facility", "Harbor Golf Course,  RESTAURANT and BANQUET facility  "])
      expect(parse(name)).toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    for (const name of ["Harbor Golf Course Restaurant and Banquet Facility", "Harbor Golf Course, Restaurant and Banquet Facility Annex",
      "Harbor Golf Course, Restaurant and Banquet Facilities", "Harbor Golf Course, Restaurant", "Harbor Golf Course East, Restaurant and Banquet Facility",
      "Harbor Golf Course, Private Members Course", "Another Venue, Restaurant and Banquet Facility"])
      expect(parse(name)).toBeNull();
    const name = "Harbor Golf Course, Restaurant and Banquet Facility";
    expect(parse(name, [schedule, schedule])).toBeNull();
    expect(parse(name, [{ ...schedule, course_id: "999" }])).toBeNull();
    expect(parse(name, [{ ...schedule, booking_classes: [{ ...schedule.booking_classes[0], hidden: "1" }] }])).toBeNull();
    expect(parse(name, [{ ...schedule, booking_classes: [{ ...schedule.booking_classes[0], teesheet_id: "781" }] }])).toBeNull();
    expect(parse(name, [{ ...schedule, booking_classes: [schedule.booking_classes[0], { ...schedule.booking_classes[0], booking_class_id: "4932" }] }])).toBeNull();
  });

  it("selects the sole exact Public Play class without treating other visible membership classes as public", () => {
    const publicPlay = { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0", name: "Public Play" };
    const document = (classes: object[]) => `<script>SCHEDULES = ${JSON.stringify([{ ...schedules[0], booking_classes: classes }])};</script>`;
    const parse = (classes: object[]) => parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html: document(classes) });
    expect(parse([publicPlay, { ...publicPlay, booking_class_id: "4932", name: "Twilight Member" }]))
      .toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(parse([{ ...publicPlay, name: " public PLAY " }])).toMatchObject({ bookingClassId: 4931 });
    for (const name of ["Public", "Public Play", "Public Tee Times", "Online Tee Times"])
      expect(parse([publicPlay, { ...publicPlay, booking_class_id: "4932", name }])).toBeNull();
    for (const name of ["Public Play Members", "Members Public Play", "Public Play (Residents)", "Public Play Special", "PublicPlay", "Under 25/Under 30/Under 35"])
      expect(parse([{ ...publicPlay, name }])).toBeNull();
    expect(parse([{ ...publicPlay, active: "0" }])).toBeNull();
    expect(parse([{ ...publicPlay, hidden: "1" }])).toBeNull();
    expect(parse([{ ...publicPlay, teesheet_id: "781" }])).toBeNull();
  });

  it.each(["#teetimes", "#/", "#/teetimes", ""])("reads the exact indexed public landing %s and derives its schedule without rewriting the source", async fragment => {
    const indexed = "https://foreupsoftware.com/index.php/booking/index/19021" + fragment;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(html, { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(Response.json([]));
    expect(await readForeupPublicConfiguration({ bookingUrl: indexed, courseName: "Columbia Bridges", fetchImpl }))
      .toEqual({ sourceBookingUrl: indexed, bookingBaseUrl: indexed, scheduleId: 792, bookingClassId: 4931 });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(indexed.split("#")[0]);
    const api = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(api.searchParams.get("schedule_id")).toBe("792");
    expect(api.searchParams.get("booking_class")).toBe("4931");
    expect(parseForeupPublicConfiguration({ bookingUrl: indexed, courseName: "Other Venue", html })).toBeNull();
    expect(parseForeupPublicConfiguration({ bookingUrl: indexed.replace("19021", "19022"), courseName: "Columbia Bridges", html })).toBeNull();
  });

  it.each(["#/store", "#/checkout", "#/reserve?slot=1", "#/%2flogin"])("does not read a non-public indexed view %s", async fragment => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await readForeupPublicConfiguration({ bookingUrl: "https://foreupsoftware.com/index.php/booking/index/19021" + fragment, courseName: "Columbia Bridges", fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["index/0", "index/01", "index/-1", "index/19021/792", "index/index/19021", "Index/19021", "index/19021/checkout"])
  ("rejects unobserved or malformed indexed route %s before fetching", async path => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await readForeupPublicConfiguration({ bookingUrl: `https://foreupsoftware.com/index.php/booking/${path}#teetimes`, courseName: "Columbia Bridges", fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("selects only the exact course-specific schedule from a shared official landing", () => {
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html })).toEqual({
      sourceBookingUrl: bookingUrl,
      bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/19021/792#/teetimes",
      scheduleId: 792,
      bookingClassId: 4931,
    });
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Golf Club", html }))
      .toMatchObject({ scheduleId: 781, bookingClassId: 4930 });
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Another Bridges", html }))
      .toMatchObject({ scheduleId: 792 });
  });

  it("rejects ambiguous, hidden, off-facility, or transaction-shaped evidence", () => {
    const parse = (value: unknown, url = bookingUrl) => parseForeupPublicConfiguration({
      bookingUrl: url, courseName: "Columbia Bridges",
      html: `<script>SCHEDULES = ${JSON.stringify(value)};</script>`,
    });
    expect(parse([{ ...schedules[0], course_id: "999" }])).toBeNull();
    expect(parse([schedules[0], schedules[0]])).toBeNull();
    expect(parse([{ ...schedules[0], booking_classes: [
      { ...schedules[0].booking_classes[0], hidden: "1" },
    ] }])).toBeNull();
    expect(parse(schedules, "https://evilforeupsoftware.com/index.php/booking/19021")).toBeNull();
    expect(parse(schedules, "https://foreupsoftware.com/index.php/booking/19021#/checkout")).toBeNull();
    expect(parse(schedules, "https://foreupsoftware.com/index.php/booking/19021?token=abc")).toBeNull();
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html: `${html}${html}` })).toBeNull();
  });

  it("requires a successful public API read before returning runnable metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html, {
      status: 200, headers: { "content-type": "text/html" },
    })).mockResolvedValueOnce(new Response("[]", {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect(await readForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", fetchImpl }))
      .toMatchObject({ scheduleId: 792 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const apiRequest = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(apiRequest.pathname).toBe("/index.php/api/booking/times");
    expect(apiRequest.searchParams.get("schedule_id")).toBe("792");
    expect(apiRequest.searchParams.get("booking_class")).toBe("4931");

    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html, {
      status: 200, headers: { "content-type": "text/html" },
    })).mockResolvedValueOnce(new Response("Access Denied", { status: 403 }));
    expect(await readForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", fetchImpl: blocked }))
      .toBeNull();
    expect(blocked).toHaveBeenCalledTimes(2);
  });

  it("selects the sole explicit Public class from a venue's Tee Sheet without membership assumptions", () => {
    const classes = [
      { teesheet_id: "792", booking_class_id: "4932", active: "1", hidden: "0", name: "Annual Members" },
      { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0", name: " Public " },
      { teesheet_id: "792", booking_class_id: "4933", active: "1", hidden: "0", name: "Mens Club Members" },
    ];
    const parse = (bookingClasses: unknown[], title = "Harbor Tee Sheet") => parseForeupPublicConfiguration({
      bookingUrl, courseName: "Harbor Golf Course", html: `<script>SCHEDULES = ${JSON.stringify([
        { course_id: "19021", title, teesheet_id: "792", booking_classes: bookingClasses },
      ])};</script>`,
    });
    expect(parse(classes)).toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(parse([classes[0]])).toBeNull();
    expect(parse(classes.filter(row => row.name !== " Public "))).toBeNull();
    expect(parse([...classes, { ...classes[1], booking_class_id: "4934" }])).toBeNull();
    expect(parse(classes.map(row => row.name === " Public " ? { ...row, hidden: "1" } : row))).toBeNull();
    expect(parse(classes, "Another Harbor Tee Sheet")).toBeNull();
    expect(parse(classes, "Harbor Tee Sheet Practice")).toBeNull();
  });

  it("recognizes only a sole exact Online Tee Times public class on the selected schedule", async () => {
    const online = { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0", name: "Online Tee Times" };
    const member = { ...online, booking_class_id: "4932", name: "Annual Members" };
    const document = (classes: object[]) => `<script>SCHEDULES = ${JSON.stringify([
      { ...schedules[0], booking_classes: classes },
      { ...schedules[1], booking_classes: [{ ...online, teesheet_id: "781", booking_class_id: "4930" }] },
    ])};</script>`;
    const parse = (classes: object[]) => parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html: document(classes) });
    expect(parse([online])).toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(parse([member, { ...online, name: " online tee times " }])).toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(parse([{ ...online, active: "0" }])).toBeNull();
    expect(parse([{ ...online, hidden: "1" }])).toBeNull();
    expect(parse([{ ...online, teesheet_id: "781" }])).toBeNull();
    expect(parse([online, { ...online, booking_class_id: "4933" }])).toBeNull();
    expect(parse([online, { ...online, booking_class_id: "4933", name: "Public" }])).toBeNull();

    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(document([online]), { status: 200, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    expect(await readForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", fetchImpl }))
      .toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get("booking_class")).toBe("4931");
  });

  it("selects exact Public Tee Times alongside restricted classes and reads that class", async () => {
    const publicClass = { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0", name: "Public Tee Times" };
    const memberClass = { ...publicClass, booking_class_id: "4932", name: "Members Club Tee Times" };
    const document = (classes: object[]) => `<script>SCHEDULES = ${JSON.stringify([
      { ...schedules[0], booking_classes: classes },
      { ...schedules[1], booking_classes: [{ ...publicClass, teesheet_id: "781", booking_class_id: "4930" }] },
    ])};</script>`;
    const parse = (classes: object[]) => parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html: document(classes) });
    expect(parse([memberClass, { ...publicClass, name: " public tee times " }]))
      .toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(parse([{ ...publicClass, active: "0" }, memberClass])).toBeNull();
    expect(parse([{ ...publicClass, hidden: "1" }, memberClass])).toBeNull();
    expect(parse([{ ...publicClass, teesheet_id: "781" }, memberClass])).toBeNull();
    expect(parse([publicClass, { ...publicClass, booking_class_id: "4933" }])).toBeNull();
    for (const name of ["Public", "Online Tee Times"]) {
      expect(parse([publicClass, { ...publicClass, booking_class_id: "4933", name }])).toBeNull();
    }

    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(document([memberClass, publicClass]), { status: 200, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    expect(await readForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", fetchImpl }))
      .toMatchObject({ scheduleId: 792, bookingClassId: 4931 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get("booking_class")).toBe("4931");
  });

  it.each(["Members Online Tee Times", "Online Tee Times Members", "Online Tee Times (Residents)",
    "Account Tee Times", "Member", "Resident", "Online Tee Times Special", "OnlineTeeTimes",
    "Members Public Tee Times", "Public Tee Times Members", "Public Tee Times (Residents)",
    "Public Tee Times Special", "PublicTeeTimes", ""])
  ("does not infer public access from restricted or near-match label %s", name => {
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges",
      html: `<script>SCHEDULES = ${JSON.stringify([{ ...schedules[0], booking_classes: [
        { ...schedules[0].booking_classes[0], name },
      ] }])};</script>`,
    })).toBeNull();
  });
});
