import { expect, it } from "vitest";
import { discoveryPublicAvailabilityEntryNavigation } from "./browser-session";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";
const value = { tag: "a", name: "CLICK HERE TO CHECK AVAILABILITY, REGISTER & BOOK NOW", label: "", href: "https://clients.uschedule.com/public-studio/booking", sensitiveForm: false, inForm: false, hasDownload: false };
it("recognizes only bounded mixed availability wording on the exact two-origin public entry", () => {
  expect(isPublicAvailabilityNavigation(value.href, value.name)).toBe(false);
  expect(discoveryPublicAvailabilityEntryNavigation(value)).toBe(true);
  expect(discoveryPublicAvailabilityEntryNavigation({ ...value, label: value.name })).toBe(true);
  expect(discoveryPublicAvailabilityEntryNavigation({ ...value, name: "View availability, register and book", href: value.href.replace("clients.", "iframe.") })).toBe(true);
});
it("never promotes a form, control, download, account/transaction/time label or changed entry", () => {
  for (const delta of [{ tag: "button" }, { inForm: true }, { sensitiveForm: true }, { hasDownload: true },
    { name: value.name + " 10:00 AM" }, { name: "Check availability, register & pay now" }, { name: "Register an account and book" },
    { name: "Check availability, register & book now checkout" }, { name: "Sign in and check availability, register & book now" }, { label: "Register account" },
    { href: value.href + "?slotId=123" }, { href: value.href + "#times" }, { href: value.href + "/checkout" },
    { href: value.href.replace("clients.uschedule.com", "clients.uschedule.com.evil.example") }, { href: value.href.replace("https:", "http:") },
    { href: value.href.replace("https://", "https://user:secret@") }])
    expect(discoveryPublicAvailabilityEntryNavigation({ ...value, ...delta })).toBe(false);
});
