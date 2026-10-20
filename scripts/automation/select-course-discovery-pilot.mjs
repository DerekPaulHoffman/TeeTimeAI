import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// An observer may identify a new platform without it already having an adapter.
// Generic placeholders do not establish distinct provider families.
const genericFamilies = new Set(["CUSTOM", "OTHER", "NONE", "NULL", "SOURCE_MISSING", "MISSING", "GENERIC", "UNSUPPORTED", "TBD", "NOT_SET", "NOT_APPLICABLE", "AUTO"]);
function identifiedFamily(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) && !genericFamilies.has(value) &&
    !/^(?:UNKNOWN|UNCLASSIFIED|UNIDENTIFIED|UNSPECIFIED)(?:_|$)/u.test(value);
}
const MAX_INVENTORY_AGE_MS = 60 * 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const hash = value => createHash("sha256").update(value).digest("hex");
const nameKey = value => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/gu, "");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function publicUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !isIP(url.hostname.replace(/^\[|\]$/gu, "")) && url.hostname.includes(".") &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname) &&
      ![...url.searchParams.keys()].some(key => /token|secret|password|session|cookie|authorization|api.?key|email/iu.test(key));
  } catch { return false; }
}

/** Pure selection. The catalog is observer evidence, never worker input or a live verification. */
export function selectCourseDiscoveryPilot(catalog, { seed = randomBytes(32).toString("hex"), now = new Date() } = {}) {
  if (typeof seed !== "string" || !seed.length || seed.length > 128 || /[\u0000-\u001f\u007f]/u.test(seed)) throw new Error("INVALID_SEED");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("INVALID_CLOCK");
  if (!catalog || typeof catalog !== "object" || catalog.schemaVersion !== 1 || !Array.isArray(catalog.candidates) || catalog.candidates.length > 500) throw new Error("INVALID_CATALOG");
  const ids = new Map();
  for (const candidate of catalog.candidates) {
    if (candidate && typeof candidate === "object" && typeof candidate.id === "string") ids.set(candidate.id, (ids.get(candidate.id) ?? 0) + 1);
  }
  const orderedDraw = catalog.candidates.map((candidate, index) => {
    const value = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
    const id = typeof value.id === "string" && ID.test(value.id) ? value.id : null;
    const name = typeof value.name === "string" && value.name.trim().length >= 2 && value.name.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value.name) ? value.name.trim() : null;
    const providerFamily = typeof value.providerFamily === "string" ? value.providerFamily.trim().toUpperCase().replace(/[\s-]+/gu, "_") : null;
    const reasons = [];
    if (!id) reasons.push("INVALID_ID");
    if (id && ids.get(id) > 1) reasons.push("DUPLICATE_ID");
    if (!name) reasons.push("INVALID_NAME");
    if (name && ["golfcove", "onegolfhaven", "tashua"].some(excluded => nameKey(name).includes(excluded))) reasons.push("DEVELOPMENT_CASE");
    if (!["OUTDOOR", "SIMULATOR"].includes(value.kind)) reasons.push("INVALID_KIND");
    if (value.countryCode !== "US") reasons.push("NOT_US");
    if (!identifiedFamily(providerFamily)) reasons.push("UNKNOWN_PROVIDER_FAMILY");
    if (value.unconfigured !== true) reasons.push("ALREADY_CONFIGURED");
    if (!publicUrl(value.officialUrl)) reasons.push("UNSAFE_OFFICIAL_URL");
    if (!publicUrl(value.inventoryEvidenceUrl)) reasons.push("UNSAFE_INVENTORY_EVIDENCE_URL");
    if (value.inventoryVerified !== true) reasons.push("INVENTORY_UNVERIFIED");
    const observedAt = typeof value.inventoryObservedAt === "string" ? Date.parse(value.inventoryObservedAt) : NaN;
    if (!Number.isFinite(observedAt)) reasons.push("INVALID_INVENTORY_TIME");
    else if (observedAt > now.getTime()) reasons.push("INVENTORY_EVIDENCE_FUTURE");
    else if (now.getTime() - observedAt > MAX_INVENTORY_AGE_MS) reasons.push("INVENTORY_EVIDENCE_STALE");
    const observerReason = typeof value.excludedReason === "string" && value.excludedReason.trim()
      ? value.excludedReason.trim().replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300) : null;
    if (observerReason) reasons.push("OBSERVER_EXCLUDED");
    return { catalogIndex: index, id, name, kind: ["OUTDOOR", "SIMULATOR"].includes(value.kind) ? value.kind : null,
      providerFamily, officialUrl: publicUrl(value.officialUrl) ? value.officialUrl : null,
      inventoryEvidenceUrl: publicUrl(value.inventoryEvidenceUrl) ? value.inventoryEvidenceUrl : null,
      inventoryObservedAt: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null,
      score: hash(`${seed}\0${id ?? `invalid-index:${index}`}`), eligible: reasons.length === 0, reasons, observerReason };
  }).sort((left, right) => left.score.localeCompare(right.score) || String(left.id).localeCompare(String(right.id)) || left.catalogIndex - right.catalogIndex)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
  const eligible = orderedDraw.filter(candidate => candidate.eligible);
  let selected = [];
  if (new Set(eligible.map(candidate => candidate.providerFamily)).size >= 3 && new Set(eligible.map(candidate => candidate.kind)).size === 2) {
    for (let first = 0; first < eligible.length - 2 && selected.length === 0; first++) {
      for (let second = first + 1; second < eligible.length - 1 && selected.length === 0; second++) {
        if (eligible[first].providerFamily === eligible[second].providerFamily) continue;
        for (let third = second + 1; third < eligible.length; third++) {
          const triple = [eligible[first], eligible[second], eligible[third]];
          if (new Set(triple.map(candidate => candidate.providerFamily)).size === 3 && new Set(triple.map(candidate => candidate.kind)).size === 2) {
            selected = triple; break;
          }
        }
      }
    }
  }
  return { schemaVersion: 1, status: selected.length === 3 ? "SELECTED" : "NO_ELIGIBLE_TRIPLE", seed,
    generatedAt: now.toISOString(), catalogHash: hash(canonical(catalog)),
    selectionMethod: "SHA256(seed + NUL + stable ID); first rank-ordered triple satisfying all constraints; no reroll",
    constraints: { count: 3, minimumOutdoor: 1, minimumSimulator: 1, distinctProviderFamilies: 3, inventoryMaxAgeMinutes: 60 },
    evidenceBasis: "Observer-supplied inventory evidence; this utility performs no live verification and creates no alerts.",
    candidateCount: orderedDraw.length, eligibleCount: eligible.length, selected,
    orderedDraw, excludedCandidates: orderedDraw.filter(candidate => !candidate.eligible) };
}

async function main() {
  const args = process.argv.slice(2);
  let catalogPath; let seed;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--catalog" && !catalogPath && args[index + 1]) catalogPath = resolve(args[++index]);
    else if (args[index] === "--seed" && seed === undefined && args[index + 1]) seed = args[++index];
    else throw new Error("INVALID_ARGUMENTS");
  }
  if (!catalogPath) throw new Error("CATALOG_REQUIRED");
  const file = await stat(catalogPath);
  if (!file.isFile() || file.size > 2_000_000) throw new Error("INVALID_CATALOG_FILE");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const receipt = selectCourseDiscoveryPilot(catalog, { seed });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== "SELECTED") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "INVALID_INPUT", error: /^[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "CATALOG_READ_FAILED" })}\n`);
    process.exitCode = 2;
  });
}
