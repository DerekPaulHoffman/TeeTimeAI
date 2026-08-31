import { describe, expect, it } from "vitest";

import {
  parseCourseSupportProviderContractEvidenceMarker,
  selectCurrentBrowserProviderContractEvidence,
  type ProviderContractBrowserDiscovery,
} from "./course-support-provider-contract-evidence";

const incidentCycle = 4;
const incidentFirstSeenAt = new Date("2026-08-31T12:00:00.000Z");
const observedAt = "2026-08-31T12:05:00.000Z";
const providerSnapshotFingerprint = "current-provider-snapshot";
const officialUrl = "https://private-host-canary.example/course/8675309";
const trustedBookingUrl =
  "https://www.foreupsoftware.com/index.php/booking/12345";

type NetworkContract = {
  origin: string;
  method: string;
  pathPattern: string;
  queryKeys: string[];
  resourceType: string;
  status: number | null;
  [key: string]: unknown;
};

function contract(overrides: Partial<NetworkContract> = {}): NetworkContract {
  return {
    origin: "https://www.foreupsoftware.com",
    method: "GET",
    pathPattern: "/api/facilities/8675309/tee-times",
    queryKeys: ["date"],
    resourceType: "xhr",
    status: 200,
    ...overrides,
  };
}

function discovery(
  input: {
    browser?: Record<string, unknown>;
    accessBarriers?: unknown[];
    automationReason?: string;
    detectedPlatform?: string;
    bookingUrl?: string | null;
    apiMetadata?: unknown;
    confidence?: number;
  } = {},
): ProviderContractBrowserDiscovery {
  return {
    evidence: {
      browserInvestigation: {
        incidentCycle,
        observedAt,
        providerSnapshotFingerprint,
        networkContracts: [contract()],
        ...input.browser,
      },
      accessBarriers: input.accessBarriers ?? [],
    },
    automationReason: input.automationReason ?? "UNSUPPORTED_PLATFORM",
    detectedPlatform: input.detectedPlatform ?? "UNKNOWN",
    bookingUrl: input.bookingUrl ?? null,
    apiMetadata: input.apiMetadata ?? null,
    confidence: input.confidence ?? 0,
    createdAt: new Date(observedAt),
  };
}

function select(discoveries: readonly ProviderContractBrowserDiscovery[]) {
  return selectCurrentBrowserProviderContractEvidence({
    discoveries,
    incidentCycle,
    incidentFirstSeenAt,
    providerFamilyKey: "FOREUP",
    providerSnapshotFingerprint,
    officialUrl,
    bookingUrl: trustedBookingUrl,
  });
}

