import { describe, expect, it } from "vitest";
import { assertSimulatorResearchFallbackBeforeRetry, currentSimulatorResearchBlockedRoutes, getSimulatorResearchGuide, getSimulatorResearchRetryGuide, getSimulatorResearchObservationFingerprint, getSimulatorResearchImplementationVersion, mergeSimulatorResearchBlockedRoutes, readSettledSimulatorPublicCheckpoint, readSimulatorResearchFailureMemory, readSimulatorResearchState, selectSimulatorResearchTarget, SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION } from "./simulator-support-research-policy";

const fingerprint = "a".repeat(64), now = new Date("2026-10-06T20:00:00Z");
const officialUrl = "https://venue.example.test", bookingUrl = "https://calendar.example.test/booking/bays";
const empty = () => readSimulatorResearchState(undefined, fingerprint);
const select = (state = empty(), rest = {}) => selectSimulatorResearchTarget({ state, officialUrl, bookingUrl, source: "official", rendered: false, now, ...rest });
const failedHomepage = () => ({ ...empty(), readCount: 1, history: [{ source: "official" as const, requestedUrl: officialUrl, sourceUrl: officialUrl, observedAt: now.toISOString(), httpStatus: 403, rendered: false, outcome: "READ" as const }] });
const savedBayUrl = "https://yourgolfbooking.com/venues/public-golf/booking/bays";
const bookingRootUrl = "https://yourgolfbooking.com/venues/public-golf/booking";

describe("same-route research after an owned parser release", () => {
  const postRepairResearchBoundary = new Date("2026-10-06T19:55:00.125Z");
  const receipt = () => ({
    source: "booking" as const, requestedUrl: savedBayUrl, sourceUrl: savedBayUrl,
    sourceFingerprint: fingerprint, observedAt: "2026-10-06T19:50:00.000Z",
    httpStatus: 200, rendered: true, outcome: "READ" as const,
    requestId: "11111111-1111-4111-8111-111111111111",
    researchImplementationVersion: getSimulatorResearchImplementationVersion(savedBayUrl),
    publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true as const,
      accessControls: [] as ("ACCOUNT_REQUIRED" | "CAPTCHA_OR_CHALLENGE" | "QUEUE")[],
      method: "BROWSER" as const, renderComplete: true },
  });
  const state = (entry: ReturnType<typeof empty>["history"][number] = receipt()) =>
    readSimulatorResearchState({ ...empty(), readCount: 1, history: [entry] }, fingerprint);
  const input = (current = state()) => ({ state: current, officialUrl, bookingUrl: savedBayUrl,
    source: "booking" as const, rendered: true, now, priorFailedRoutes: [], postRepairResearchBoundary });

  it("uses the same publication boundary for prior-route filtering and retains unknown/newer clocks", () => {
    const original = receipt();
    const route = { url: savedBayUrl, rendered: true, httpStatus: 200, outcome: "READ" as const,
      observedAt: original.observedAt, requestId: original.requestId,
      researchImplementationVersion: original.researchImplementationVersion,
      accessControlsObserved: true as const, accessControls: [], renderComplete: true };
    expect(currentSimulatorResearchBlockedRoutes([route], now)).toEqual([route]);
    expect(currentSimulatorResearchBlockedRoutes([route], now, postRepairResearchBoundary)).toEqual([]);
    for (const newer of [
      { ...route, observedAt: postRepairResearchBoundary.toISOString(), requestId: "22222222-2222-4222-8222-222222222222" },
      { ...route, observedAt: undefined, requestId: undefined },
    ]) expect(currentSimulatorResearchBlockedRoutes([route, newer], now, postRepairResearchBoundary)).toContainEqual(route);
    const denied = { ...route, httpStatus: 403, observedAt: "2026-10-06T19:49:00.000Z" };
    expect(currentSimulatorResearchBlockedRoutes([route, denied], now, postRepairResearchBoundary)).toContainEqual(denied);
  });

  it("offers the original complete rendered page after the registered repair without spending a read in the guide", () => {
    const current = state();
    expect(selectSimulatorResearchTarget(input(current))).toEqual({ source: "booking", url: savedBayUrl, rendered: true });
    expect(getSimulatorResearchGuide(input(current)).suggestedReads).toContainEqual({ source: "booking", rendered: true });
    // The plain mode was already attempted; the useful next booking read is the repaired render.
    const plain = { ...receipt(), rendered: false, requestId: "22222222-2222-4222-8222-222222222222",
      publicReadEvidence: { ...receipt().publicReadEvidence, method: "HTTP" as const } };
    const both = readSimulatorResearchState({ ...current, readCount: 2, history: [plain, receipt()] }, fingerprint);
    expect(getSimulatorResearchRetryGuide(input(both))).toMatchObject({ bookingResearchRequired: true,
      nextEligibleBookingRead: { source: "booking", rendered: true } });
    expect(current.readCount).toBe(1);
    expect(current.history).toEqual([receipt()]);
  });

  it("permits a retained original receipt after a later owned repair without imposing configuration freshness on the permission", () => {
    const current = state({ ...receipt(), observedAt: "2026-10-06T18:00:00.000Z" });
    expect(selectSimulatorResearchTarget(input(current)).url).toBe(savedBayUrl);
  });

  it("does not reoffer the route after its next post-deployment receipt, including a partial or access-unknown result", () => {
    const current = state();
    for (const next of [
      { ...receipt(), observedAt: postRepairResearchBoundary.toISOString(),
        requestId: "33333333-3333-4333-8333-333333333333" },
      { ...receipt(), observedAt: "2026-10-06T19:56:00.000Z",
        requestId: "33333333-3333-4333-8333-333333333333",
        renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const,
        publicReadEvidence: { ...receipt().publicReadEvidence, renderComplete: false } },
      { ...receipt(), observedAt: "2026-10-06T19:56:00.000Z",
        requestId: "33333333-3333-4333-8333-333333333333", publicReadEvidence: undefined },
    ]) {
      const settled = readSimulatorResearchState({ ...current, readCount: 2, history: [receipt(), next] }, fingerprint);
      expect(() => selectSimulatorResearchTarget(input(settled))).toThrow("identical");
      expect(getSimulatorResearchGuide(input(settled)).suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
      // Receipt clocks, not only array order, prevent use of an older pre-repair observation.
      expect(() => selectSimulatorResearchTarget(input({ ...settled, history: [...settled.history].reverse() }))).toThrow("identical");
    }
  });

  it("requires the exact complete current-source receipt and a real later deployment boundary", () => {
    const base = input();
    for (const boundary of [undefined, null, new Date("invalid"), new Date("2026-10-06T19:50:00.000Z"),
      new Date("2026-10-06T19:49:59.999Z"), new Date("2026-10-06T20:00:00.001Z")]) {
      expect(() => selectSimulatorResearchTarget({ ...base, postRepairResearchBoundary: boundary })).toThrow("identical");
    }
    const original = receipt();
    for (const entry of [
      { ...original, researchImplementationVersion: undefined },
      { ...original, researchImplementationVersion: "obsolete-reader" },
      { ...original, requestId: undefined, publicReadEvidence: undefined },
      { ...original, observedAt: "2026-10-06T20:00:00.001Z" },
      { ...original, httpStatus: 401 }, { ...original, httpStatus: 403 }, { ...original, httpStatus: 404 },
      { ...original, renderWarning: "MAIN_DOCUMENT_HTTP_ERROR" as const },
      { ...original, publicReadEvidence: undefined },
      { ...original, publicReadEvidence: { ...original.publicReadEvidence, sourceFingerprint: "b".repeat(64) }, sourceFingerprint: "b".repeat(64) },
      { ...original, publicReadEvidence: { ...original.publicReadEvidence, renderComplete: false } },
      { ...original, publicReadEvidence: { ...original.publicReadEvidence, renderComplete: undefined } },
      ...(["ACCOUNT_REQUIRED", "CAPTCHA_OR_CHALLENGE", "QUEUE"] as const).map(control =>
        ({ ...original, publicReadEvidence: { ...original.publicReadEvidence, accessControls: [control] } })),
    ]) expect(() => selectSimulatorResearchTarget(input(state(entry)))).toThrow("identical");
  });

  it("keeps plain mode, protected prior failures, destination rules, source ownership, in-flight ownership and the original six-read limit", () => {
    const base = input();
    const plain = state({ ...receipt(), rendered: false,
      publicReadEvidence: { ...receipt().publicReadEvidence, method: "HTTP" } });
    expect(() => selectSimulatorResearchTarget({ ...input(plain), rendered: false })).toThrow("identical");
    expect(() => selectSimulatorResearchTarget({ ...base,
      priorFailedRoutes: [{ url: savedBayUrl, rendered: true, httpStatus: 403 }] })).toThrow();
    expect(() => selectSimulatorResearchTarget({ ...base, state: { ...base.state, sourceFingerprint: "b".repeat(64) } })).toThrow("identical");
    expect(() => selectSimulatorResearchTarget({ ...base, source: "evidence", evidenceUrl: savedBayUrl })).toThrow("origin");
    expect(() => selectSimulatorResearchTarget({ ...base, state: { ...base.state, inFlight: {
      requestId: "44444444-4444-4444-8444-444444444444", startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), source: "booking", url: savedBayUrl, rendered: true,
    } } })).toThrow("in flight");
    expect(() => selectSimulatorResearchTarget({ ...base, state: { ...base.state, readCount: 6 } })).toThrow("budget");
  });
});

