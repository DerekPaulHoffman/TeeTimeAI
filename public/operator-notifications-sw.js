// Push-only worker: no page caching, polling, or open tab is required.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    /* Still show a visible fallback. */
  }
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === "string"
        ? payload.title.slice(0, 160)
        : "Tee Time Spot",
      {
        body:
          typeof payload.body === "string"
            ? payload.body.slice(0, 3000)
            : "Open your site overview for an update.",
        tag:
          typeof payload.tag === "string"
            ? payload.tag.slice(0, 100)
            : "tee-time-spot-update",
        // Restrict clicks to the authenticated overview, regardless of payload.
        data: { url: "/operator" },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL("/operator", self.location.origin).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find((client) => client.url === url);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