describe("course-support provider-contract evidence", () => {
  it("marks exact current safe rendered XHR/fetch reads when one succeeds", () => {
    const result = select([
      discovery({
        browser: {
          networkContracts: [
            contract({ method: "GET", resourceType: "xhr", status: 200 }),
            contract({
              method: "HEAD",
              resourceType: "fetch",
              status: 204,
              pathPattern: "/v2/availability",
            }),
            contract({
              method: "OPTIONS",
              resourceType: "xhr",
              status: 302,
              pathPattern: "/v3/tee-times",
            }),
          ],
        },
      }),
    ]);

    expect(result).toMatchObject({
      restrictionDetected: false,
      marker: {
        schemaVersion: 1,
        contractCount: 3,
        evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(result?.contracts).toHaveLength(3);
    expect(
      parseCourseSupportProviderContractEvidenceMarker(result?.marker),
    ).toEqual(result?.marker);
  });

  it("does not mark document-only, empty, or non-successful observations", () => {
    const cases = [
      discovery({
        browser: {
          networkContracts: [contract({ resourceType: "document" })],
        },
      }),
      discovery({ browser: { networkContracts: [] } }),
      discovery({
        browser: {
          networkContracts: [
            contract({ status: 302 }),
            contract({
              resourceType: "fetch",
              status: 500,
              pathPattern: "/v2/availability",
            }),
          ],
        },
      }),
    ];

    for (const candidate of cases) {
      expect(select([candidate])?.marker).toBeNull();
    }
  });

  it("does not promote generic shell traffic from an unrelated official origin", () => {
    const result = selectCurrentBrowserProviderContractEvidence({
      discoveries: [
        discovery({
          browser: {
            networkContracts: [
              contract({
                origin: "https://private-host-canary.example",
                pathPattern: "/api/config",
                queryKeys: [],
              }),
            ],
          },
        }),
      ],
      incidentCycle,
      incidentFirstSeenAt,
      providerFamilyKey: "FOREUP",
      providerSnapshotFingerprint,
      officialUrl,
      bookingUrl: null,
    });

    expect(result?.contracts).toHaveLength(1);
    expect(result?.marker).toBeNull();
  });

  it.each([
    ["entity-only config", "/api/config", ["facilityId"]],
    ["entity-and-player details", "/api/details", ["courseId", "players"]],
    ["date-only config", "/api/config", ["date"]],
    ["booking shell", "/api/booking", ["courseId"]],
  ])(
    "does not promote successful booking-origin %s traffic",
    (_label, pathPattern, queryKeys) => {
      const result = select([
        discovery({
          browser: {
            networkContracts: [contract({ pathPattern, queryKeys })],
          },
        }),
      ]);

      expect(result?.contracts).toHaveLength(1);
      expect(result?.marker).toBeNull();
    },
  );

  it.each([
    ["availability path", "/api/availability", []],
    ["tee-time path", "/api/tee-times", []],
    ["dated entity search", "/api/search", ["date", "facilityId"]],
    ["dated booking path", "/api/booking", ["startDate"]],
  ])(
    "promotes successful booking-origin %s traffic",
    (_label, pathPattern, queryKeys) => {
      const result = select([
        discovery({
          browser: {
            networkContracts: [contract({ pathPattern, queryKeys })],
          },
        }),
      ]);

      expect(result?.marker).toMatchObject({
        schemaVersion: 1,
        contractCount: 1,
        evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    },
  );

  it.each([
    [
      "account requirement",
      discovery({ automationReason: "ACCOUNT_REQUIRED" }),
    ],
    ["captcha or queue", discovery({ automationReason: "CAPTCHA_OR_QUEUE" })],
    ["persisted access barrier", discovery({ accessBarriers: ["ACCOUNT"] })],
    [
      "unsafe method",
      discovery({
        browser: { networkContracts: [contract({ method: "POST" })] },
      }),
    ],
    [
      "unsafe URL state",
      discovery({
        browser: {
          networkContracts: [contract({ queryKeys: ["token"] })],
        },
      }),
    ],
    ...[401, 403, 429].map(
      (status) =>
        [
          `HTTP ${status}`,
          discovery({
            browser: { networkContracts: [contract({ status })] },
          }),
        ] as const,
    ),
  ])("fails closed for %s", (_label, candidate) => {
    expect(select([candidate])).toMatchObject({
      contracts: [],
      restrictionDetected: true,
      marker: null,
    });
  });

  it.each([
    [
      "incident cycle",
      discovery({ browser: { incidentCycle: incidentCycle - 1 } }),
    ],
    [
      "observation time",
      discovery({ browser: { observedAt: "2026-08-31T11:59:59.999Z" } }),
    ],
    [
      "provider snapshot",
      discovery({
        browser: { providerSnapshotFingerprint: "stale-provider-snapshot" },
      }),
    ],
    [
      "provider family",
      discovery({
        detectedPlatform: "CHRONOGOLF",
        bookingUrl: "https://www.chronogolf.com/club/family-canary",
        confidence: 0.95,
      }),
    ],
  ])("does not mark a stale or mismatched %s", (_label, candidate) => {
    expect(select([candidate])?.marker ?? null).toBeNull();
  });

  it("retains no hosts, URLs, identifiers, query values, bodies, or recipient data", () => {
    const result = select([
      discovery({
        browser: {
          networkContracts: [
            contract({
              pathPattern:
                "/api/facilities/8675309/tee-times/123e4567-e89b-42d3-a456-426614174000",
              queryKeys: ["date", "players"],
              requestBody: "request-body-canary",
              responseBody: "response-body-canary",
              recipientEmail: "user@private-canary.example",
              queryValues: {
                date: "2031-11-22",
                recipientEmail: "user@private-canary.example",
                token: "query-value-canary",
              },
            }),
          ],
        },
      }),
    ]);

    expect(result?.marker).toMatchObject({
      contractCount: 1,
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const serialized = JSON.stringify(result);
    for (const canary of [
      "https://",
      "private-host-canary",
      "8675309",
      "123e4567-e89b-42d3-a456-426614174000",
      "2031-11-22",
      "query-value-canary",
      "request-body-canary",
      "response-body-canary",
      "recipient",
      "user@private-canary.example",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });
});
