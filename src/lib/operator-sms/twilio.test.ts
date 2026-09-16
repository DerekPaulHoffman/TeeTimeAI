// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendOperatorSms } from "./twilio";
const mocks = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }));
vi.mock("twilio", () => ({ default: mocks.client }));
const config = {
  accountSid: `AC${"a".repeat(32)}`,
  authToken: "test-token",
  from: "+12025550100",
  to: "+12025550101",
  excludedEmails: ["owner@realmail.com"],
  origin: "https://teetimespot.com",
};
const input = {
  id: "delivery-1",
  token: "attempt-1",
  to: config.to,
  body: "Test notification",
};
describe("Twilio operator transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.mockReturnValue({ messages: { create: mocks.create } });
  });
  it("disables SDK auto-retries and supplies the attempt-specific callback", async () => {
    mocks.create.mockResolvedValue({
      sid: `SM${"b".repeat(32)}`,
      status: "queued",
    });
    expect(await sendOperatorSms(config, input)).toMatchObject({
      status: "queued",
    });
    expect(mocks.client).toHaveBeenCalledWith(
      config.accountSid,
      config.authToken,
      { autoRetry: false, timeout: 15_000 },
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        from: config.from,
        to: config.to,
        statusCallback:
          "https://teetimespot.com/api/webhooks/twilio/operator-sms?id=delivery-1&attempt=attempt-1",
      }),
    );
  });
  it.each([
    [{ status: 429, code: 20429 }, "retry"],
    [{ status: 400, code: 21610 }, "failed"],
    [{ status: 401, code: 20003 }, "failed"],
    [{ status: 503 }, "uncertain"],
    [{ code: "ETIMEDOUT" }, "uncertain"],
  ])(
    "classifies provider failures without exposing the error message",
    async (error, outcome) => {
      mocks.create.mockRejectedValue({
        ...error,
        message: "secret recipient and credential details",
      });
      await expect(sendOperatorSms(config, input)).rejects.toMatchObject({
        outcome,
      });
      await expect(sendOperatorSms(config, input)).rejects.not.toThrow(
        "secret",
      );
    },
  );
});
