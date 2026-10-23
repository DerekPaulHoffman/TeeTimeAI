// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSafeManualEvidenceUrl } from "./browser-discovery";

describe("manual discovery public TitleCase path consistency", () => {
  it.each([
    "http://www.cityofwestminster.us/ParksRecreation/GolfWestminster/WalnutCreekGolfPreserve",
    "https://public.example.org/CedarValleyNaturePreserve",
    "https://another.example.org/NorthRiverCommunityGolf"
  ])("accepts a segmented public path without changing its URL: %s", value => {
    expect(isSafeManualEvidenceUrl(new URL(value))).toBe(true);
  });

  it.each([
    "https://public.example.org/AbCdEfGhIjKlMnOpQrStUvWx",
    "https://public.example.org/AbcDefGhiJklMnoPqrStu",
    "https://public.example.org/AbcdefghijklmnopqrStuvwx",
    "https://public.example.org/walnutCreekGolfPreserve",
    "https://public.example.org/WalnutCREEKGolfPreserve",
    "https://public.example.org/WalnutCreekGolfPreserve123",
    "https://public.example.org/PublicPrivateCalendar",
    "https://public.example.org/PublicPaymentHistory",
    "https://public.example.org/PublicSecureCalendar",
    "https://public.example.org/PublicAccountRecovery",
    "https://public.example.org/PublicTokenCalendar",
    "https://public.example.org/PublicNonceCalendar",
    "https://public.example.org/PublicCodeDirectory",
    "https://public.example.org/App/GlobalTenantSettings",
    "https://public.example.org/PublicGlobalSettings",
    "https://public.example.org/PublicMetadataCatalog",
    "https://public.example.org/PublicBootstrapCalendar",
    "https://public.example.org/PublicConfigurationMenu",
    "https://public.example.org/PublicConfigCalendar",
    "https://public.example.org/PublicRemoteProcedure",
    "https://public.example.org/PublicProcedureCalls",
    "https://public.example.org/AlphaBravoCharlieDeltaEchoFoxtrotGolf",
    "https://public.example.org/AnexcessivelylongwordPublicCalendar",
    "https://public.example.org/PublicBookingConfirm",
    "https://public.example.org/redirect/WalnutCreekGolfPreserve",
    "https://public.example.org/link/WalnutCreekGolfPreserve",
    "https://public.example.org/%50ublic%54oken%43alendar",
    "https://public.example.org/path?label=WalnutCreekGolfPreserve",
    "https://public.example.org/path?next=/WalnutCreekGolfPreserve",
    "https://public.example.org/path#/WalnutCreekGolfPreserve",
    "https://public.example.org/WalnutCreekGolfPreserve?token=private",
    "https://public.example.org/WalnutCreekGolfPreserve/sk_live_abcdefghijklmnopqrst",
    "https://public.example.org/WalnutCreekGolfPreserve/abcdefgh.ijklmnop.qrstuvwx",
    "https://public.example.org/WalnutCreekGolfPreserve/AbcdefghijklmnopQrst==",
    "https://user:secret@public.example.org/WalnutCreekGolfPreserve",
    "https://127.0.0.1/WalnutCreekGolfPreserve",
    "https://private.internal/WalnutCreekGolfPreserve"
  ])("rejects opaque and sensitive lookalikes outside that path role: %s", value => {
    expect(isSafeManualEvidenceUrl(new URL(value))).toBe(false);
  });
});
