import { after } from "next/server";
import { startOperatorSmsForSearch } from "@/lib/operator-sms/launcher";
import { getOperatorSmsConfig } from "@/lib/operator-sms/config";
import {
  operatorSmsCallbackUrl,
  validateOperatorSmsCallback,
} from "@/lib/operator-sms/twilio";
import { recordOperatorSmsCallback } from "@/lib/operator-sms/service";

export async function POST(request: Request) {
  const config = getOperatorSmsConfig();
  if (!config) return new Response("Unavailable", { status: 503 });
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("attempt") ?? "";
  const raw = await request.text();
  if (
    raw.length > 16_384 ||
    id.length > 128 ||
    token.length > 128 ||
    !id ||
    !token
  )
    return new Response("Invalid request", { status: 400 });
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (
    !validateOperatorSmsCallback(
      config,
      operatorSmsCallbackUrl(config, id, token),
      request.headers.get("x-twilio-signature") ?? "",
      params,
    )
  )
    return new Response("Unauthorized", { status: 403 });
  if (!/^SM[0-9a-f]{32}$/i.test(params.MessageSid ?? ""))
    return new Response("Invalid message", { status: 400 });
  const sourceSearchId = await recordOperatorSmsCallback({
    id,
    token,
    sid: params.MessageSid,
    status: params.MessageStatus,
  });
  if (sourceSearchId) after(() => startOperatorSmsForSearch(sourceSearchId));
  return new Response(null, { status: 204 });
}
