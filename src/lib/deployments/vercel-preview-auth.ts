import { resolve } from "node:path";

export const VERCEL_PREVIEW_STORAGE_STATE = resolve(
  "test-results/playwright/.auth/vercel-preview.json"
);

const TRUSTED_PREVIEW_HOST =
  /^teetimeai-[a-z0-9-]+-derekpaulhoffmans-projects\.vercel\.app$/;

export function requireTrustedVercelPreviewUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    !TRUSTED_PREVIEW_HOST.test(url.hostname)
  ) {
    throw new Error(
      "Preview smoke requires the root HTTPS URL of a teetimeai deployment in the expected Vercel account"
    );
  }
  return url;
}
