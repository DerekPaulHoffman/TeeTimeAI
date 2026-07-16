import { createHash } from "node:crypto";

const SAFE_RUNTIME_VERSION = /^[a-zA-Z0-9._:-]{1,128}$/;

export function getAutomationRuntimeVersion() {
  const value =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    "local";

  if (SAFE_RUNTIME_VERSION.test(value)) {
    return value;
  }

  return `opaque:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
