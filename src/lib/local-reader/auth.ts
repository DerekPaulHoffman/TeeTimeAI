import { NextRequest, NextResponse } from "next/server";

import { verifyLocalReaderSignature } from "./contracts";

const MAX_CLOCK_SKEW_MS = 60_000;

export function assertLocalReaderRequest(
  request: NextRequest,
  serializedBody = ""
) {
  const secret = process.env.LOCAL_READER_DEVICE_TOKEN
    ?.replace(/^\uFEFF/u, "")
    .trim();
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { error: "Local reader device authentication is unavailable." },
      { status: 503 }
    );
  }
  const timestamp = request.headers.get("x-local-reader-timestamp") || "";
  const signature = request.headers.get("x-local-reader-signature") || "";
  if (
    !/^\d{13}$/u.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > MAX_CLOCK_SKEW_MS
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const signedPath = `${url.pathname}${url.search}`;
  const valid = verifyLocalReaderSignature(
    secret,
    `${request.method}\n${signedPath}\n${timestamp}\n${serializedBody}`,
    signature
  );
  return valid
    ? null
    : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
