import { describe, expect, it } from "vitest";
import { observedSquarePublicServiceControl } from "./square-public-service-controls";

const catalog = "https://book.squareup.com/appointments/publicvenue/location/AAAAAAAAAAAAA/services";
const detail = `${catalog}/BBBBBBBBBBBBBBBB`;
const add = { tag: "button", name: "Add", label: "", publicHeading: "1 hour simulator practice" };
const choice = { catalogUrl: catalog, serviceId: "BBBBBBBBBBBBBBBB", name: add.publicHeading, nextUsed: false };
const next = { tag: "button", name: "Next", label: "", selectionSummary: `Appointment summary\n${choice.name}\n$50` };

describe("Square public rental service filters", () => {
  it("binds one service Add to its strict public detail page and visible rental heading", () => {
    expect(observedSquarePublicServiceControl(detail, add, null)).toEqual({ operation: "ADD", catalogUrl: catalog, serviceId: choice.serviceId, name: choice.name });
    expect(observedSquarePublicServiceControl(detail, { ...add, label: "Add" }, null)?.operation).toBe("ADD");
    expect(observedSquarePublicServiceControl(detail, add, choice)).toBeNull();
    expect(observedSquarePublicServiceControl(catalog, add, null)).toBeNull();
  });

  it("requires that same session's selected service before Next can open the public calendar", () => {
    expect(observedSquarePublicServiceControl(catalog, next, choice)).toMatchObject({ operation: "NEXT", catalogUrl: catalog, serviceId: choice.serviceId });
    expect(observedSquarePublicServiceControl(catalog, next, null)).toBeNull();
    expect(observedSquarePublicServiceControl(catalog, next, { ...choice, nextUsed: true })).toBeNull();
    expect(observedSquarePublicServiceControl(catalog, next, { ...choice, catalogUrl: catalog.replace("AAAAAAAAAAAAA", "CCCCCCCCCCCCC") })).toBeNull();
    expect(observedSquarePublicServiceControl(detail, next, choice)).toBeNull();
    expect(observedSquarePublicServiceControl(catalog.replace("/services", "/availability"), next, choice)).toBeNull();
  });

  it.each(["Member 1 hour practice", "3 month practice membership", "1 hour lesson", "Practice lesson package", "Club fitting", "Practice reservation", "Practice payment", "1 hour practice mem\u200bber"])(
    "excludes %s rather than assigning a public rental filter", publicHeading => {
      expect(observedSquarePublicServiceControl(detail, { ...add, publicHeading }, null)).toBeNull();
    });

  it.each(["wrong-host", "credentials", "http", "fragment", "unknown-query", "duplicate-query", "wrong-id", "checkout", "form", "sensitive", "label", "slot", "unknown-button"])(
    "does not broaden %s into a service action", failure => {
      let url = detail;
      const item = { ...add, insideForm: false, sensitiveForm: false };
      if (failure === "wrong-host") url = detail.replace("book.squareup.com", "another.example.test");
      if (failure === "credentials") url = detail.replace("https://", "https://user:password@");
      if (failure === "http") url = detail.replace("https:", "http:");
      if (failure === "fragment") url += "#private";
      if (failure === "unknown-query") url += "?customer=private";
      if (failure === "duplicate-query") url += "?locale=en&locale=fr";
      if (failure === "wrong-id") url = detail.replace("BBBBBBBBBBBBBBBB", "not-public-id");
      if (failure === "checkout") url = detail.replace("/services/BBBBBBBBBBBBBBBB", "/checkout");
      if (failure === "form") item.insideForm = true;
      if (failure === "sensitive") item.sensitiveForm = true;
      if (failure === "label") item.label = "Add reservation";
      if (failure === "slot") item.name = "1:30 PM";
      if (failure === "unknown-button") item.name = "Continue";
      expect(observedSquarePublicServiceControl(url, item, null)).toBeNull();
    });

  it.each(["No services added yet", "Other public rental", `Member ${choice.name}`, `${choice.name} Payment`, `${choice.name} Customer details`])(
    "requires the selected public service summary, rejecting %s", text => {
      expect(observedSquarePublicServiceControl(catalog, { ...next, selectionSummary: `Appointment summary\n${text}` }, choice)).toBeNull();
    });
});
