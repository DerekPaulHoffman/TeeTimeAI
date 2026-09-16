"use client";

import { useEffect, useState } from "react";

const api = "/api/operator/phone-notifications";
const worker = "/operator-notifications-sw.js";

async function request(data?: unknown) {
  const response = await fetch(
    api,
    data
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : { cache: "no-store" },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? "Phone notifications are temporarily unavailable.",
    );
  return result;
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function endpointHash(endpoint: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function OperatorPhoneNotifications() {
  const [state, setState] = useState<"loading" | "off" | "on" | "unsupported">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve(
      "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window,
    ).then(async (supported) => {
      if (!active) return;
      if (!supported) {
        setState("unsupported");
        return;
      }
      try {
        const [config, registration] = await Promise.all([
          request(),
          navigator.serviceWorker.getRegistration("/"),
        ]);
        const subscription = await registration?.pushManager.getSubscription();
        const matches =
          subscription &&
          Notification.permission === "granted" &&
          config.endpointHash === (await endpointHash(subscription.endpoint));
        if (active) setState(matches ? "on" : "off");
      } catch {
        if (active) {
          setState("off");
          setMessage(
            "Could not check your phone setup. Try enabling notifications again.",
          );
        }
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function act(action: "enable" | "test" | "disable") {
    setBusy(true);
    setMessage("");
    try {
      if (action === "enable") {
        // Request permission directly from the button gesture, before network work.
        if ((await Notification.requestPermission()) !== "granted")
          throw new Error(
            "Allow notifications for Tee Time Spot in Chrome's site settings, then try again.",
          );
        const config = await request();
        await navigator.serviceWorker.register(worker, {
          scope: "/",
          updateViaCache: "none",
        });
        const registration = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Setup took too long. Please try again.")),
              20_000,
            ),
          ),
        ]);
        let subscription = await registration.pushManager.getSubscription();
        const applicationKey = keyBytes(config.publicKey);
        const existingKey = subscription?.options.applicationServerKey;
        if (
          subscription &&
          (!existingKey ||
            new Uint8Array(existingKey).toString() !==
              applicationKey.toString())
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
        subscription ??= await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationKey,
        });
        await request({
          action: "subscribe",
          subscription: subscription.toJSON(),
        });
        setState("on");
        setMessage(
          "Enabled on this device. Send a test, then you can close the website.",
        );
      } else {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) {
          setState("off");
          throw new Error("Enable notifications on this device first.");
        }
        await request({
          action: action === "disable" ? "unsubscribe" : "test",
          endpoint: subscription.endpoint,
        });
        if (action === "disable") {
          await subscription.unsubscribe();
          setState("off");
          setMessage("Notifications stopped on this device.");
        } else setMessage("Test sent. Check your phone's notifications.");
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Setup could not be completed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="phone-notifications-heading"
      className="operator-section"
    >
      <div className="operator-section-heading">
        <div>
          <h2 id="phone-notifications-heading">Phone notifications</h2>
          <p>
            Get each new customer alert and a status update five minutes later.
            Your own alerts and tests are excluded. The website can stay closed.
          </p>
          <p>
            Enable this in Chrome on your Android phone. One device at a time;
            enabling here replaces your previous device.
          </p>
        </div>
      </div>
      {state === "unsupported" ? (
        <p>
          Open this page in Chrome on your Android phone to enable
          notifications.
        </p>
      ) : (
        <div className="operator-phone-actions">
          {state === "on" ? (
            <>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void act("test")}
              >
                Send test notification
              </button>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => void act("disable")}
              >
                Stop on this device
              </button>
            </>
          ) : (
            <button
              className="button button-primary"
              disabled={busy || state === "loading"}
              onClick={() => void act("enable")}
            >
              {state === "loading"
                ? "Checking phone setup…"
                : "Enable on this phone"}
            </button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite">
        {busy ? "Working…" : message}
      </p>
    </section>
  );
}
