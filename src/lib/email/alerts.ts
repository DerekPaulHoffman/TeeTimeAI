import { Resend } from "resend";

type TeeTimeAlertInput = {
  to: string;
  courseName: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
  idempotencyKey?: string;
};

type TeeTimeAlertDelivery =
  | {
      id: string;
      deliveryStatus: "dry_run";
    }
  | {
      id?: string;
      deliveryStatus: "sent";
    };

export async function sendTeeTimeAlert(input: TeeTimeAlertInput): Promise<TeeTimeAlertDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);

  if (!apiKey || !from || shouldDryRunRecipient(input.to)) {
    console.warn("[email:dry-run]", {
      to: input.to,
      courseName: input.courseName,
      startsAt: input.startsAt.toISOString(),
      bookingUrl: input.bookingUrl
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const resend = new Resend(apiKey);
  const result = await resend.emails.send(
    {
      from,
      to: input.to,
      subject: `A spot opened up at ${input.courseName}`,
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

  return { ...result.data, deliveryStatus: "sent" };
}

export function normalizeEmailEnvValue(value?: string) {
  return value?.replace(/\uFEFF/g, "").trim();
}

export function shouldDryRunRecipient(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();

  return (
    !domain ||
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain === "invalid" ||
    domain === "test" ||
    domain.endsWith(".local") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}

export function renderAlertHtml(input: TeeTimeAlertInput) {
  const courseName = escapeHtml(input.courseName);
  const startsAt = escapeHtml(input.startsAt.toLocaleString());
  const startsAtDate = escapeHtml(
    input.startsAt.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric"
    })
  );
  const startsAtTime = escapeHtml(
    input.startsAt.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    })
  );
  const availableSpots = escapeHtml(String(input.availableSpots));
  const bookingUrl = escapeHtml(input.bookingUrl);

  return `
    <div style="background:#f4efe5;padding:24px;font-family:Inter,Arial,sans-serif;color:#14231d;line-height:1.5">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e3dc;border-radius:12px;overflow:hidden">
        <div style="background:#111d18;color:#ffffff;padding:18px 22px">
          <div style="font-weight:800;font-size:18px">Tee Time Spot</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px">teetimespot.com</div>
        </div>
        <div style="background:linear-gradient(90deg,rgba(17,29,24,.92),rgba(17,29,24,.7)),url('https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=1200&q=80') center/cover;color:#ffffff;padding:34px 22px">
          <div style="display:inline-block;background:#e28a2f;color:#1d1309;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">
            New tee time alert
          </div>
          <p style="margin:18px 0 4px;color:rgba(255,255,255,.76);font-size:14px">${courseName}</p>
          <h1 style="font-size:30px;line-height:1.05;margin:0 0 12px">A spot just opened up!</h1>
          <p style="margin:0;color:rgba(255,255,255,.82)">
            We found a tee time that matches your search. Open the official course page before it is gone.
          </p>
        </div>
        <div style="padding:22px">
          <div style="border:1px solid #d9e3dc;border-radius:10px;padding:18px;margin-bottom:18px">
            <p style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#105338;margin:0 0 10px">Open now</p>
            <p style="font-size:18px;font-weight:800;margin:0 0 14px">${startsAtDate}</p>
            <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:16px">
              <div style="background:#f5f7f2;border-radius:8px;padding:12px">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Tee time</div>
                <div style="font-weight:800">${startsAtTime}</div>
              </div>
              <div style="background:#f5f7f2;border-radius:8px;padding:12px">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Golfers</div>
                <div style="font-weight:800">${availableSpots} players</div>
              </div>
              <div style="background:#f5f7f2;border-radius:8px;padding:12px">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Course</div>
                <div style="font-weight:800">18 holes</div>
              </div>
            </div>
            <p style="margin:0 0 6px;font-weight:800">${courseName}</p>
            <p style="margin:0;color:#5c6c64;font-size:14px">${startsAt}</p>
          </div>
          <p style="margin:0 0 22px">
            <a href="${bookingUrl}" style="display:inline-block;background:#e28a2f;color:#1d1309;padding:14px 18px;border-radius:999px;text-decoration:none;font-weight:800">
              Book this tee time
            </a>
          </p>
          <div style="background:#e6f3f7;border-radius:10px;color:#174152;padding:14px 16px;font-size:14px">
            That button goes straight to the course's own booking page. Tee Time Spot never
            handles your payment or personal info.
          </div>
        </div>
        <div style="background:#111d18;color:rgba(255,255,255,.72);padding:18px 22px;font-size:13px">
          You're getting this because you set up an alert on teetimespot.com. Availability is
          first come, first served.
        </div>
      </div>
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