describe("persisted known-reader configuration", () => {
  const configuration = { family: "GOLFBOOK" as const, templateId: "53", date: "2026-10-10", minDurationMinutes: 60,
    maxDurationMinutes: 360, incrementMinutes: 30 as const, resourceIds: ["1", "20"] };
  const observed = () => ({ ...empty(), readCount: 1, history: [{ source: "booking" as const, requestedUrl: "https://public-bays.golfbook.in/calendar.php", sourceUrl: "https://public-bays.golfbook.in/calendar.php",
    sourceFingerprint: fingerprint, observedAt: now.toISOString(), httpStatus: 200, rendered: false, outcome: "READ" as const,
    requestId: "00000000-0000-4000-8000-000000000001", publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true as const, accessControls: [], method: "HTTP" as const },
    publicConfiguration: configuration }] });
  const guide = (state: ReturnType<typeof empty> = observed(), at = now) => getSimulatorResearchGuide({ state, officialUrl, bookingUrl, now: at, priorFailedRoutes: [] });
  it("preserves a strict bounded configuration through saved-state parsing and the fresh owned guide", () => {
    const state = readSimulatorResearchState(observed(), fingerprint);
    expect(state.history[0].publicConfiguration).toEqual(configuration);
    expect(guide(state).publicConfigurations).toEqual([{ observedAt: now.toISOString(), source: "booking", rendered: false, configuration }]);
    expect(guide(state).readsRemaining).toBe(5);
    expect(readSimulatorResearchState(empty(), fingerprint).history).toEqual([]);
  });
  it("does not offer stale or adopted-source facts as current configuration", () => {
    expect(guide(observed(), new Date(now.getTime() + 31 * 60_000)).publicConfigurations).toEqual([]);
    expect(guide({ ...observed(), sourceFingerprint: "b".repeat(64) }).publicConfigurations).toEqual([]);
  });
  it.each(["SECONDARY_STYLESHEET_URL_REJECTED", "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED"] as const)("keeps %s rendered configuration as discovery facts without a complete public checkpoint", renderWarning => {
    const entry = { ...observed().history[0], rendered: true,
      researchImplementationVersion: getSimulatorResearchImplementationVersion(observed().history[0].requestedUrl), renderWarning,
      publicReadEvidence: { ...observed().history[0].publicReadEvidence, method: "BROWSER" as const, renderComplete: false } };
    const state = readSimulatorResearchState({ ...observed(), history: [entry] }, fingerprint);
    expect(guide(state).publicConfigurations).toEqual([{ observedAt: now.toISOString(), source: "booking", rendered: true, renderComplete: false, configuration }]);
    expect(readSettledSimulatorPublicCheckpoint(state, now)).toBeNull();
  });
  it("rejects raw/private additions, invalid resource IDs and access-restricted configuration evidence", () => {
    for (const publicConfiguration of [{ ...configuration, csrfToken: "private" }, { ...configuration, resourceIds: ["https://other.example"] }]) {
      expect(() => readSimulatorResearchState({ ...observed(), history: [{ ...observed().history[0], publicConfiguration }] }, fingerprint)).toThrow();
    }
    for (const entry of [{ ...observed().history[0], httpStatus: 403 }, { ...observed().history[0], publicReadEvidence: undefined },
      { ...observed().history[0], publicReadEvidence: { ...observed().history[0].publicReadEvidence, accessControls: ["ACCOUNT_REQUIRED"] } }]) {
      expect(() => readSimulatorResearchState({ ...observed(), history: [entry] }, fingerprint)).toThrow();
    }
  });
  it("rejects persisted facts copied from another tenant or date-specific public sheet", () => {
    const golfbookEntry = { ...observed().history[0], sourceUrl: "https://public-bays.golfbook.in/bookingsheet.php?date=2026-10-11&lang=en" };
    expect(() => readSimulatorResearchState({ ...observed(), history: [golfbookEntry] }, fingerprint)).toThrow();
    const acuityEntry = { ...observed().history[0], sourceUrl: "https://app.acuityscheduling.com/schedule/other123",
      publicConfiguration: { family: "ACUITY", ownerKey: "2991fba2", businessId: "34536426", timeZone: "America/New_York", maxPartySize: null,
        rentals: [{ id: "73234482", durationMinutes: 60, calendarIds: ["11388341"] }], resources: [{ id: "11388341", timeZone: "America/New_York" }] } };
    expect(() => readSimulatorResearchState({ ...observed(), history: [acuityEntry] }, fingerprint)).toThrow();
    expect(guide({ ...observed(), history: [golfbookEntry] }).publicConfigurations).toEqual([]);
  });
  it("reconsiders older incomplete known-reader routes once without reopening unrelated or access-denied routes", () => {
    const incomplete = { rendered: true, httpStatus: 200, renderWarning: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" as const, researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION };
    const acuity = { ...incomplete, url: "https://app.acuityscheduling.com/schedule/2991fba2" };
    const golfbook = { ...incomplete, url: "https://public-bays.golfbook.in/calendar.php" };
    const unrelated = { ...incomplete, url: bookingRootUrl };
    const invalid = { ...incomplete, url: "https://app.acuityscheduling.com.attacker.example/schedule/2991fba2" };
    const denied = { ...acuity, renderWarning: undefined, httpStatus: 403 };
    expect(currentSimulatorResearchBlockedRoutes([acuity, golfbook, unrelated, invalid, denied])).toEqual([unrelated, invalid, denied]);
    const current = [acuity, golfbook].map(row => ({ ...row, researchImplementationVersion: getSimulatorResearchImplementationVersion(row.url) }));
    expect(currentSimulatorResearchBlockedRoutes(current)).toEqual(current);
    expect(getSimulatorResearchImplementationVersion(bookingRootUrl)).toBe(SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION);
  });
});

