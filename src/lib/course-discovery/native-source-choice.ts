import { parseTeeItUpRecipeSource } from "./teeitup-recipe-source";
import { uschedulePublicTenant, knownSimulatorPublicConfigurationFamily } from "@/lib/simulators/providers/public-configuration";
import { parseEzLinksSource } from "./ezlinks-source";
import { parseCpsSource } from "./cps-source";

/** A narrow routing shape, never identity, public access or availability proof. */
export function strictNativeSupportedSource(value: string): "FOREUP" | "TEEITUP" | "USCHEDULE" | "EZLINKS" | "CPS" | "ACUITY" | undefined {
  try {
    const url = new URL(value);
    if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (uschedulePublicTenant(value)) return "USCHEDULE";
    if (!url.search && !url.hash && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.as\.me$/u.test(url.hostname) &&
      !/^(?:www|app|api|admin|auth|login|account|member|private|checkout|payment)\.as\.me$/u.test(url.hostname) &&
      knownSimulatorPublicConfigurationFamily(value) === "ACUITY") return "ACUITY";
    if (parseEzLinksSource(value)) return "EZLINKS";
    if (!url.search && !url.hash && parseCpsSource(value)) return "CPS";
    if (!url.search && !url.hash && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book\.teeitup\.(?:com|golf)$/u.test(url.hostname) && parseTeeItUpRecipeSource(value)) return "TEEITUP";
    const ids = /^\/index\.php\/booking\/(?:index\/)?([1-9]\d{0,9})(?:\/([1-9]\d{0,9}))?\/?$/u.exec(url.pathname);
    if (url.hostname === "foreupsoftware.com" && !url.search && ["", "#/", "#/teetimes", "#teetimes"].includes(url.hash) &&
      ids && ids.slice(1).filter(Boolean).every(id => Number(id) <= 2_147_483_647) &&
      !(url.pathname.includes("/booking/index/") && ids[2])) return "FOREUP";
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
  const currentSearch = (value: NativeSourceChoiceCapture) => parseEzLinksSource(value.pageUrl) && new URL(value.pageUrl).pathname === "/search" ||
    ["CPS","ACUITY"].includes(strictNativeSupportedSource(value.pageUrl) ?? "");
  const choices = (value: NativeSourceChoiceCapture) => [...new Set([...(currentSearch(value) ? [value.pageUrl] : []), ...value.links, ...value.frames])]
    .filter(url => (url !== value.pageUrl || currentSearch(value)) && strictNativeSupportedSource(url));
  const before = choices(first), after = choices(second);
  if (before.length !== 1 || after.length !== 1 || before[0] !== after[0]) return null;
  const url = after[0], link = second.links.includes(url), frame = second.frames.includes(url);
  return { kind: "NATIVE_UNIQUE_SUPPORTED_SOURCE" as const, pageUrl: second.pageUrl, observedAt: new Date(second.observedAt).toISOString(),
    documentHash: second.documentHash, url, family: strictNativeSupportedSource(url)!, via: url === second.pageUrl ? "DOCUMENT" as const : link && frame ? "LINK_AND_FRAME" as const : link ? "LINK" as const : "FRAME" as const };
}
