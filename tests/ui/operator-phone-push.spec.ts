import { expect, test } from "@playwright/test";

// Chrome's headless shell disables notifications. Use full Chromium's modern
// headless mode so this test exercises the real notification implementation.
test.use({ channel: "chromium" });

test("operator push is displayed after the website is closed", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["notifications"], { origin: baseURL });
  const devtools = await context.newCDPSession(page);
  const registrations: Array<{ registrationId: string; scopeURL: string }> = [];
  devtools.on("ServiceWorker.workerRegistrationUpdated", event => registrations.push(...event.registrations));
  await devtools.send("ServiceWorker.enable");
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/operator-notifications-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => registrations.find(row => row.scopeURL === `${baseURL}/`)?.registrationId).toBeTruthy();
  const registrationId = registrations.find(row => row.scopeURL === `${baseURL}/`)!.registrationId;
  const worker = context.serviceWorkers().find(candidate => candidate.url().endsWith("/operator-notifications-sw.js"));
  expect(worker).toBeTruthy();

  // No Tee Time Spot document remains open. DevTools simulates incoming push
  // locally; it never registers a remote endpoint or sends a real notification.
  await page.goto("about:blank");
  expect(context.pages().every(candidate => !candidate.url().startsWith(baseURL!))).toBe(true);
  await devtools.send("ServiceWorker.deliverPushMessage", {
    origin: baseURL!, registrationId,
    data: JSON.stringify({ title: "Test operator update", body: "The website is closed.", tag: "local-smoke", url: "/operator" }),
  });
  await expect.poll(async () => worker!.evaluate(async () => {
    const registration = (globalThis as unknown as { registration: ServiceWorkerRegistration }).registration;
    return (await registration.getNotifications()).map(notification => ({ title: notification.title, body: notification.body }));
  })).toContainEqual({ title: "Test operator update", body: "The website is closed." });
  await worker!.evaluate(async () => {
    const registration = (globalThis as unknown as { registration: ServiceWorkerRegistration }).registration;
    for (const notification of await registration.getNotifications()) notification.close();
    await registration.unregister();
  });
});
