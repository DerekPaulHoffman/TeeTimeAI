import { describe, expect, it } from "vitest";

import { renderCustomerEmail } from "./customer-email";
import { getSafeCustomerBookingUrl } from "./customer-booking-url";

describe("getSafeCustomerBookingUrl", () => {
  it.each([
    "http://localhost/tee-times",
    "http://127.0.0.1/tee-times",
    "http://10.0.0.4/tee-times",
    "http://172.20.0.4/tee-times",
    "http://192.168.1.4/tee-times",
    "http://198.18.0.1/tee-times",
    "http://198.19.255.255/tee-times",
    "http://192.0.2.1/tee-times",
    "http://198.51.100.1/tee-times",
    "http://203.0.113.1/tee-times",
    "http://[::1]/tee-times",
    "http://[::ffff:127.0.0.1]/tee-times",
    "http://[::ffff:10.0.0.1]/tee-times",
    "http://[::ffff:c0a8:101]/tee-times",
    "https://course.internal/tee-times",
    "https://course.local/tee-times"
  ])("rejects a local or private destination: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://memberdashboard.course.example/tee-times",
    "https://authservice.course.example/tee-times",
    "https://accountrecovery.course.example/tee-times",
    "https://billingportal.course.example/tee-times",
    "https://apikey.course.example/tee-times",
    "https://example.queue-it.net/"
  ])("rejects an access or transaction surface host: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/#access_token=private",
    "https://course.example/#/checkout-session/start",
    "https://course.example/#redirect=https%3A%2F%2F127.0.0.1%2Fadmin",
    "https://course.example/tee-times#session_state=private",
    "https://course.example/tee-times#https://evil.example/login",
    "https://course.example/tee-times#//evil.example/path",
    "https://course.example/tee-times#https:%5C%5Cevil.example%2Fpath",
    "https://course.example/tee-times#%5C%5Cevil.example%5Cpath"
  ])("rejects a sensitive fragment: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?redirect=https%3A%2F%2F127.0.0.1%2Fadmin",
    "https://course.example/tee-times?next=%2Ftee-times%3Fsession%3Dprivate",
    "https://course.example/tee-times?url=https%253A%252F%252Fcourse.example%252Fcheckout-session%252Fstart",
    "https://course.example/tee-times?returnPath=%2Fmember-portal%2Fbooking",
    "https://course.example/tee-times?campaign=%5C%5Cevil.example%5Cpath",
    "https://course.example/tee-times?redirect=https:%5C%5Cevil.example%2Fpath"
  ])("rejects unsafe nested query state: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?next=/hop-one?next=/hop-two?next=http://127.0.0.1/private",
    "https://course.example/tee-times?next=/hop-one?next=/hop-two?next=/openings?JSESSIONID=private"
  ])("fails closed when a third nested URL remains: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it("rejects a public cross-origin navigation destination", () => {
    expect(
      getSafeCustomerBookingUrl(
        "https://course.example/tee-times?redirect=https://provider.example/tee-times"
      )
    ).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?bookingToken=private",
    "https://course.example/tee-times?bookingSession=private",
    "https://course.example/tee-times?reservationKey=private",
    "https://course.example/tee-times?campaign_booking_token_value=private"
  ])("rejects an embedded security token in a query key: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?JSESSIONID=private",
    "https://course.example/tee-times?PHPSESSID=private",
    "https://course.example/tee-times?PHPSESSIONID=private",
    "https://course.example/tee-times?ASPSESSIONIDABC123=private",
    "https://course.example/tee-times?ASP.NET_SessionId=private",
    "https://course.example/tee-times?SESSION_ID=private",
    "https://course.example/tee-times?sid=private",
    "https://course.example/tee-times?CFID=private",
    "https://course.example/tee-times?CFTOKEN=private",
    "https://course.example/tee-times?osCsid=private",
    "https://course.example/tee-times?connect.sid=private"
  ])("rejects a compact session identifier parameter: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?redirect=%2Fopenings%3FJSESSIONID%3Dprivate",
    "https://course.example/tee-times?next=https%3A%2F%2Fprovider.example%2Fopenings%3Fconnect.sid%3Dprivate",
    "https://course.example/tee-times#PHPSESSID=private",
    "https://course.example/tee-times#/openings?CFID=private&CFTOKEN=private"
  ])("rejects compact session identifiers in nested URLs and fragments: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?redirect=%2Ftee-times%3FbookingToken%3Dprivate",
    "https://course.example/tee-times?next=https%3A%2F%2Fprovider.example%2Ftee-times%3FbookingSession%3Dprivate",
    "https://course.example/tee-times#bookingToken=private",
    "https://course.example/tee-times#/openings?reservationKey=private"
  ])("rejects embedded security keys in nested URLs and fragments: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/myaccount/tee-times",
    "https://course.example/member-portal/booking",
    "https://course.example/memberteetimes",
    "https://course.example/sign_in/tee-times",
    "https://course.example/checkout-session/start",
    "https://course.example/accountteetimes"
  ])("rejects a compact account or transaction path: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/secure/tee-times",
    "https://course.example/customer/book/tee-times",
    "https://course.example/forgot-password/start",
    "https://course.example/oauth2-callback",
    "https://course.example/payment-method",
    "https://course.example/order-review",
    "https://course.example/tee-times?prompt=login",
    "https://course.example/tee-times?checkout_session_id=private"
  ])("rejects an access-controlled or transaction flow: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBeUndefined();
  });

  it.each([
    "https://course.example/tee-times?date=2026-07-16&players=4",
    "https://course.example/tee-times?mapsId=public-course-map",
    "https://course.example/tee-times?note=front%5Cnine",
    "https://course.example/tee-times?redirect=/tee-times?date=2026-07-16",
    "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
    "https://golfback.com/#/course/5a90fb0c-b928-43f0-9486-d5d43c03d25d"
  ])("keeps a credential-free public booking URL: %s", (url) => {
    expect(getSafeCustomerBookingUrl(url)).toBe(url);
  });
});

