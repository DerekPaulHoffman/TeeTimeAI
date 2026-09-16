// @vitest-environment node
import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  config: vi.fn(),
  launch: vi.fn(),
  after: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/operator-sms/launcher", () => ({
  startOperatorSmsForSearch: mocks.launch,
}));
vi.mock("@/lib/operator-sms/service", () => ({
  recordOperatorSmsCallback: mocks.record,
}));
vi.mock("@/lib/operator-sms/config", () => ({
  getOperatorSmsConfig: mocks.config,
}));
const config = {
  accountSid: `AC${"a".repeat(32)}`,
  authToken: "webhook-test-token",
  origin: "https://teetimespot.com",
  to: "+12025550101",
  from: "+12025550100",
  excludedEmails: ["owner@realmail.com"],
};
const path = "/api/webhooks/twilio/operator-sms?id=row-1&attempt=attempt-1";
const params = {
  AccountSid: config.accountSid,
  MessageSid: `SM${"b".repeat(32)}`,
  MessageStatus: "delivered",
};
function request(overrides: Record<string, string> = {}, signature?: string) {
  const body = { ...params, ...overrides };
  return new Request(`https://internal-vercel-host.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature":
        signature ??
        twilio.getExpectedTwilioSignature(
          config.authToken,
          `${config.origin}${path}`,
          body,
        ),
    },
    body: new URLSearchParams(body),
  });
}
describe("Twilio operator receipt webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockReturnValue(config);
  });
  it("accepts a signed callback using the configured origin", async () => {
    expect((await POST(request())).status).toBe(204);
    expect(mocks.record).toHaveBeenCalledWith({
      id: "row-1",
      token: "attempt-1",
      sid: params.MessageSid,
      status: "delivered",
    });
  });
  it("rejects unsigned or forged receipts before any database change", async () => {
    expect((await POST(request({}, "forged"))).status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("rejects a different account even with a valid test signature", async () => {
    expect(
      (await POST(request({ AccountSid: `AC${"c".repeat(32)}` }))).status,
    ).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("rejects malformed message IDs", async () =>
    expect((await POST(request({ MessageSid: "bad" }))).status).toBe(400));
  it("stays disabled without production configuration", async () => {
    mocks.config.mockReturnValue(null);
    expect((await POST(request())).status).toBe(503);
  });
  it("starts the recovered follow-up so its five-minute timer does not wait for cron", async () => {
    mocks.record.mockResolvedValueOnce("search-1");
    mocks.after.mockImplementationOnce((callback: () => unknown) => callback());
    expect((await POST(request())).status).toBe(204);
    expect(mocks.launch).toHaveBeenCalledWith("search-1");
  });
});
