import { request, type FullConfig } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  requireTrustedVercelPreviewUrl,
  VERCEL_PREVIEW_STORAGE_STATE
} from "../../src/lib/deployments/vercel-preview-auth";

export default async function globalSetup(config: FullConfig) {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) {
    return;
  }

  const configuredBaseUrl = config.projects[0]?.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("Preview protection bypass requires UI_SMOKE_BASE_URL");
  }
  const previewUrl = requireTrustedVercelPreviewUrl(configuredBaseUrl);
  const context = await request.newContext({
    baseURL: previewUrl.origin,
    extraHTTPHeaders: {
      "x-vercel-protection-bypass": secret,
      "x-vercel-set-bypass-cookie": "true"
    }
  });

  try {
    const response = await context.get("/");
    if (!response.ok() || new URL(response.url()).origin !== previewUrl.origin) {
      throw new Error("Vercel preview protection bypass did not reach the trusted preview");
    }
    await mkdir(dirname(VERCEL_PREVIEW_STORAGE_STATE), { recursive: true });
    await context.storageState({ path: VERCEL_PREVIEW_STORAGE_STATE });
  } finally {
    await context.dispose();
  }
}
