// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAddressPinnedPublicFetchTransport, getOwnedOfficialSiteBodyLimitDiagnostic, isOwnedOfficialSiteBodyLimitError } from "./address-pinned-public-fetch";
import { classifySimulatorSupportFailure, readSafeSimulatorSupportFailure } from "./simulator-support-failure";

function inertResponse(body: Buffer, declaredLength?: number) {
  const incoming = Object.assign(new PassThrough(), {
    headers: declaredLength === undefined ? {} : { "content-length": String(declaredLength) },
    statusCode: 200,
    statusMessage: "OK",
  });
  const requestNode = vi.fn((_url: URL, _options: RequestOptions, onResponse: (response: IncomingMessage) => void) =>
    Object.assign(new EventEmitter(), {
      end() {
        queueMicrotask(() => {
          onResponse(incoming as IncomingMessage);
          incoming.end(body);
        });
      },
    }) as ClientRequest);
  const fetchPublic = createAddressPinnedPublicFetchTransport({
    parseUrl: value => new URL(value), maxResponseBytes: 5, timeoutMs: 1_000,
  }, {
    resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }], requestNode,
  });
  return { fetchPublic, requestNode };
}

describe("address-pinned public response body limit", () => {
  it.each([
    ["declared", Buffer.from("exact"), 6],
    ["streamed", Buffer.from("larger"), undefined],
  ])("classifies an internally rejected %s oversized body without leaking response data", async (_kind, body, declaredLength) => {
    const { fetchPublic, requestNode } = inertResponse(body, declaredLength);
    let caught: unknown;
    try { await fetchPublic("https://public.example.test/booking"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ message: "Official site page is too large to inspect safely", code: "OFFICIAL_SITE_BODY_LIMIT" });
    expect(isOwnedOfficialSiteBodyLimitError(caught)).toBe(true);
    expect(getOwnedOfficialSiteBodyLimitDiagnostic(caught)).toEqual({
      phase: declaredLength === undefined ? "TRANSPORT_BODY" : "TRANSPORT_HEADERS",
      observedSizeBand: "OVER_LIMIT_UP_TO_2X",
    });
    const copy = getOwnedOfficialSiteBodyLimitDiagnostic(caught);
    if (copy) copy.observedSizeBand = "OVER_4X";
    expect(getOwnedOfficialSiteBodyLimitDiagnostic(caught)?.observedSizeBand).toBe("OVER_LIMIT_UP_TO_2X");
    expect(isOwnedOfficialSiteBodyLimitError(Object.assign(new Error("spoof"), { code: "OFFICIAL_SITE_BODY_LIMIT" }))).toBe(false);
    expect(getOwnedOfficialSiteBodyLimitDiagnostic(Object.assign(new Error("spoof"), { code: "OFFICIAL_SITE_BODY_LIMIT" }))).toBeNull();
    const receipt = classifySimulatorSupportFailure(caught, "PUBLIC_READ");
    expect(receipt).toMatchObject({ stage: "PUBLIC_READ", category: "BUDGET", code: "PUBLIC_BODY_LIMIT" });
    expect(readSafeSimulatorSupportFailure(receipt)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain("public.example.test");
    expect(requestNode).toHaveBeenCalledOnce();
    expect(requestNode.mock.calls[0][1]).toMatchObject({ method: "GET", agent: false, family: 4 });
  });

  it.each([[11, "OVER_2X_UP_TO_4X"], [21, "OVER_4X"]] as const)("bands only owned declared size %i", async (declaredLength, observedSizeBand) => {
    const { fetchPublic } = inertResponse(Buffer.from("x"), declaredLength);
    let caught: unknown;
    try { await fetchPublic("https://public.example.test/booking"); } catch (error) { caught = error; }
    expect(getOwnedOfficialSiteBodyLimitDiagnostic(caught)).toEqual({ phase: "TRANSPORT_HEADERS", observedSizeBand });
  });

  it("accepts a response exactly at the cap and does not classify untrusted matching text", async () => {
    const { fetchPublic } = inertResponse(Buffer.from("exact"), 5);
    const response = await fetchPublic("https://public.example.test/booking");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("exact");
    expect(classifySimulatorSupportFailure(new Error("Official site page is too large to inspect safely"), "PUBLIC_READ"))
      .toMatchObject({ category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" });
  });
});