describe("durable simulator research failure memory", () => {
  it("preserves closed category states, leaves legacy omissions unknown and rejects inconsistent or private facts", () => {
    const base = { adminOnlyState: "FALSE", typeToken: "simulator", reason: "CATEGORY_NOT_BAYTIME" };
    const read = (row: unknown) => readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint,
      routes: [{ url: bookingUrl, rendered: true, httpStatus: 200, configurationDiagnostic: {
        phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 1,
        rejectedRentalOptionsTruncated: false, rejectedRentalOptions: [row],
      } }] })?.routes[0].configurationDiagnostic?.rejectedRentalOptions?.[0];
    expect(read(base)).toEqual(base);
    for (const categoryState of ["MISSING", "NULL", "NON_STRING", "FILTERED_STRING"]) {
      expect(read({ ...base, categoryState })).toEqual({ ...base, categoryState });
    }
    expect(read({ ...base, categoryState: "TOKEN", categoryToken: "other" })).toEqual({ ...base, categoryState: "TOKEN", categoryToken: "other" });
    for (const row of [
      { ...base, categoryState: "TOKEN" }, { ...base, categoryState: "NULL", categoryToken: "other" },
      { ...base, categoryState: "private@example.test" }, { ...base, categoryState: "FILTERED_STRING", rawCategory: "private" },
      { ...base, categoryState: "TOKEN", categoryToken: "baytime" },
      { adminOnlyState: "TRUE", reason: "ADMIN_ONLY_NOT_FALSE", categoryState: "NULL" },
      { ...base, reason: "TYPE_NOT_SIMULATOR", typeToken: "other", categoryState: "NULL" },
    ]) expect(() => read(row)).toThrow();
  });
  it("keeps only closed rental failure diagnostics in owned history and inherited routes", () => {
    const diagnostic = { phase: "RENTALS" as const, reason: "CONFIG_NO_ELIGIBLE_RENTALS" as const,
      maintenanceModeState: "NULL" as const, optionCount: 2, rejectedRentalOptionsTruncated: false,
      rejectedRentalOptions: [
        { adminOnlyState: "TRUE" as const, reason: "ADMIN_ONLY_NOT_FALSE" as const },
        { adminOnlyState: "FALSE" as const, publicOptionId: "902", typeToken: "golf_sim",
          categoryToken: "baytime", reason: "TYPE_NOT_SIMULATOR" as const },
      ] };
    const route = { url: bookingUrl, rendered: true, httpStatus: 200, configurationDiagnostic: diagnostic };
    const entry = { source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      observedAt: now.toISOString(), httpStatus: 200, rendered: true, outcome: "READ" as const,
      configurationDiagnostic: diagnostic };
    const history = (configurationDiagnostic: unknown) => readSimulatorResearchState({ ...empty(), readCount: 1,
      history: [{ ...entry, configurationDiagnostic }] }, fingerprint);
    const memory = (configurationDiagnostic: unknown) => readSimulatorResearchFailureMemory({ version: 1,
      sourceFingerprint: fingerprint, routes: [{ ...route, configurationDiagnostic }] });
    expect(history(diagnostic).history[0].configurationDiagnostic).toEqual(diagnostic);
    expect(memory(diagnostic)?.routes[0].configurationDiagnostic).toEqual(diagnostic);
    const field = { phase: "RENTALS", reason: "CONFIG_ARRAY", field: {
      path: "bays.bayOptions[].appliedRequiredPerks", expectedType: "ARRAY", actualType: "NULL" } };
    expect(history(field).history[0].configurationDiagnostic).toEqual(field);
    expect(memory(field)?.routes[0].configurationDiagnostic).toEqual(field);
    const invalid = [
      { ...diagnostic, optionCount: 9 },
      { ...diagnostic, rejectedRentalOptionsTruncated: true },
      { ...diagnostic, rejectedRentalOptions: [{ ...diagnostic.rejectedRentalOptions[0], publicOptionId: "901" }, diagnostic.rejectedRentalOptions[1]] },
      { ...diagnostic, rejectedRentalOptions: [{ ...diagnostic.rejectedRentalOptions[0], name: "Private Member" }, diagnostic.rejectedRentalOptions[1]] },
      { ...diagnostic, rejectedRentalOptions: [{ ...diagnostic.rejectedRentalOptions[0], typeToken: "private@example.test" }, diagnostic.rejectedRentalOptions[1]] },
      { ...diagnostic, rejectedRentalOptions: [diagnostic.rejectedRentalOptions[0], { ...diagnostic.rejectedRentalOptions[1], typeToken: "simulator" }] },
      { ...diagnostic, rejectedRentalOptions: [diagnostic.rejectedRentalOptions[0], { ...diagnostic.rejectedRentalOptions[1], reason: "VENUE_MISMATCH" }] },
      { ...diagnostic, rejectedRentalOptions: Array.from({ length: 9 }, () => diagnostic.rejectedRentalOptions[0]), optionCount: 9,
        rejectedRentalOptionsTruncated: true },
      { ...diagnostic, reason: "CONFIG_ARRAY" },
      { ...field, field: { ...field.field, path: "bays.bayOptions[].privatePayload" } },
    ];
    for (const candidate of invalid) {
      expect(() => history(candidate)).toThrow();
      expect(() => memory(candidate)).toThrow();
    }
  });
  it("round-trips only cross-linked bounded null-category research facts and leaves old omissions unknown", () => {
    const metadata = { venueId: "1357", candidateCount: 1, candidatesTruncated: false,
      candidates: [{ publicOptionId: "21451", nameMatchesPublicRate: true, disabled: false, waitlisted: false,
        duration: 1, durationTypeToken: "slot", minDurationSlots: 1, maxDurationSlots: 8,
        minPlayers: null, maxPlayers: 4, bufferMinutes: 0, hasRestrictions: false, requiresPerks: false }],
      resourceCount: 1, resourcesTruncated: false,
      resources: [{ id: "9224", rangeId: "1397", optionIds: ["21451"], appliedOptionIds: [], hasRestrictedTimes: false }],
      rangeCount: 1, rangesTruncated: false,
      ranges: [{ id: "1397", slugIsBays: true, bookable: true, slotDurationMinutes: 30,
        slotIntervalMinutes: 30, slotIntervalStart: 0, assumeOpen: true, bookingUiIsStandard: true,
        customerBookingUiIsSlots: true, maxBookAheadValue: 2, maxBookAheadUnitToken: "week",
        hasOpeningTimeRestrictions: false }] };
    const diagnostic = { phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 1,
      rejectedRentalOptionsTruncated: false,
      rejectedRentalOptions: [{ adminOnlyState: "FALSE", publicOptionId: "21451", typeToken: "simulator",
        categoryState: "NULL", reason: "CATEGORY_NOT_BAYTIME" }], candidateMetadata: metadata };
    const entry = { source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      observedAt: now.toISOString(), httpStatus: 200, rendered: true, outcome: "READ" as const,
      configurationDiagnostic: diagnostic };
    const history = (value: unknown) => readSimulatorResearchState({ ...empty(), readCount: 1,
      history: [{ ...entry, configurationDiagnostic: value }] }, fingerprint).history[0].configurationDiagnostic;
    const memory = (value: unknown) => readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint,
      routes: [{ url: bookingUrl, rendered: true, httpStatus: 200, configurationDiagnostic: value }] })?.routes[0].configurationDiagnostic;
    expect(history(diagnostic)).toEqual(diagnostic);
    expect(memory(diagnostic)).toEqual(diagnostic);
    for (const openingHoursFormat of ["EMPTY", "WEEKLY_OR_DATED", "OTHER"]) {
      const value = { ...diagnostic, candidateMetadata: { ...metadata,
        ranges: [{ ...metadata.ranges[0], openingHoursFormat }] } };
      expect(history(value)).toEqual(value);
      expect(memory(value)).toEqual(value);
    }
    expect(history(diagnostic)?.candidateMetadata?.ranges[0].openingHoursFormat).toBeUndefined();
    const old = { phase: diagnostic.phase, reason: diagnostic.reason, optionCount: diagnostic.optionCount,
      rejectedRentalOptionsTruncated: diagnostic.rejectedRentalOptionsTruncated,
      rejectedRentalOptions: diagnostic.rejectedRentalOptions };
    expect(history(old)).toEqual(old);
    const legacyMetadata = { ...metadata } as Partial<typeof metadata>;
    delete legacyMetadata.venueId;
    expect(history({ ...diagnostic, candidateMetadata: legacyMetadata })).toEqual({ ...diagnostic, candidateMetadata: legacyMetadata });
    for (const invalid of [
      { ...diagnostic, candidateMetadata: { ...metadata, venueId: "private@example.test" } },
      { ...diagnostic, candidateMetadata: { ...metadata, ranges: [{ ...metadata.ranges[0], openingHoursFormat: "private@example.test" }] } },
      { ...diagnostic, candidateMetadata: { ...metadata, ranges: [{ ...metadata.ranges[0], openingHours: "private@example.test" }] } },
      { ...diagnostic, candidateMetadata: { ...metadata, candidates: [{ ...metadata.candidates[0], name: "Private Member" }] } },
      { ...diagnostic, candidateMetadata: { ...metadata, candidates: [{ ...metadata.candidates[0], publicOptionId: "9999" }] } },
      { ...diagnostic, candidateMetadata: { ...metadata, resourceCount: 0 } },
      { ...diagnostic, candidateMetadata: { ...metadata, resources: [{ ...metadata.resources[0], rangeId: "9999" }] } },
      { ...diagnostic, candidateMetadata: { ...metadata, resources: [{ ...metadata.resources[0], optionIds: ["9999"] }] } },
      { ...diagnostic, candidateMetadata: { ...metadata, rangeCount: 2,
        ranges: [...metadata.ranges, { ...metadata.ranges[0], id: "1398" }] } },
      { ...diagnostic, optionCount: 2, rejectedRentalOptions: [diagnostic.rejectedRentalOptions[0],
        { ...diagnostic.rejectedRentalOptions[0], publicOptionId: "21452" }] },
      { ...diagnostic, candidateMetadata: { ...metadata, candidatesTruncated: true } },
      { ...diagnostic, candidateMetadata: { ...metadata, resources: [{ ...metadata.resources[0], rawPayload: "private" }] } },
      { ...diagnostic, rejectedRentalOptions: [{ ...diagnostic.rejectedRentalOptions[0], categoryState: "MISSING" }] },
      { ...diagnostic, reason: "CONFIG_ARRAY" },
    ]) {
      expect(() => history(invalid)).toThrow();
      expect(() => memory(invalid)).toThrow();
    }
  });
  it("accepts only closed, bounded diagnostics on an incomplete owned rendered read and inherited route", () => {
    const bodyLimitDiagnostics = [{ resourceKind: "SECONDARY_SCRIPT" as const, phase: "COLLECTOR_HEADERS" as const,
      observedSizeBand: "OVER_LIMIT_UP_TO_2X" as const, count: 2 }];
    const entry = { source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      sourceFingerprint: fingerprint, observedAt: now.toISOString(), httpStatus: 200, rendered: true, outcome: "READ" as const,
      requestId: "11111111-1111-4111-8111-111111111111", renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const,
      publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true as const, accessControls: [],
        method: "BROWSER" as const, renderComplete: false }, bodyLimitDiagnostics };
    const state = readSimulatorResearchState({ ...empty(), readCount: 1, history: [entry] }, fingerprint);
    expect(state.history[0].bodyLimitDiagnostics).toEqual(bodyLimitDiagnostics);
    const route = { url: bookingUrl, rendered: true, httpStatus: 200, outcome: "READ" as const,
      renderWarning: entry.renderWarning, renderComplete: false, bodyLimitDiagnostics };
    expect(readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint, routes: [route] })?.routes[0].bodyLimitDiagnostics).toEqual(bodyLimitDiagnostics);
    for (const warning of ["SECONDARY_STYLESHEET_URL_REJECTED", "SECONDARY_REQUEST_BUDGET_EXHAUSTED"] as const) {
      expect(readSimulatorResearchState({ ...empty(), readCount: 1, history: [{ ...entry, renderWarning: warning }] }, fingerprint).history[0].bodyLimitDiagnostics).toEqual(bodyLimitDiagnostics);
      expect(readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint, routes: [{ ...route, renderWarning: warning }] })?.routes[0].bodyLimitDiagnostics).toEqual(bodyLimitDiagnostics);
    }
    expect(readSimulatorResearchState({ ...empty(), readCount: 1, history: [{ ...entry, bodyLimitDiagnostics: undefined }] }, fingerprint).history[0].bodyLimitDiagnostics).toBeUndefined();
    for (const invalid of [
      [{ ...bodyLimitDiagnostics[0], url: "https://secret.example.test" }],
      [{ ...bodyLimitDiagnostics[0], resourceKind: "OTHER" }],
      [{ ...bodyLimitDiagnostics[0], count: 33 }],
      [bodyLimitDiagnostics[0], bodyLimitDiagnostics[0]],
    ]) {
      expect(() => readSimulatorResearchState({ ...empty(), readCount: 1, history: [{ ...entry, bodyLimitDiagnostics: invalid }] }, fingerprint)).toThrow();
      expect(() => readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint, routes: [{ ...route, bodyLimitDiagnostics: invalid }] })).toThrow();
    }
    expect(() => readSimulatorResearchState({ ...empty(), readCount: 1, history: [{ ...entry, renderWarning: undefined }] }, fingerprint)).toThrow();
    expect(() => readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint, routes: [{ ...route, renderComplete: true }] })).toThrow();
  });
  it("reconsiders the previous generic and known-reader leaf versions while retaining hard, HTTP and access denials", () => {
    const priorVersions = [{ url: bookingRootUrl, researchImplementationVersion: "public-calendar-diagnostics-v2" },
      { url: "https://app.acuityscheduling.com/schedule/2991fba2", researchImplementationVersion: "public-calendar-known-readers-v1" }];
    for (const prior of priorVersions) {
      const incomplete = { ...prior, rendered: true, httpStatus: 200, renderComplete: false,
        renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const };
      const hard = { ...incomplete, httpStatus: 0, failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE" } };
      const denied = { ...incomplete, httpStatus: 403 };
      const access = { ...incomplete, accessControlsObserved: true as const, accessControls: ["ACCOUNT_REQUIRED" as const] };
      expect(currentSimulatorResearchBlockedRoutes([incomplete, hard, denied, access])).toEqual([hard, denied, access]);
      const current = { ...incomplete, researchImplementationVersion: getSimulatorResearchImplementationVersion(prior.url) };
      expect(currentSimulatorResearchBlockedRoutes([current])).toEqual([current]);
    }
  });
  it("revalidates only a proven current-source secondary incomplete route after exactly 60 minutes", () => {
    const observedAt = new Date(now.getTime() - 60 * 60_000).toISOString();
    const incomplete = { url: bookingUrl, rendered: true, httpStatus: 200, observedAt,
      requestId: "11111111-1111-4111-8111-111111111111", outcome: "READ" as const,
      renderWarning: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" as const,
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
      accessControlsObserved: true as const, accessControls: [], renderComplete: false };
    expect(currentSimulatorResearchBlockedRoutes([incomplete], new Date(now.getTime() - 1))).toEqual([incomplete]);
    expect(currentSimulatorResearchBlockedRoutes([incomplete], now)).toEqual([]);
    const entry = { source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      sourceFingerprint: fingerprint, observedAt, httpStatus: 200, rendered: true, outcome: "READ" as const,
      requestId: incomplete.requestId, renderWarning: incomplete.renderWarning,
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
      publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true as const,
        accessControls: [], method: "BROWSER" as const, renderComplete: false } };
    const state = readSimulatorResearchState({ ...empty(), readCount: 1, history: [entry] }, fingerprint);
    expect(() => select(state, { source: "booking", rendered: true, now: new Date(now.getTime() - 1) })).toThrow("identical");
    expect(select(state, { source: "booking", rendered: true, now })).toMatchObject({ url: bookingUrl, rendered: true });
    expect(() => select({ ...state, sourceFingerprint: "b".repeat(64) }, { source: "booking", rendered: true, now })).toThrow("identical");
    expect(() => select({ ...state, readCount: 2, history: [entry, { ...entry, observedAt: now.toISOString(), httpStatus: 403 }] },
      { source: "booking", rendered: true, now })).toThrow("identical");
    expect(() => select({ ...state, readCount: 2, history: [entry, { ...entry, observedAt: now.toISOString() }] },
      { source: "booking", rendered: true, now })).toThrow("identical");
    const hard = { ...entry, httpStatus: 0, outcome: "HARD_FAILED" as const,
      publicReadEvidence: undefined, failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE" as const } };
    for (const prior of [hard, { ...entry, httpStatus: 403 },
      { ...entry, publicReadEvidence: { ...entry.publicReadEvidence, accessControls: ["QUEUE" as const] } }]) {
      expect(() => select({ ...state, readCount: 2, history: [prior, entry] },
        { source: "booking", rendered: true, now })).toThrow("identical");
    }
  });
  it("does not cool down denial, challenged, hard, plain, ambiguous or future checkpoints", () => {
    const base = { url: bookingUrl, rendered: true, httpStatus: 200,
      observedAt: new Date(now.getTime() - 61 * 60_000).toISOString(), requestId: "11111111-1111-4111-8111-111111111111",
      outcome: "READ" as const, renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const,
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
      accessControlsObserved: true as const, accessControls: [], renderComplete: false };
    const fenced = [{ ...base, observedAt: undefined }, { ...base, observedAt: new Date(now.getTime() + 1).toISOString() },
      { ...base, accessControlsObserved: undefined }, { ...base, accessControls: undefined },
      { ...base, accessControls: ["ACCOUNT_REQUIRED" as const] }, { ...base, httpStatus: 403 },
      { ...base, httpStatus: 0, failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE" as const } },
      { ...base, rendered: false }, { ...base, renderWarning: undefined }, { ...base, renderComplete: undefined },
      { ...base, requestId: undefined }];
    for (const route of fenced) expect(currentSimulatorResearchBlockedRoutes([route], now)).toEqual([route]);
    expect(currentSimulatorResearchBlockedRoutes([{ ...base, accessControls: ["CAPTCHA_OR_CHALLENGE"] }], now)).toHaveLength(1);
    expect(currentSimulatorResearchBlockedRoutes([{ ...base, accessControls: ["QUEUE"] }], now)).toHaveLength(1);
    expect(currentSimulatorResearchBlockedRoutes([{ ...base, researchImplementationVersion: "older-collector", accessControls: ["ACCOUNT_REQUIRED"] }], now)).toHaveLength(1);
    expect(currentSimulatorResearchBlockedRoutes([{ ...base, researchImplementationVersion: "older-collector" }], now)).toEqual([]);
  });
  it("uses the newest route checkpoint before inherited memory, including renewed cooldown and denial", () => {
    const old = { url: bookingUrl, rendered: true, httpStatus: 200,
      observedAt: new Date(now.getTime() - 61 * 60_000).toISOString(), requestId: "11111111-1111-4111-8111-111111111111",
      outcome: "READ" as const, renderWarning: "SECONDARY_STYLESHEET_URL_REJECTED" as const,
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
      accessControlsObserved: true as const, accessControls: [], renderComplete: false };
    const recent = { ...old, observedAt: new Date(now.getTime() - 10 * 60_000).toISOString() };
    const denied = { ...old, httpStatus: 403, renderWarning: undefined };
    expect(currentSimulatorResearchBlockedRoutes(mergeSimulatorResearchBlockedRoutes([recent, old]), now)).toEqual([recent]);
    expect(currentSimulatorResearchBlockedRoutes(mergeSimulatorResearchBlockedRoutes([denied, old]), now)).toEqual([denied]);
    expect(currentSimulatorResearchBlockedRoutes(mergeSimulatorResearchBlockedRoutes([old, denied]), now)).toEqual([]);
  });
  it("does not relabel old or ambiguous observations with an adopted source", () => {
    const entry = failedHomepage().history[0], adoptedFingerprint = "b".repeat(64);
    const state = { ...failedHomepage(), sourceFingerprint: adoptedFingerprint };
    expect(getSimulatorResearchObservationFingerprint(entry, failedHomepage(), fingerprint)).toBe(fingerprint);
    expect(getSimulatorResearchObservationFingerprint(entry, state, fingerprint)).toBeNull();
    expect(getSimulatorResearchObservationFingerprint({ ...entry, sourceFingerprint: fingerprint }, state, fingerprint)).toBe(fingerprint);
    expect(getSimulatorResearchObservationFingerprint({ ...entry, requestId: "00000000-0000-4000-8000-000000000001", publicReadEvidence: {
      sourceFingerprint: fingerprint, accessControlsObserved: true, accessControls: [], method: "HTTP" } }, state, fingerprint)).toBe(fingerprint);
    expect(() => readSimulatorResearchState({ ...failedHomepage(), history: [{ ...entry, sourceFingerprint: fingerprint,
      requestId: "00000000-0000-4000-8000-000000000001", publicReadEvidence: { sourceFingerprint: adoptedFingerprint,
        accessControlsObserved: true, accessControls: [], method: "HTTP" } }] }, fingerprint)).toThrow();
  });
  it("reconsiders incomplete rendering only after its collector version changes and retains access denials", () => {
    const incomplete = { url: bookingUrl, rendered: true, httpStatus: 200,
      renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" as const,
      configurationDiagnostic: { phase: "RANGES" as const, reason: "CONFIG_SHAPE" as const,
        field: { path: "ranges" as const, expectedType: "OBJECT" as const, actualType: "MISSING" as const } } };
    const hard = { url: officialUrl, rendered: true, httpStatus: 0, failure: {
      stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_DOCUMENT" as const } };
    const denied = { url: officialUrl, rendered: false, httpStatus: 403 };
    const routes = mergeSimulatorResearchBlockedRoutes([{ ...incomplete, researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION }, hard, denied]);
    const memory = readSimulatorResearchFailureMemory({ version: 1, sourceFingerprint: fingerprint, routes })!;
    expect(currentSimulatorResearchBlockedRoutes(memory.routes)).toEqual(routes);
    const oldVersion = [{ ...incomplete, researchImplementationVersion: "previous-collector" }, hard, denied];
    expect(currentSimulatorResearchBlockedRoutes(oldVersion)).toEqual([hard, denied]);
    expect(memory.routes[1].failure).toEqual(hard.failure);
    const redacted = readSimulatorResearchFailureMemory({ ...memory, routes: [{ ...hard, failure: { ...hard.failure, message: "raw exception" } }] })!;
    expect(redacted.routes[0].failure).toEqual(hard.failure);
    expect(JSON.stringify(redacted)).not.toContain("raw exception");
  });

  it("keeps the newest diagnostic for each URL/mode and fails rather than dropping a denied route", () => {
    const first = { url: bookingUrl, rendered: false, httpStatus: 403 };
    expect(mergeSimulatorResearchBlockedRoutes([{ ...first, httpStatus: 404 }, first])).toEqual([{ ...first, httpStatus: 404 }]);
    expect(() => mergeSimulatorResearchBlockedRoutes(Array.from({ length: 65 }, (_, index) => ({ ...first, url: `https://calendar.example.test/route/${index}` })))).toThrow("bounded route limit");
  });
});

describe("owned simulator research navigation", () => {
  it("derives only the known public booking root from the current saved bay URL", () => {
    for (const host of ["booking.trackmangolf.com", "yourgolfbooking.com", "www.yourgolfbooking.com"]) {
      for (const trailing of ["", "/"]) {
        const input = { state: empty(), officialUrl, bookingUrl: `https://${host}/venues/public-golf/booking/bays${trailing}`,
          source: "booking-root" as const, rendered: false, now };
        expect(selectSimulatorResearchTarget(input)).toEqual({ source: "booking-root", url: `https://${host}/venues/public-golf/booking`, rendered: false });
        expect(input.bookingUrl).toBe(`https://${host}/venues/public-golf/booking/bays${trailing}`);
        expect(input.state.readCount).toBe(0);
      }
    }
    expect(select(empty(), { source: "booking-root", bookingUrl: "https://yourgolfbooking.com/venues/another-golf/booking/bays" }).url)
      .toBe("https://yourgolfbooking.com/venues/another-golf/booking");
  });

  it("rejects unproven platforms, normalized path tricks, unsafe slugs and any saved URL state", () => {
    for (const saved of [null, bookingRootUrl, `${bookingRootUrl}/`, bookingUrl,
      savedBayUrl.replace("https:", "http:"), savedBayUrl.replace("yourgolfbooking.com", "api.yourgolfbooking.com"),
      savedBayUrl.replace("yourgolfbooking.com", "yourgolfbooking.com.example.test"),
      savedBayUrl.replace("yourgolfbooking.com", "www.booking.trackmangolf.com"),
      savedBayUrl.replace("yourgolfbooking.com", "user:password@yourgolfbooking.com"),
      savedBayUrl.replace("yourgolfbooking.com", "yourgolfbooking.com:443"),
      savedBayUrl.replace("public-golf", "Public-Golf"), savedBayUrl.replace("public-golf", "public--golf"),
      savedBayUrl.replace("public-golf", "-public-golf"), savedBayUrl.replace("public-golf", "public-golf-"),
      savedBayUrl.replace("public-golf", "public%2dgolf"), savedBayUrl.replace("public-golf", "login"),
      savedBayUrl.replace("/venues/", "/unused/../venues/"), savedBayUrl.replace("/venues/", "/\\venues/"),
      `${savedBayUrl}?`, `${savedBayUrl}?date=2026-10-07`, `${savedBayUrl}#`, `${savedBayUrl}#calendar`,
      `${savedBayUrl}/extra`, `${savedBayUrl}//`]) {
      expect(() => select(empty(), { source: "booking-root", bookingUrl: saved }), String(saved)).toThrow("unavailable");
      expect(getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl: saved, now, priorFailedRoutes: [] }).suggestedReads)
        .not.toContainEqual({ source: "booking-root", rendered: false });
    }
    const observedOnly = { ...failedHomepage(), links: [savedBayUrl], bookingLinks: [savedBayUrl], linkBaseUrl: officialUrl };
    expect(() => select(observedOnly, { source: "booking-root", bookingUrl: null })).toThrow("unavailable");
  });

  it("records derived-root reservations and observations without resetting fingerprint or evidence guards", () => {
    const rootRead = { ...failedHomepage().history[0], source: "booking-root" as const, requestedUrl: bookingRootUrl, sourceUrl: bookingRootUrl };
    const state = readSimulatorResearchState({ ...empty(), readCount: 1, history: [rootRead] }, fingerprint);
    expect(state).toMatchObject({ sourceFingerprint: fingerprint, readCount: 1, history: [rootRead] });
    const pending = readSimulatorResearchState({ ...empty(), readCount: 1, inFlight: { source: "booking-root", url: bookingRootUrl,
      requestId: "11111111-1111-4111-8111-111111111111", startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), rendered: false } }, fingerprint);
    expect(() => select(pending, { source: "booking-root", bookingUrl: savedBayUrl })).toThrow("in flight");
    expect(readSettledSimulatorPublicCheckpoint(state, now)).toBeNull();
    const access = { ...rootRead, httpStatus: 200, requestId: "11111111-1111-4111-8111-111111111111",
      publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true as const, accessControls: ["ACCOUNT_REQUIRED" as const], method: "HTTP" as const } };
    expect(readSettledSimulatorPublicCheckpoint(readSimulatorResearchState({ ...empty(), readCount: 1, history: [access] }, fingerprint), now)).toBeNull();
  });

  it("shares spent URL/mode, prior-failure and six-read guards with saved booking research", () => {
    const rootRead = { ...failedHomepage().history[0], source: "booking-root" as const, requestedUrl: bookingRootUrl, sourceUrl: bookingRootUrl };
    const state = { ...empty(), readCount: 1, history: [rootRead] };
    expect(() => select(state, { source: "booking-root", bookingUrl: savedBayUrl })).toThrow("identical");
    expect(select(state, { source: "booking-root", bookingUrl: savedBayUrl, rendered: true })).toMatchObject({ url: bookingRootUrl, rendered: true });
    expect(() => select(empty(), { source: "booking-root", bookingUrl: savedBayUrl,
      priorFailedRoutes: [{ url: bookingRootUrl, rendered: false }] })).toThrow("structural");
    expect(select(empty(), { source: "booking-root", bookingUrl: savedBayUrl, rendered: true,
      priorFailedRoutes: [{ url: bookingRootUrl, rendered: false }] }).url).toBe(bookingRootUrl);
    expect(() => select({ ...state, readCount: 6 }, { source: "booking-root", bookingUrl: savedBayUrl })).toThrow("budget");
  });

  it("counts the derived root among the original three booking destinations", () => {
    const base = failedHomepage().history[0];
    const history = [
      { ...base, source: "booking-root" as const, requestedUrl: bookingRootUrl, sourceUrl: bookingRootUrl },
      ...[1, 2].map(index => ({ ...base, source: "booking" as const,
        requestedUrl: `https://calendar.example.test/booking/${index}`, sourceUrl: `https://calendar.example.test/booking/${index}` })),
    ];
    const state = { ...empty(), readCount: 3, history };
    expect(() => select(state, { source: "booking", bookingUrl: savedBayUrl })).toThrow("destination budget");
    expect(select(state, { source: "booking-root", bookingUrl: savedBayUrl, rendered: true }).url).toBe(bookingRootUrl);
    const otherDestinations = history.map((entry, index) => ({ ...entry, source: "booking" as const,
      requestedUrl: `https://other.example.test/booking/${index}`, sourceUrl: `https://other.example.test/booking/${index}` }));
    expect(() => select({ ...empty(), readCount: 3, history: otherDestinations }, { source: "booking-root", bookingUrl: savedBayUrl })).toThrow("destination budget");
  });

  it("offers only a saved same-origin evidence page and keeps original route budgets", () => {
    const evidenceUrl = `${officialUrl}/faqs`;
    expect(select(empty(), { source: "evidence", evidenceUrl })).toMatchObject({ source: "evidence", url: evidenceUrl });
    for (const unsafe of [null, officialUrl, `${officialUrl}/`, "http://localhost/faqs", "https://other.example.test/faqs", `${officialUrl}/login`, "http://venue.example.test/faqs"]) {
      expect(() => select(empty(), { source: "evidence", evidenceUrl: unsafe })).toThrow();
    }
    const state = { ...empty(), readCount: 1, history: [{ source: "evidence" as const, requestedUrl: evidenceUrl, sourceUrl: evidenceUrl,
      observedAt: now.toISOString(), httpStatus: 200, rendered: false, outcome: "READ" as const }] };
    expect(readSimulatorResearchState(state, fingerprint).readCount).toBe(1);
    expect(() => select(state, { source: "evidence", evidenceUrl })).toThrow("identical");
    expect(select(state, { source: "evidence", evidenceUrl, rendered: true }).url).toBe(evidenceUrl);
    expect(() => select({ ...state, readCount: 6 }, { source: "evidence", evidenceUrl })).toThrow("budget");
    expect(getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl, evidenceUrl, now, priorFailedRoutes: [] }).suggestedReads)
      .toContainEqual({ source: "evidence", rendered: false });
    expect(getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl, evidenceUrl: officialUrl, now, priorFailedRoutes: [] }).suggestedReads)
      .toHaveLength(4);
    expect(() => select(empty(), { source: "evidence", evidenceUrl, priorFailedRoutes: [{ url: evidenceUrl, rendered: false }] })).toThrow("structural");
  });
  it("chooses only saved sources or a fresh indexed official handoff", () => {
    expect(select().url).toBe(officialUrl);
    const state = { ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 200 }], links: [bookingUrl, "https://unrelated.example.test/simulators"], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl };
    expect(select(state, { source: undefined, linkIndex: 1 }).url).toBe(bookingUrl);
    expect(() => select(state, { source: undefined, linkIndex: 2 })).toThrow("handoff");
    expect(() => select(state, { source: undefined, linkIndex: 0 })).toThrow();
    expect(() => select(state, { source: undefined, linkIndex: 3 })).toThrow();
    expect(() => select(state, { source: undefined, linkIndex: 1, now: new Date(now.getTime() + 31 * 60_000) })).toThrow("fresh");
  });
  it("rejects malformed audit evidence instead of resetting budgets", () => {
    expect(() => readSimulatorResearchState({}, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...empty(), readCount: 1 }, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...empty(), links: ["http://localhost"] }, fingerprint)).toThrow();
    expect(readSimulatorResearchState({ source: "official", requestedUrl: officialUrl, sourceUrl: officialUrl, observedAt: now.toISOString(), httpStatus: 403, sourceFingerprint: fingerprint }, fingerprint).readCount).toBe(1);
  });
  it("does not repeat a failed request and permits a bounded rendered fallback", () => {
    expect(() => select(failedHomepage())).toThrow("identical");
    expect(select(failedHomepage(), { rendered: true }).url).toBe(officialUrl);
    expect(() => assertSimulatorResearchFallbackBeforeRetry(failedHomepage(), bookingUrl)).toThrow("booking read");
    const distinct = { ...failedHomepage(), readCount: 2, history: [...failedHomepage().history, { ...failedHomepage().history[0], source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl }] };
    expect(() => assertSimulatorResearchFallbackBeforeRetry(distinct, bookingUrl)).not.toThrow();
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...distinct, history: [...distinct.history].reverse() }, bookingUrl)).not.toThrow();
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 429 }] }, bookingUrl)).not.toThrow();
  });
  it("requires the saved calendar after an unclassified legacy rendered-homepage failure while retaining capacity backoff", () => {
    const renderedFailure = { ...failedHomepage(), readCount: 2, history: [...failedHomepage().history,
      { ...failedHomepage().history[0], rendered: true, httpStatus: 0, outcome: "NETWORK_FAILED" as const }] };
    expect(() => assertSimulatorResearchFallbackBeforeRetry(renderedFailure, bookingUrl)).toThrow("failed rendered homepage");
    expect(() => assertSimulatorResearchFallbackBeforeRetry(renderedFailure, null)).not.toThrow();
    expect(() => assertSimulatorResearchFallbackBeforeRetry({ ...renderedFailure, history: [...renderedFailure.history.slice(0, 1),
      { ...renderedFailure.history[1], outcome: "CAPACITY_BUSY" as const }] }, bookingUrl)).not.toThrow();
  });
  it("suggests saved booking commands first and exposes prior structural denials before another read", () => {
    const priorFailedRoutes = [{ url: officialUrl, rendered: false, httpStatus: 403 }];
    const guide = getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl, now, priorFailedRoutes });
    expect(guide).toMatchObject({ readsRemaining: 6, inFlight: false, priorBlockedRoutes: priorFailedRoutes });
    expect(guide.suggestedReads).toEqual([{ source: "booking", rendered: false }, { source: "booking", rendered: true },
      { source: "official", rendered: true }]);
    expect(getSimulatorResearchGuide({ state: { ...empty(), readCount: 6 }, officialUrl, bookingUrl, now, priorFailedRoutes }).suggestedReads).toEqual([]);
    expect(getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl: officialUrl, now, priorFailedRoutes: [] }).suggestedReads)
      .toEqual([{ source: "booking", rendered: false }, { source: "booking", rendered: true }]);
  });
  it("keeps another fresh successful booking handoff usable after one linked destination fails", () => {
    const success = { ...failedHomepage().history[0], httpStatus: 200 };
    const other = "https://other.example.test/booking/bays";
    const failedLink = { ...success, source: "link" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl, httpStatus: 403 };
    const state = { ...empty(), readCount: 2, history: [success, failedLink], linkBaseUrl: officialUrl,
      links: [bookingUrl, other], bookingLinks: [bookingUrl, other] };
    expect(select(state, { source: undefined, linkIndex: 2 }).url).toBe(other);
    expect(() => select(state, { source: undefined, linkIndex: 1 })).toThrow("identical");
    expect(() => select(state, { source: undefined, linkIndex: 2, now: new Date(now.getTime() + 31 * 60_000) })).toThrow("fresh");
  });
  it("retains in-flight and attempt capacity rather than allowing overlapping reads", () => {
    const state = { ...empty(), readCount: 1, inFlight: { requestId: "11111111-1111-4111-8111-111111111111", startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), source: "official" as const, url: officialUrl, rendered: false } };
    expect(() => select(state)).toThrow("in flight");
    expect(() => assertSimulatorResearchFallbackBeforeRetry(state, null)).toThrow("original");
    expect(() => select({ ...empty(), readCount: 6 })).toThrow("budget");
  });
  it("preserves a hard-failed reservation as a spent read and permits a bounded alternate route", () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const hard = readSimulatorResearchState({ ...empty(), readCount: 1, history: [{
      source: "official", requestedUrl: officialUrl, sourceUrl: officialUrl, observedAt: now.toISOString(),
      httpStatus: 0, rendered: true, outcome: "HARD_FAILED", requestId,
      failure: { stage: "PUBLIC_READ", category: "TOOLING", code: "INVALID_TOOL_DATA" },
    }] }, fingerprint);
    expect(hard.readCount).toBe(1);
    expect(select(hard, { source: "booking" }).url).toBe(bookingUrl);
    expect(() => select(hard, { rendered: true })).toThrow("identical");
    expect(() => assertSimulatorResearchFallbackBeforeRetry(hard, bookingUrl, officialUrl)).not.toThrow();
    expect(() => readSimulatorResearchState({ ...hard, history: [{ ...hard.history[0], failure: { stage: "PUBLIC_READ", category: "TOOLING", code: "RAW_URL", sourceLocation: "https://secret.example.test" } }] }, fingerprint)).toThrow();
  });
  it("allows incomplete retry after all six reads are spent, while an ordinary failed homepage still requires its saved booking route", () => {
    const failed = failedHomepage();
    expect(() => assertSimulatorResearchFallbackBeforeRetry(failed, bookingUrl, officialUrl)).toThrow("booking read");
    const exhausted = readSimulatorResearchState({ ...failed, readCount: 6,
      history: Array.from({ length: 6 }, (_, index) => ({ ...failed.history[0], observedAt: new Date(now.getTime() + index).toISOString() })),
    }, fingerprint);
    expect(getSimulatorResearchGuide({ state: exhausted, officialUrl, bookingUrl, now, priorFailedRoutes: [] }).suggestedReads).toEqual([]);
    expect(() => assertSimulatorResearchFallbackBeforeRetry(exhausted, bookingUrl, officialUrl)).not.toThrow();
    expect(() => select(exhausted, { source: "booking" })).toThrow("budget");
  });
  it("stops after three different public booking destinations", () => {
    const history = [1, 2, 3].map(i => ({ ...failedHomepage().history[0], source: "booking" as const, requestedUrl: `https://calendar.example.test/booking/${i}`, sourceUrl: `https://calendar.example.test/booking/${i}` }));
    expect(() => select({ ...empty(), readCount: 3, history }, { source: "booking" })).toThrow("destination budget");
  });
});

