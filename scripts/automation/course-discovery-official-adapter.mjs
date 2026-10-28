import { join } from "node:path";
import { discoveryError } from "./course-discovery-client.mjs";

export const OFFICIAL_ADAPTER_INSPECTION_MS = 30_000;
function officialRoot(value) {
  try {
    const url = new URL(value), match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.teesnap\.net$/u.exec(url.hostname);
    if (!match || ["www", "api", "admin", "account", "login"].includes(match[1]) || url.href !== value ||
      url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
    return { url: url.href, tenant: match[1] };
  } catch { return null; }
}
const plainText = (value, min, max) => typeof value === "string" && value.trim() === value && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
/** Routing only. Fresh fixed identity/catalog reads and both backend challenges
 * still own authority; this predicate cannot authorize availability or a method. */
export function isOfficialAdapterJob(job) {
  const { identity, target, input } = job?.request ?? {}, root = officialRoot(identity?.officialUrl);
  if (!root || target?.kind !== "OUTDOOR" || target.offeringId !== undefined || !/^[A-Za-z0-9_-]{1,128}$/u.test(target.courseId ?? "") ||
    identity.bookingUrl != null && identity.bookingUrl !== root.url || !plainText(identity.name, 3, 200) || !plainText(identity.address, 3, 1024) ||
    !plainText(identity.timeZone, 1, 100) || input?.timeZone !== identity.timeZone || input.durationMinutes !== undefined) return false;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: identity.timeZone }).resolvedOptions().timeZone === identity.timeZone; }
  catch { return false; }
}

/** One owned fixed helper; JSON-line RPC and credentials never enter model input. */
export async function inspectOfficialAdapter({ job, cwd, deadlineAt, helperEnvironment = {}, signal, processFactory }) {
  if (!isOfficialAdapterJob(job)) throw discoveryError("OFFICIAL_ADAPTER_SCOPE_INVALID");
  signal?.throwIfAborted();
  const remaining = Math.min(OFFICIAL_ADAPTER_INSPECTION_MS, Date.parse(deadlineAt) - Date.now());
  if (!(remaining > 0)) throw discoveryError("DISCOVERY_WORK_DEADLINE");
  const { createDiscoveryProcess, discoveryProcessEnvironment } = await import("./course-discovery-worker.mjs");
  signal?.throwIfAborted();
  const source = { officialUrl: job.request.identity.officialUrl, bookingUrl: job.request.identity.officialUrl,
    venueName: job.request.identity.name, venueAddress: job.request.identity.address, timeZone: job.request.identity.timeZone };
  const payload = { target: job.request.target, source, input: job.request.input };
  if (Buffer.byteLength(JSON.stringify(payload)) > 16_384) throw discoveryError("OFFICIAL_ADAPTER_INPUT_LIMIT");
  const receipt = { transport: "FIXED_PUBLIC_ROOT", modelCalls: 0, helperClosed: false, outcome: "INCOMPLETE" };
  let channel, result, failure;
  try {
    signal?.throwIfAborted();
    if (Date.now() >= Date.parse(deadlineAt)) throw discoveryError("DISCOVERY_WORK_DEADLINE");
    channel = (processFactory ?? createDiscoveryProcess)({ executable: process.execPath,
      args: [join(cwd, "node_modules/tsx/dist/cli.mjs"), join(cwd, "scripts/automation/course-discovery-browser.ts"),
        "--inspect-official-adapter", "--deadline", deadlineAt], cwd,
      environment: { ...discoveryProcessEnvironment(), ...helperEnvironment }, signal, timeoutMs: remaining });
    result = await channel.request(payload);
    signal?.throwIfAborted();
    if (Date.now() >= Date.parse(deadlineAt)) throw discoveryError("DISCOVERY_WORK_DEADLINE");
    const adapter = result?.adapter, root = officialRoot(source.officialUrl);
    if (!adapter || Object.keys(result).sort().join(",") !== "adapter,observation" ||
      Object.keys(result.observation ?? {}).sort().join(",") !== "publicRequests,publicResponseBytes,transport" ||
      Object.keys(adapter).sort().join(",") !== "catalogHash,courseId,defaultAddons,defaultHoles,family,tenant,timeZone" ||
      adapter.family !== "TEESNAP" || adapter.tenant !== root.tenant || adapter.timeZone !== source.timeZone ||
      !Number.isSafeInteger(adapter.courseId) || adapter.courseId < 1 || adapter.courseId > 2147483647 ||
      adapter.defaultHoles !== 18 || adapter.defaultAddons !== "off" || !/^[a-f0-9]{64}$/u.test(adapter.catalogHash ?? "") ||
      result.observation?.transport !== "FIXED_PUBLIC_ROOT" || result.observation.publicRequests !== 1 ||
      !Number.isSafeInteger(result.observation.publicResponseBytes) || result.observation.publicResponseBytes < 1 || result.observation.publicResponseBytes > 600_000)
      throw discoveryError("OFFICIAL_ADAPTER_RESULT_INVALID");
    Object.assign(receipt, result.observation, { outcome: "INSPECTED" });
  } catch (error) { failure = error; }
  finally {
    try { if (channel) { await channel.close(); receipt.helperClosed = true; } }
    catch { failure ??= discoveryError("OFFICIAL_ADAPTER_CLOSE_FAILED"); }
  }
  if (failure) { receipt.outcome = "FAILED"; failure.officialAdapterReceipt = receipt; throw failure; }
  if (!receipt.helperClosed) throw discoveryError("OFFICIAL_ADAPTER_CLOSE_FAILED");
  return { recipe: { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { ...job.request.target },
      source: { ...source, providerFamily: "TEESNAP" }, adapter: result.adapter },
    sourceEvidence: { officialUrl: source.officialUrl, observedBookingUrl: source.bookingUrl }, receipt };
}
