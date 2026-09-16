import { webcrypto } from "node:crypto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorPhoneNotifications } from "./operator-phone-notifications";

const fetchMock = vi.fn();
const permission = vi.fn();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/a",
  options: {},
  unsubscribe,
  toJSON: () => ({
    endpoint: "https://fcm.googleapis.com/fcm/send/a",
    keys: { p256dh: "phone", auth: "auth" },
  }),
};
const getSubscription = vi.fn();
const register = vi.fn();
const registration = { pushManager: { getSubscription, subscribe } };

describe("operator phone setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: permission,
    });
    vi.stubGlobal("PushManager", class {});
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue(registration),
        register,
        ready: Promise.resolve(registration),
      },
    });
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(subscription);
    unsubscribe.mockResolvedValue(true);
    permission.mockResolvedValue("granted");
    register.mockResolvedValue(registration);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ publicKey: "BA", endpointHash: null }),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });
  it("waits for an explicit tap, then registers the phone and lets the website close", async () => {
    render(<OperatorPhoneNotifications />);
    const enable = await screen.findByRole("button", {
      name: "Enable on this phone",
    });
    expect(permission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    fireEvent.click(enable);
    await screen.findByRole("button", { name: "Send test notification" });
    expect(permission).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/operator-notifications-sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    const mutations = fetchMock.mock.calls.filter(
      (call) => call[1]?.method === "POST",
    );
    expect(mutations).toHaveLength(1);
    expect(JSON.parse(mutations[0][1].body)).toEqual({
      action: "subscribe",
      subscription: subscription.toJSON(),
    });
    expect(screen.getByRole("status").textContent).toContain(
      "close the website",
    );
    getSubscription.mockResolvedValue(subscription);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop on this device" }),
    );
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "Enable on this phone" }),
    ).toBeTruthy();
  });
  it("does not subscribe after permission is denied", async () => {
    permission.mockResolvedValue("denied");
    render(<OperatorPhoneNotifications />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Enable on this phone" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("site settings"),
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
  it("replaces an expired browser registration before testing again", async () => {
    const replacement = {
      ...subscription,
      endpoint: "https://fcm.googleapis.com/fcm/send/replacement",
      toJSON: () => ({
        ...subscription.toJSON(),
        endpoint: "https://fcm.googleapis.com/fcm/send/replacement",
      }),
    };
    fetchMock.mockImplementation(async (_url, options) => {
      const data = options?.body ? JSON.parse(options.body) : null;
      return data?.action === "test" && data.endpoint === subscription.endpoint
        ? {
            ok: false,
            status: 410,
            json: async () => ({
              code: "SUBSCRIPTION_EXPIRED",
              error: "This phone's registration expired. Enable notifications again.",
            }),
          }
        : {
            ok: true,
            json: async () => ({ publicKey: "BA", endpointHash: null }),
          };
    });
    render(<OperatorPhoneNotifications />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable on this phone" }));
    await screen.findByRole("button", { name: "Send test notification" });
    getSubscription.mockResolvedValue(subscription);
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    const reconnect = await screen.findByRole("button", { name: "Enable on this phone" });
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toContain("expired");
    subscribe.mockResolvedValue(replacement);
    fireEvent.click(reconnect);
    await screen.findByRole("button", { name: "Send test notification" });
    const saved = fetchMock.mock.calls
      .filter((call) => call[1]?.method === "POST")
      .map((call) => JSON.parse(call[1].body))
      .filter((data) => data.action === "subscribe");
    expect(saved.map((data) => data.subscription.endpoint)).toEqual([
      subscription.endpoint,
      replacement.endpoint,
    ]);
    getSubscription.mockResolvedValue(replacement);
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Test sent"));
  });
  it("renews a leftover browser subscription when setup is retried after refresh", async () => {
    const leftover = {
      ...subscription,
      options: { applicationServerKey: Uint8Array.from([4]).buffer },
    };
    getSubscription.mockResolvedValue(leftover);
    render(<OperatorPhoneNotifications />);
    const enable = await screen.findByRole("button", { name: "Enable on this phone" });
    expect(unsubscribe).not.toHaveBeenCalled();
    fireEvent.click(enable);
    await screen.findByRole("button", { name: "Send test notification" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
  it("returns to explicit setup when this device no longer matches the saved phone", async () => {
    render(<OperatorPhoneNotifications />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable on this phone" }));
    await screen.findByRole("button", { name: "Send test notification" });
    getSubscription.mockResolvedValue(subscription);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ code: "DEVICE_NOT_REGISTERED", error: "Reconnect this phone." }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    await screen.findByRole("button", { name: "Enable on this phone" });
    expect(screen.getByRole("status").textContent).toContain("Reconnect");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
