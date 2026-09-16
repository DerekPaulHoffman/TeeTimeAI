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
});
