import { describe, expect, it, vi } from "vitest";
import { checkSimulatorOfficialSource } from "./simulator-source-check";
vi.mock("./provider-request-lease", () => ({
  runWithProviderRequestLease: async (_family: string, read: () => Promise<Response>) => ({ acquired: true, value: await read() }),
}));

describe("simulator first official-source check", () => {
  it("records a missing source without fabricating a booking page", async () => {
    const read = vi.fn();
    expect(await checkSimulatorOfficialSource(null, read)).toEqual({ outcome: "SOURCE_MISSING" });
    expect(read).not.toHaveBeenCalled();
  });

  it("only performs a signed-out read and never claims session availability", async () => {
    const read = vi.fn().mockResolvedValue(new Response("a public venue page", { status: 200 }));
    expect(await checkSimulatorOfficialSource("https://venue.example/", read))
      .toEqual({ outcome: "READ_OK", httpStatus: 200 });
    expect(read).toHaveBeenCalledWith("https://venue.example/", expect.objectContaining({
      method: "GET", credentials: "omit", signal: expect.any(AbortSignal),
    }));
    expect(read.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("records access and network failures without turning them into no openings", async () => {
    const read = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce(new Error("private provider response"));
    expect(await checkSimulatorOfficialSource("https://venue.example/", read))
      .toEqual({ outcome: "READ_FAILED", httpStatus: 403 });
    expect(await checkSimulatorOfficialSource("https://venue.example/", read))
      .toEqual({ outcome: "READ_FAILED" });
  });
});
