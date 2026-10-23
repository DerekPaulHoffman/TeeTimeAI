import { createInterface } from "node:readline";
import { z } from "zod";
import { createCourseDiscoveryBrowserSession } from "../../src/lib/course-discovery/browser-session";
import { executeAccessRecipe, venueProofMatches } from "../../src/lib/course-discovery/executor";
import { accessExecutionInputSchema, accessRecipeSchema, isSafeRecipeUrl, isSafeBrowserAvailabilityReadUrl, isSafeBrowserBootstrapReadUrl,
  parseAccessRecipe, SERVER_DOCUMENT_SELECTOR_MESSAGE } from "../../src/lib/course-discovery/recipe";
import { remoteProviderLease } from "../../src/lib/course-discovery/remote-provider-lease";
import { createAddressPinnedPublicFetchTransport } from "../../src/lib/automation/address-pinned-public-fetch";
import { requestFamilyForUrl } from "../../src/lib/course-discovery/request-family";
import { inspectSevenRoomsPublicProtocol, sevenRoomsPublicRangeUrl, sevenRoomsPublicRequests } from "../../src/lib/course-discovery/sevenrooms-public-direct";
import { safeBrowserActionIssues } from "./course-discovery-diagnostics.mjs";

function publicFailureCode(error: unknown) {
  if (error instanceof z.ZodError) return "BROWSER_ACTION_SCHEMA_INVALID";
  const message = error instanceof Error ? error.message : "";
  if (/^[A-Z_]{1,80}$/u.test(message)) return message;
  if (/\.evaluate:|ReferenceError:|__name is not defined/iu.test(message)) return "BROWSER_EVALUATION_FAILED";
  if (/page\.goto:|net::ERR_|navigation|navigating/iu.test(message)) return "BROWSER_NAVIGATION_FAILED";
  if (/browserType\.launch|executable|browser.*(?:closed|launch|install)/iu.test(message)) return "BROWSER_UNAVAILABLE";
  return "BROWSER_ACTION_FAILED";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--validate-recipe")) {
    let source = "";
    for await (const chunk of process.stdin) {
      source += chunk;
      if (Buffer.byteLength(source, "utf8") > 131_072) throw new Error("REQUEST_TOO_LARGE");
    }
    const knownPaths = new Set("schemaVersion target courseId offeringId kind source officialUrl bookingUrl venueName venueAddress providerFamily timeZone engine browserTransport pageUrl availabilityResponse serverDocument endDatePath success equals permittedRoutes origin path methods queryKeys steps action selector monthYearSelector nextSelector previousSelector daySelector productSelector text purpose value proof venue date monthYear day complete empty players durationMinutes slots scope label expectedLabel collection startsAt endsAt derive availableSpots minimumPlayers capacity holes resourceId productId request url method body adapter family facilityId facilityIds alias scheduleId bookingClassId ownerKey businessId rentalProductIds tenant serviceId serviceName clubSlug facilitySlug clubId courseBuckets courseIds name companyId services locationIds durations minutes variationId id requestBinding metadataRequest responseRows dateKey rowsPath typePath excludeType availableTypes accessIdPath labelPath expectedRentalLabel expectedRentalLabels startsAtPath durationMinutesPath publicVenueMetadata availabilityDateKey".split(" "));
    const safeMessages = new Set([SERVER_DOCUMENT_SELECTOR_MESSAGE, "Expected a bounded public display selector", "Unknown or malformed template parameter", "Field readers must match the engine", "Outdoor recipes require available-player evidence", "Simulator recipes require offering, duration and end-time proof", "Simulator player count is saved context and cannot parameterize availability", "Simulator availability may request only one bay; saved players are context"]);
    try {
      const value = JSON.parse(source) as { recipe: unknown };
      parseAccessRecipe(value.recipe);
      process.stdout.write(`${JSON.stringify({ valid: true })}\n`);
    } catch (error) {
      const issues = error instanceof z.ZodError ? error.issues.slice(0, 16).map(issue => ({
        path: issue.path.slice(0, 8).map(part => typeof part === "number" && part >= 0 && part < 1000 ? String(part) : knownPaths.has(String(part)) ? String(part) : "field").join("."),
        code: issue.code,
        message: safeMessages.has(issue.message) ? issue.message : "Recipe field does not match the required schema.",
      })) : [{ path: "recipe", code: "invalid_json", message: "Recipe must be a JSON object." }];
      process.stdout.write(`${JSON.stringify({ valid: false, issues })}\n`);
    }
    return;
  }
  if (args.includes("--recipe-schema")) {
    process.stdout.write(`${JSON.stringify(z.toJSONSchema(accessRecipeSchema, { io: "input", unrepresentable: "any" }))}\n`);
    return;
  }
  const at = args.indexOf("--deadline");
  const deadlineAt = new Date(at >= 0 ? args[at + 1] : "");
  if (!Number.isFinite(deadlineAt.getTime()) || deadlineAt.getTime() <= Date.now()) throw new Error("INVALID_DEADLINE");
  const requestLease = remoteProviderLease();
  if (args.includes("--inspect-public-protocol")) {
    const lineInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let id: number | null = null;
    try {
      for await (const line of lineInput) {
        if (Buffer.byteLength(line, "utf8") > 16_384) throw new Error("REQUEST_TOO_LARGE");
        const candidate = JSON.parse(line) as { id?: unknown };
        if (Number.isInteger(candidate?.id) && Number(candidate.id) >= 1 && Number(candidate.id) <= 1_000_000) id = Number(candidate.id);
        const value = z.object({ id: z.number().int().min(1).max(1_000_000), source: z.object({
          bookingUrl: z.string().max(2048).refine(isSafeRecipeUrl), venueName: z.string().min(2).max(200),
          venueAddress: z.string().trim().min(3).max(1024), timeZone: z.string().min(1).max(100),
        }).strict(), input: accessExecutionInputSchema }).strict().parse(candidate);
        id = value.id;
        const { source, input } = value;
        if (source.timeZone !== input.timeZone || /[\u0000-\u001f\u007f]/u.test(source.venueName + source.venueAddress))
          throw new Error("SEVENROOMS_INPUT_UNVERIFIED");
        const requests = sevenRoomsPublicRequests(source.bookingUrl);
        const expected = [requests.metadataUrl, sevenRoomsPublicRangeUrl(source.bookingUrl, input, isSafeRecipeUrl)];
        const workDeadline = Math.min(deadlineAt.getTime(), Date.now() + 40_000);
        let readCount = 0, totalBytes = 0;
        const readJson = async (url: string) => {
          const position = readCount;
          if (position >= 2 || url !== expected[position] || Date.now() >= workDeadline ||
              !(position === 0 ? isSafeBrowserBootstrapReadUrl(url, "fetch", "GET") : isSafeBrowserAvailabilityReadUrl(url, "fetch", "GET")))
            throw new Error("PUBLIC_PROTOCOL_REQUEST_REJECTED");
          readCount++;
          const transport = createAddressPinnedPublicFetchTransport({
            parseUrl: candidate => { if (candidate !== url) throw new Error("PUBLIC_PROTOCOL_REQUEST_REJECTED"); return new URL(candidate); },
            maxResponseBytes: 2_000_000, timeoutMs: 15_000, redirectLimit: 0,
          });
          const result = await requestLease(requestFamilyForUrl(url), async () => {
            if (Date.now() >= workDeadline) throw new Error("PUBLIC_PROTOCOL_DEADLINE");
            const response = await transport(url, { method: "GET", credentials: "omit", redirect: "error",
              signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, workDeadline - Date.now()))) });
            const bytes = await response.arrayBuffer();
            totalBytes += bytes.byteLength;
            if (bytes.byteLength > 2_000_000 || totalBytes > 4_000_000) throw new Error("PUBLIC_PROTOCOL_RESPONSE_LIMIT");
            if (response.status === 429) throw new Error("PROVIDER_THROTTLED");
            if (response.status !== 200) return { status: response.status, body: null };
            if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/iu.test(response.headers.get("content-type") ?? ""))
              throw new Error("PUBLIC_PROTOCOL_NOT_JSON");
            return { status: response.status, body: JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown };
          });
          if (!result.acquired) throw new Error("PROVIDER_COORDINATION_UNAVAILABLE");
          return result.value;
        };
        const descriptor = await inspectSevenRoomsPublicProtocol(source, input, readJson, venueProofMatches, isSafeRecipeUrl);
        if (readCount !== 2 || Date.now() >= workDeadline) throw new Error("PUBLIC_PROTOCOL_INCOMPLETE");
        const measured = { ...descriptor, observation: { ...descriptor.observation, publicRequests: readCount, publicResponseBytes: totalBytes } };
        const result = JSON.stringify({ id, ok: true, result: measured });
        if (Buffer.byteLength(result, "utf8") > 32_768) throw new Error("PUBLIC_PROTOCOL_OUTPUT_LIMIT");
        process.stdout.write(`${result}\n`);
        return;
      }
      throw new Error("PUBLIC_PROTOCOL_INPUT_REQUIRED");
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: publicFailureCode(error) })}\n`);
    } finally { lineInput.close(); }
    return;
  }
  if (args.includes("--execute-recipe")) {
    let source = "";
    for await (const chunk of process.stdin) {
      source += chunk;
      if (source.length > 131_072) throw new Error("REQUEST_TOO_LARGE");
    }
    const value = JSON.parse(source) as { recipe: unknown; input: unknown };
    const result = await executeAccessRecipe(parseAccessRecipe(value.recipe), accessExecutionInputSchema.parse(value.input), { deadlineAt, requestLease });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const initialAt = args.indexOf("--initial-urls");
  const initialUrls: unknown = JSON.parse(initialAt >= 0 ? args[initialAt + 1] : "[]");
  if (!Array.isArray(initialUrls) || !initialUrls.every(value => typeof value === "string")) throw new Error("INVALID_INITIAL_URLS");
  const configuredTransport = process.env.COURSE_DISCOVERY_BROWSER_TRANSPORT ?? "PINNED_HTTP";
  if (!["PINNED_HTTP", "NATIVE_CHROME"].includes(configuredTransport)) throw new Error("INVALID_BROWSER_TRANSPORT");
  const timeZoneAt = args.indexOf("--time-zone");
  const timeZone = timeZoneAt >= 0 ? args[timeZoneAt + 1] : "UTC";
  const venueNameAt = args.indexOf("--venue-name");
  const venueName = venueNameAt >= 0 ? args[venueNameAt + 1] : undefined;
  const venueAddressAt = args.indexOf("--venue-address");
  const venueAddress = venueAddressAt >= 0 ? args[venueAddressAt + 1] : undefined;
  if (venueAddress !== undefined && (venueAddress.length > 1024 || /[\u0000-\u001f\u007f]/u.test(venueAddress))) throw new Error("INVALID_VENUE_IDENTITY");
  const officialUrlAt = args.indexOf("--venue-official-url");
  const venueOfficialUrl = officialUrlAt >= 0 ? args[officialUrlAt + 1] : undefined;
  const session = await createCourseDiscoveryBrowserSession({ deadlineAt, initialUrls, timeZone, venueName, venueAddress, venueOfficialUrl }, { requestLease,
    browserTransport: configuredTransport as "PINNED_HTTP" | "NATIVE_CHROME" });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const timer = setTimeout(() => { input.close(); void session.close(); }, Math.max(1, deadlineAt.getTime() - Date.now()));
  try {
    for await (const line of input) {
      let id: unknown = null;
      try {
        if (line.length > 16_384) throw new Error("REQUEST_TOO_LARGE");
        const value = JSON.parse(line) as { id?: unknown; action?: string };
        id = value.id ?? null;
        const result = await session.execute(value);
        process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
        if (value.action === "finish") break;
      } catch (error) {
        const code = publicFailureCode(error);
        const issues = error instanceof z.ZodError ? safeBrowserActionIssues(error.issues) : undefined;
        process.stdout.write(`${JSON.stringify({ id, ok: false, error: code, diagnostics: session.diagnostics(), ...(issues ? { issues } : {}) })}\n`);
      }
    }
  } finally { clearTimeout(timer); input.close(); await session.close(); }
}

void main().catch(error => {
  process.stderr.write(`${publicFailureCode(error)}\n`);
  process.exitCode = 1;
});