describe("renderCustomerEmail booking URL safety", () => {
  const baseInput = {
    variant: "instant" as const,
    heading: "A tee time opened",
    intro: "A matching opening is available.",
    preheader: "A matching opening is available.",
    summary: {
      targetDate: "2026-08-15",
      startTime: "08:00",
      endTime: "12:00",
      players: 4
    }
  };

  it("omits unsafe availability and monitoring links at the render boundary", () => {
    const privateUrl = "http://127.0.0.1/checkout-session/private";
    const sessionUrl = "https://course.example/tee-times?PHPSESSID=private";
    const html = renderCustomerEmail({
      ...baseInput,
      availabilityCourses: [
        {
          courseName: "Example Golf Course",
          rank: 1,
          bookingUrl: privateUrl,
          times: [
            {
              startsAt: "2026-08-15T14:00:00.000Z",
              availableSpots: 4,
              isNew: true
            }
          ]
        }
      ],
      monitoringCourses: [
        {
          courseName: "Second Golf Course",
          rank: 2,
          badgeLabel: "CHECK DIRECTLY",
          detail: "Use the official site.",
          tone: "direct",
          bookingUrl: sessionUrl
        }
      ]
    });

    expect(html).not.toContain(privateUrl);
    expect(html).not.toContain(sessionUrl);
    expect(html).not.toContain("Book this tee time");
    expect(html).not.toContain("Open official site &rarr;");
  });

  it("keeps provider public SPA routes clickable", () => {
    const foreUpUrl =
      "https://foreupsoftware.com/index.php/booking/21017#/teetimes";
    const html = renderCustomerEmail({
      ...baseInput,
      availabilityCourses: [
        {
          courseName: "Example Golf Course",
          rank: 1,
          bookingUrl: foreUpUrl,
          times: [
            {
              startsAt: "2026-08-15T14:00:00.000Z",
              availableSpots: 4,
              isNew: true
            }
          ]
        }
      ]
    });

    expect(html).toContain(`href="${foreUpUrl}"`);
    expect(html).toContain("Book this tee time");
  });
});
