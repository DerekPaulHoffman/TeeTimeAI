import { createInterface } from "node:readline";
import { z } from "zod";
import { createCourseDiscoveryBrowserSession } from "../../src/lib/course-discovery/browser-session";
import { executeAccessRecipe } from "../../src/lib/course-discovery/executor";
import { accessExecutionInputSchema, accessRecipeSchema, parseAccessRecipe } from "../../src/lib/course-discovery/recipe";
import { remoteProviderLease } from "../../src/lib/course-discovery/remote-provider-lease";

function publicFailureCode(error: unknown) {
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
    const knownPaths = new Set("schemaVersion target courseId offeringId kind source officialUrl bookingUrl venueName venueAddress providerFamily timeZone engine browserTransport pageUrl availabilityResponse serverDocument endDatePath success equals permittedRoutes origin path methods queryKeys steps action selector monthYearSelector nextSelector previousSelector daySelector productSelector text purpose value proof venue date monthYear day complete empty players durationMinutes slots scope label expectedLabel collection startsAt endsAt derive availableSpots minimumPlayers capacity holes resourceId productId request url method body adapter family facilityId facilityIds alias scheduleId bookingClassId ownerKey businessId rentalProductIds".split(" "));
    const safeMessages = new Set(["Expected a bounded public display selector", "Unknown or malformed template parameter", "Field readers must match the engine", "Outdoor recipes require available-player evidence", "Simulator recipes require offering, duration and end-time proof", "Simulator player count is saved context and cannot parameterize availability", "Simulator availability may request only one bay; saved players are context"]);
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
  const session = await createCourseDiscoveryBrowserSession({ deadlineAt, initialUrls, timeZone, venueName, venueAddress }, { requestLease,
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
        process.stdout.write(`${JSON.stringify({ id, ok: false, error: code })}\n`);
      }
    }
  } finally { clearTimeout(timer); input.close(); await session.close(); }
}

void main().catch(error => {
  process.stderr.write(`${publicFailureCode(error)}\n`);
  process.exitCode = 1;
});