const retryGuide = (state = empty(), rest = {}) => getSimulatorResearchRetryGuide({ state, officialUrl, bookingUrl, now, priorFailedRoutes: [], ...rest });
const successfulHomepage = () => ({ ...failedHomepage(), history: [{ ...failedHomepage().history[0], httpStatus: 200 }] });
const requestId = "11111111-1111-4111-8111-111111111111";

describe("calendar research required before incomplete simulator retry", () => {
  it("offers an untried derived root before generic pages after both saved bay modes are spent", () => {
    const success = successfulHomepage().history[0];
    const state = { ...empty(), readCount: 3, history: [success,
      ...[false, true].map(rendered => ({ ...success, source: "booking" as const, requestedUrl: savedBayUrl, sourceUrl: savedBayUrl, rendered, httpStatus: 403 }))],
      links: [`${officialUrl}/about`, savedBayUrl], bookingLinks: [savedBayUrl], linkBaseUrl: officialUrl,
      bookingLinkRoles: [{ url: savedBayUrl, observedAt: now.toISOString() }] };
    const result = retryGuide(state, { bookingUrl: savedBayUrl, evidenceUrl: `${officialUrl}/faqs` });
    expect(result).toMatchObject({ bookingResearchRequired: true, nextEligibleBookingRead: { source: "booking-root", rendered: false },
      skipHomepageFallback: false, closeoutReason: null });
    expect(result.researchGuide.suggestedReads.slice(0, 4)).toEqual([
      { source: "booking-root", rendered: false }, { source: "booking-root", rendered: true },
      { linkIndex: 1, rendered: false }, { linkIndex: 1, rendered: true },
    ]);
    expect(state.readCount).toBe(3);
    expect(state.links).toEqual([`${officialUrl}/about`, savedBayUrl]);
  });

  it("keeps fresh handoffs ahead of derived roots and leaves already-root guides unchanged", () => {
    const otherBooking = "https://other.example.test/booking/bays";
    const state = { ...successfulHomepage(), links: [`${officialUrl}/about`, otherBooking], bookingLinks: [otherBooking],
      bookingLinkRoles: [{ url: otherBooking, observedAt: now.toISOString() }], linkBaseUrl: officialUrl };
    expect(getSimulatorResearchGuide({ state, officialUrl, bookingUrl: savedBayUrl, now, priorFailedRoutes: [] }).suggestedReads.slice(0, 8)).toEqual([
      { source: "booking", rendered: false }, { source: "booking", rendered: true },
      { linkIndex: 2, rendered: false }, { linkIndex: 2, rendered: true },
      { source: "booking-root", rendered: false }, { source: "booking-root", rendered: true },
      { linkIndex: 1, rendered: false }, { linkIndex: 1, rendered: true },
    ]);
    expect(getSimulatorResearchGuide({ state: empty(), officialUrl, bookingUrl: bookingRootUrl, now, priorFailedRoutes: [] }).suggestedReads).toEqual([
      { source: "booking", rendered: false }, { source: "booking", rendered: true },
      { source: "official", rendered: false }, { source: "official", rendered: true },
    ]);
  });

  it("requires only offered root modes and retains hard-failure and provider backoff closeout", () => {
    const base = successfulHomepage().history[0];
    const bayDenied = [false, true].map(rendered => ({ url: savedBayUrl, rendered, httpStatus: 403 }));
    expect(retryGuide(successfulHomepage(), { bookingUrl: savedBayUrl, priorFailedRoutes: [...bayDenied,
      { url: bookingRootUrl, rendered: false, httpStatus: 403 }] }).nextEligibleBookingRead).toEqual({ source: "booking-root", rendered: true });
    expect(retryGuide(successfulHomepage(), { bookingUrl: savedBayUrl, priorFailedRoutes: [...bayDenied,
      ...[false, true].map(rendered => ({ url: bookingRootUrl, rendered, httpStatus: 403 }))] })).toMatchObject({
      bookingResearchRequired: false, nextEligibleBookingRead: null, closeoutReason: "NO_ELIGIBLE_BOOKING_ROUTES" });
    for (const latest of [{ ...base, httpStatus: 429 }, { ...base, httpStatus: 503 }]) {
      expect(retryGuide({ ...empty(), readCount: 1, history: [latest] }, { bookingUrl: savedBayUrl })).toMatchObject({
        bookingResearchRequired: false, closeoutReason: "PROVIDER_BACKOFF" });
    }
    const hard = readSimulatorResearchState({ ...empty(), readCount: 1, history: [{ ...base, httpStatus: 0, outcome: "HARD_FAILED",
      requestId, failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" } }] }, fingerprint);
    expect(retryGuide(hard, { bookingUrl: savedBayUrl })).toMatchObject({ bookingResearchRequired: false, closeoutReason: "HARD_FAILURE" });
  });

  it("requires an offered saved calendar even after a successful homepage", () => {
    const state = successfulHomepage();
    expect(retryGuide(state)).toMatchObject({ bookingResearchRequired: true, nextEligibleBookingRead: { source: "booking", rendered: false },
      skipHomepageFallback: false, closeoutReason: null });
    expect(state.readCount).toBe(1);
    expect(state.history).toHaveLength(1);
  });

  it("prioritizes the current booking role over earlier generic page links", () => {
    const state = { ...successfulHomepage(), links: [`${officialUrl}/about`, bookingUrl], bookingLinks: [bookingUrl],
      bookingLinkRoles: [{ url: bookingUrl, observedAt: now.toISOString() }], linkBaseUrl: officialUrl };
    const guide = getSimulatorResearchGuide({ state, officialUrl, bookingUrl: null, now, priorFailedRoutes: [] });
    expect(guide.suggestedReads.slice(0, 4)).toEqual([
      { linkIndex: 2, rendered: false }, { linkIndex: 2, rendered: true },
      { linkIndex: 1, rendered: false }, { linkIndex: 1, rendered: true },
    ]);
    expect(retryGuide(state, { bookingUrl: null })).toMatchObject({ bookingResearchRequired: true,
      nextEligibleBookingRead: { linkIndex: 2, rendered: false } });
  });

  it("does not count an old recovered hard-failed calendar render as its untried plain read", () => {
    const history = [{ ...failedHomepage().history[0], source: "booking" as const, requestedUrl: bookingUrl, sourceUrl: bookingUrl,
      httpStatus: 0, rendered: true, outcome: "HARD_FAILED" as const, requestId,
      failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "RESEARCH_RESERVATION_INTERRUPTED" } }];
    const state = readSimulatorResearchState({ ...empty(), readCount: 1, history, lastRecoveredFailureRequestId: requestId }, fingerprint);
    expect(retryGuide(state)).toMatchObject({ bookingResearchRequired: true, nextEligibleBookingRead: { source: "booking", rendered: false } });
    expect(() => select(state, { source: "booking", rendered: true })).toThrow("identical");
    expect(retryGuide({ ...state, lastRecoveredFailureRequestId: undefined })).toMatchObject({ bookingResearchRequired: false,
      skipHomepageFallback: true, closeoutReason: "HARD_FAILURE" });
  });

  it("never demands a saved URL and mode denied by the current prior-route evidence", () => {
    const priorFailedRoutes = [false, true].map(rendered => ({ url: bookingUrl, rendered, httpStatus: 403 }));
    expect(retryGuide(successfulHomepage(), { priorFailedRoutes })).toMatchObject({ bookingResearchRequired: false,
      nextEligibleBookingRead: null, skipHomepageFallback: true, closeoutReason: "NO_ELIGIBLE_BOOKING_ROUTES" });
    const plainDenied = retryGuide(successfulHomepage(), { priorFailedRoutes: priorFailedRoutes.slice(0, 1) });
    expect(plainDenied.nextEligibleBookingRead).toEqual({ source: "booking", rendered: true });
  });

  it("keeps recognized network, provider capacity, HTTP429 and current 5xx as explicit backoff", () => {
    const base = successfulHomepage().history[0];
    const network = { ...base, httpStatus: 0, outcome: "NETWORK_FAILED" as const, requestId,
      failure: { stage: "PUBLIC_READ" as const, category: "NETWORK" as const, code: "PUBLIC_FETCH_FAILED" } };
    for (const latest of [network, { ...base, httpStatus: 0, outcome: "CAPACITY_BUSY" as const },
      { ...base, httpStatus: 429 }, { ...base, httpStatus: 503 }]) {
      const state = readSimulatorResearchState({ ...empty(), readCount: 1, history: [latest] }, fingerprint);
      expect(retryGuide(state)).toMatchObject({ bookingResearchRequired: false, skipHomepageFallback: true, closeoutReason: "PROVIDER_BACKOFF" });
    }
    // The old generic NETWORK_FAILED marker cannot invent a fresh known cause.
    expect(retryGuide({ ...empty(), readCount: 1, history: [{ ...base, httpStatus: 0, outcome: "NETWORK_FAILED" }] }))
      .toMatchObject({ bookingResearchRequired: true });
  });

  it("does not extend booking-role evidence when a newer generic page keeps its URL", () => {
    const state = { ...successfulHomepage(), links: [bookingUrl], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl,
      bookingLinkRoles: [{ url: bookingUrl, observedAt: new Date(now.getTime() - 31 * 60_000).toISOString() }] };
    expect(retryGuide(state, { bookingUrl: null })).toMatchObject({ bookingResearchRequired: false, nextEligibleBookingRead: null });
    expect(getSimulatorResearchGuide({ state, officialUrl, bookingUrl: null, now, priorFailedRoutes: [] }).suggestedReads)
      .not.toContainEqual({ linkIndex: 1, rendered: false });
    const future = { ...state, bookingLinkRoles: [{ url: bookingUrl, observedAt: new Date(now.getTime() + 1).toISOString() }] };
    expect(retryGuide(future, { bookingUrl: null }).bookingResearchRequired).toBe(false);
    const current = { ...state, bookingLinkRoles: [{ url: bookingUrl, observedAt: now.toISOString() }] };
    expect(retryGuide(current, { bookingUrl: null }).bookingResearchRequired).toBe(true);
  });

  it("preserves legacy-role freshness only until its last successful source receipt expires", () => {
    const state = { ...successfulHomepage(), links: [bookingUrl], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl };
    expect(retryGuide(state, { bookingUrl: null }).bookingResearchRequired).toBe(true);
    expect(retryGuide(state, { bookingUrl: null, now: new Date(now.getTime() + 31 * 60_000) }).bookingResearchRequired).toBe(false);
    expect(retryGuide({ ...state, bookingLinkRoles: [] }, { bookingUrl: null }).bookingResearchRequired).toBe(false);
  });

  it("retains hard in-flight ownership and finite read limits", () => {
    const state = { ...empty(), readCount: 1, inFlight: { requestId, startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), source: "booking" as const, url: bookingUrl, rendered: false } };
    expect(() => retryGuide(state)).toThrow("original source research");
    const exhausted = { ...successfulHomepage(), readCount: 6,
      history: Array.from({ length: 6 }, () => successfulHomepage().history[0]) };
    expect(retryGuide(exhausted)).toMatchObject({ bookingResearchRequired: false, skipHomepageFallback: true, closeoutReason: "READ_BUDGET_EXHAUSTED" });
  });

  it("requires no guessed calendar when the only offered links are ordinary venue pages", () => {
    const state = { ...successfulHomepage(), links: [`${officialUrl}/about`], bookingLinks: [], bookingLinkRoles: [], linkBaseUrl: officialUrl };
    expect(retryGuide(state, { bookingUrl: null })).toMatchObject({ bookingResearchRequired: false, nextEligibleBookingRead: null });
  });

  it("validates bounded unique role provenance against current discovered booking links", () => {
    const state = { ...successfulHomepage(), links: [bookingUrl], bookingLinks: [bookingUrl], linkBaseUrl: officialUrl };
    expect(readSimulatorResearchState({ ...state, bookingLinkRoles: [{ url: bookingUrl, observedAt: now.toISOString() }] }, fingerprint).bookingLinkRoles)
      .toEqual([{ url: bookingUrl, observedAt: now.toISOString() }]);
    expect(() => readSimulatorResearchState({ ...state, bookingLinkRoles: [{ url: `${officialUrl}/about`, observedAt: now.toISOString() }] }, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...state, bookingLinkRoles: Array.from({ length: 2 }, () => ({ url: bookingUrl, observedAt: now.toISOString() })) }, fingerprint)).toThrow();
  });
  it("requires explicit fresh access evidence for a settled-public recovery checkpoint", () => {
    const state: ReturnType<typeof empty> = { ...empty(), readCount: 1, history: [{ source: "official", requestedUrl: officialUrl,
      sourceUrl: officialUrl, observedAt: now.toISOString(), httpStatus: 200, rendered: false, outcome: "READ",
      requestId: "11111111-2222-4333-8444-555555555555", publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true, accessControls: [], method: "HTTP" } }] };
    expect(readSettledSimulatorPublicCheckpoint(readSimulatorResearchState(state, fingerprint), now)).toMatchObject({ requestId: state.history[0].requestId });
    const legacy = { ...state, history: [{ ...state.history[0], publicReadEvidence: undefined }] };
    expect(readSettledSimulatorPublicCheckpoint(legacy, now)).toBeNull();
    expect(readSettledSimulatorPublicCheckpoint({ ...state, sourceFingerprint: "b".repeat(64) }, now)).toBeNull();
    for (const control of ["ACCOUNT_REQUIRED", "CAPTCHA_OR_CHALLENGE", "QUEUE"] as const) {
      expect(readSettledSimulatorPublicCheckpoint({ ...state, history: [{ ...state.history[0], publicReadEvidence: { ...state.history[0].publicReadEvidence!, accessControls: [control] } }] }, now)).toBeNull();
    }
    expect(readSettledSimulatorPublicCheckpoint(state, new Date(now.getTime() + 31 * 60_000))).toBeNull();
    expect(readSettledSimulatorPublicCheckpoint({ ...state, readCount: 6 }, now)).toBeNull();
    expect(readSettledSimulatorPublicCheckpoint({ ...state, history: [{ ...state.history[0], httpStatus: 403 }] }, now)).toBeNull();
    const browser = { ...state.history[0], rendered: true, publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true as const, accessControls: [], method: "BROWSER" as const, renderComplete: false } };
    expect(readSettledSimulatorPublicCheckpoint({ ...state, history: [browser] }, now)).toBeNull();
    expect(readSettledSimulatorPublicCheckpoint({ ...state, history: [{ ...browser, publicReadEvidence: { ...browser.publicReadEvidence, renderComplete: true } }] }, now)).not.toBeNull();
    const challenged = { ...state.history[0], publicReadEvidence: { ...state.history[0].publicReadEvidence!, accessControls: ["QUEUE" as const] } };
    expect(readSettledSimulatorPublicCheckpoint({ ...state, readCount: 2, history: [challenged, state.history[0]] }, now)).toBeNull();
    expect(readSettledSimulatorPublicCheckpoint({ ...state, inFlight: { requestId: state.history[0].requestId!, source: "booking", url: bookingUrl, rendered: false, startedAt: now.toISOString(), expiresAt: now.toISOString() } }, now)).toBeNull();
    expect(() => readSimulatorResearchState({ ...state, history: [{ ...state.history[0], rendered: true }] }, fingerprint)).toThrow();
    expect(() => readSimulatorResearchState({ ...state, history: [{ ...state.history[0], requestId: undefined }] }, fingerprint)).toThrow();
  });
});
