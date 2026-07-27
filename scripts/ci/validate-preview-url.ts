import { requireTrustedVercelPreviewUrl } from "../../src/lib/deployments/vercel-preview-auth";

requireTrustedVercelPreviewUrl(process.env.UI_SMOKE_BASE_URL ?? "");
