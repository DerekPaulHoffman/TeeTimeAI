import { NextRequest, NextResponse } from "next/server";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";

/** This credential is accepted only by the bounded course-learning API. */
export function assertCourseDiscoveryRequest(request: NextRequest, serializedBody = "") {
  if (!new URL(request.url).pathname.startsWith("/api/course-discovery/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Only an absent setting enables migration fallback. A configured empty or
  // malformed credential must fail closed, not reuse the installed reader key.
  const expectedToken = process.env.COURSE_DISCOVERY_DEVICE_TOKEN !== undefined
    ? process.env.COURSE_DISCOVERY_DEVICE_TOKEN
    : process.env.LOCAL_READER_DEVICE_TOKEN;
  return assertLocalReaderRequest(request, serializedBody, expectedToken);
}
