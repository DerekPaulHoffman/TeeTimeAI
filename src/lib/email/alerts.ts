import { Resend } from "resend";

type TeeTimeAlertInput = {
  to: string;
  courseName: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
  idempotencyKey?: string;
};

export async function sendTeeTimeAlert(input: TeeTimeAlertInput) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL_FROM) {
    console.log("[email:dry-run]", {
      to: input.to,
      courseName: input.courseName,
      startsAt: input.startsAt.toISOString(),
      bookingUrl: input.bookingUrl
    });
    return { id: "dry-run" };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const result = await resend.emails.send(
    {
      from: process.env.ALERT_EMAIL_FROM,
      to: input.to,
      subject: `New tee time at ${input.courseName}`,
      html: renderAlertHtml(input)
    },
    input.idempotencyKey
      ? {
          headers: {
            "Idempotency-Key": input.idempotencyKey
          }
        }
      : undefined
  );

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data;
}

export function renderAlertHtml(input: TeeTimeAlertInput) {
  const courseName = escapeHtml(input.courseName);
  const startsAt = escapeHtml(input.startsAt.toLocaleString());
  const availableSpots = escapeHtml(String(input.availableSpots));
  const bookingUrl = escapeHtml(input.bookingUrl);

  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#14231d">
      <h1 style="font-size:24px;margin:0 0 12px">New tee time found</h1>
      <p><strong>${courseName}</strong></p>
      <p>${startsAt} &middot; ${availableSpots} spots available</p>
      <p>
        <a href="${bookingUrl}" style="background:#d9862f;color:#1d1309;padding:12px 16px;border-radius:999px;text-decoration:none;font-weight:700">
          Open official booking page
        </a>
      </p>
      <p style="color:#5c6c64;font-size:13px">Tee Time Spot does not hold or book this slot. Complete the reservation on the course site.</p>
    </div>
  `;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
