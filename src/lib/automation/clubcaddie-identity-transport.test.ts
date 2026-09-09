import { describe, expect, it, vi } from "vitest";
import { createClubCaddieIdentityPublicFetch } from "./search-monitoring-discovery";
import type { AddressPinnedPublicFetchDependencies } from "./address-pinned-public-fetch";

const base = "https://apimanager-cc20.clubcaddie.com/webapi/view/fdfdabab";
const bootstrap = `${base}?SetSessionIdInLocalStorage=true`;
const options = { redirect: "manual" as const };

function transport(address = "8.8.8.8") {
  const requestPinned = vi.fn<NonNullable<AddressPinnedPublicFetchDependencies["requestPinned"]>>(async () => new Response("public page", {
    headers: { "session-id": "fresh-public-session" }
  }));
  const dependencies = {
    resolveAddresses: async () => [{ address, family: 4 as const }], requestPinned
  };
  return { fetch: createClubCaddieIdentityPublicFetch(base, dependencies), requestPinned, dependencies };
}

describe("Club Caddie identity transport", () => {
  it("requires bootstrap provenance in the same invocation and pins each public read", async () => {
    const current = transport();
    const next = `${base}/slots?Interaction=fresh-public-session&player=0&ratetype=public`;
    await expect(current.fetch(next, options)).rejects.toThrow("unverified session");
    expect(current.requestPinned).not.toHaveBeenCalled();
    await current.fetch(bootstrap, options);
    await expect(current.fetch(next, options)).resolves.toHaveProperty("status", 200);
    expect(current.requestPinned).toHaveBeenCalledTimes(2);
    expect(current.requestPinned.mock.calls[1]?.[0]).toMatchObject({ address: "8.8.8.8", method: "GET" });
    const separate = createClubCaddieIdentityPublicFetch(base, current.dependencies);
    await expect(separate(next, options)).rejects.toThrow("unverified session");
  });

  it("rejects foreign destinations, stale or duplicate state, and extra query authority", async () => {
    const current = transport();
    await current.fetch(bootstrap, options);
    for (const url of [
      `${base}?Interaction=other-public-session`,
      `${base}?Interaction=fresh-public-session&Interaction=fresh-public-session`,
      `${base}?Interaction=fresh-public-session&token=anything`,
      `${base.replace("fdfdabab", "another-course")}?Interaction=fresh-public-session`,
      `${base.replace("apimanager-cc20", "apimanager-cc19")}?Interaction=fresh-public-session`,
      `${base}/checkout?Interaction=fresh-public-session`
    ]) await expect(current.fetch(url, options)).rejects.toThrow();
    expect(current.requestPinned).toHaveBeenCalledTimes(1);
  });

  it("retains private-address, credentials, method, body and redirect guards", async () => {
    const current = transport();
    for (const init of [
      {}, { redirect: "follow" as const },
      { ...options, method: "POST" },
      { ...options, body: "unwanted" },
      { ...options, headers: { cookie: "account=session" } },
      { ...options, headers: { authorization: "Bearer account" } }
    ]) await expect(current.fetch(bootstrap, init)).rejects.toThrow();
    expect(current.requestPinned).not.toHaveBeenCalled();
    const privateHost = transport("127.0.0.1");
    await expect(privateHost.fetch(bootstrap, options)).rejects.toThrow();
    expect(privateHost.requestPinned).not.toHaveBeenCalled();
  });
});
