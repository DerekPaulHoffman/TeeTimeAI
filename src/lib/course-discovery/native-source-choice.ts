import { parseTeeItUpRecipeSource } from "./teeitup-recipe-source";
import { uschedulePublicTenant } from "@/lib/simulators/providers/public-configuration";

/** A narrow routing shape, never identity, public access or availability proof. */
export function strictNativeSupportedSource(value: string): "FOREUP" | "TEEITUP" | "USCHEDULE" | undefined {
  try {
    const url = new URL(value);
    if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (uschedulePublicTenant(value)) return "USCHEDULE";
    if (!url.search && !url.hash && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book\.teeitup\.(?:com|golf)$/u.test(url.hostname) && parseTeeItUpRecipeSource(value)) return "TEEITUP";
    const ids = /^\/index\.php\/booking\/([1-9]\d{0,9})\/([1-9]\d{0,9})\/?$/u.exec(url.pathname);
    if (url.hostname === "foreupsoftware.com" && !url.search && ["", "#/teetimes", "#teetimes"].includes(url.hash) &&
      ids && [ids[1], ids[2]].every(id => Number(id) <= 2_147_483_647)) return "FOREUP";
  } catch { /* Unknown routes retain the existing model path. */ }
}

export type NativeSourceChoiceCapture = {
  pageUrl: string; observedAt: number; documentHash: string; settled: boolean;
  links: string[]; frames: string[]; linksOverflow: boolean; framesOverflow: boolean;
};
/** Both inputs come only from the owned native controller, with private loader/frame
 * identity included in documentHash. No serialized/model caller can invoke this seam. */
export function uniqueNativeSupportedSource(first: NativeSourceChoiceCapture, second: NativeSourceChoiceCapture,
  clock: { startedAt: number; now: number; deadline: number }) {
  if (!first.settled || !second.settled || first.pageUrl !== second.pageUrl || first.documentHash !== second.documentHash ||
    !/^[a-f0-9]{64}$/u.test(second.documentHash) || first.observedAt < clock.startedAt || second.observedAt < first.observedAt ||
    second.observedAt > clock.now || clock.now >= clock.deadline || first.linksOverflow || first.framesOverflow || second.linksOverflow || second.framesOverflow ||
    [first, second].some(value => !Array.isArray(value.links) || value.links.length > 160 || !Array.isArray(value.frames) || value.frames.length > 24 ||
      [...value.links, ...value.frames].some(url => typeof url !== "string"))) return null;
  const choices = (value: NativeSourceChoiceCapture) => [...new Set([...value.links, ...value.frames])].filter(url => url !== value.pageUrl && strictNativeSupportedSource(url));
  const before = choices(first), after = choices(second);
  if (before.length !== 1 || after.length !== 1 || before[0] !== after[0]) return null;
  const url = after[0], link = second.links.includes(url), frame = second.frames.includes(url);
  return { kind: "NATIVE_UNIQUE_SUPPORTED_SOURCE" as const, pageUrl: second.pageUrl, observedAt: new Date(second.observedAt).toISOString(),
    documentHash: second.documentHash, url, family: strictNativeSupportedSource(url)!, via: link && frame ? "LINK_AND_FRAME" as const : link ? "LINK" as const : "FRAME" as const };
}
