// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("background phone worker", () => {
  it("shows the push with no page open and only opens the private overview on a click", async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue(undefined);
    runInNewContext(
      readFileSync(
        new URL(
          "../../../public/operator-notifications-sw.js",
          import.meta.url,
        ),
        "utf8",
      ),
      {
        URL,
        self: {
          addEventListener: (
            event: string,
            callback: (event: unknown) => void,
          ) => {
            handlers[event] = callback;
          },
          registration: { showNotification },
          location: { origin: "https://teetimespot.com" },
          clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow },
        },
      },
    );
    let work: Promise<unknown> = Promise.resolve();
    handlers.push({
      data: {
        json: () => ({
          title: "New alert",
          body: "Golfer details",
          url: "https://evil.test",
          tag: "delivery-1",
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        work = promise;
      },
    });
    await work;
    expect(showNotification).toHaveBeenCalledWith("New alert", {
      body: "Golfer details",
      tag: "delivery-1",
      data: { url: "/operator" },
    });
    expect(openWindow).not.toHaveBeenCalled();
    handlers.notificationclick({
      notification: { close: vi.fn() },
      waitUntil: (promise: Promise<unknown>) => {
        work = promise;
      },
    });
    await work;
    expect(openWindow).toHaveBeenCalledWith("https://teetimespot.com/operator");
  });
});
