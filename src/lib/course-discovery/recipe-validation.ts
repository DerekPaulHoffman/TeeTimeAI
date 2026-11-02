import { z } from "zod";
import { parseAccessRecipe, SERVER_DOCUMENT_SELECTOR_MESSAGE } from "./recipe";

/** Pure, bounded feedback shared by the standalone validator and legacy CLI. */
export function validateRecipeDocument(source: string) {
    const knownPaths = new Set("schemaVersion target courseId offeringId kind source officialUrl bookingUrl venueName venueAddress providerFamily timeZone engine browserTransport pageUrl availabilityResponse serverDocument endDatePath success equals permittedRoutes origin path methods queryKeys steps action selector monthYearSelector nextSelector previousSelector daySelector productSelector text purpose value proof venue date monthYear day complete empty players durationMinutes slots scope label expectedLabel collection startsAt endsAt derive availableSpots minimumPlayers capacity holes resourceId productId request url method body adapter family facilityId facilityIds alias scheduleId bookingClassId ownerKey businessId rentalProductIds tenant serviceId serviceName clubSlug facilitySlug clubId courseBuckets courseIds name companyId services locationIds durations minutes variationId id requestBinding metadataRequest responseRows dateKey rowsPath typePath excludeType availableTypes accessIdPath labelPath expectedRentalLabel expectedRentalLabels startsAtPath durationMinutesPath publicVenueMetadata availabilityDateKey".split(" "));
    const safeMessages = new Set([SERVER_DOCUMENT_SELECTOR_MESSAGE, "Expected a bounded public display selector", "Unknown or malformed template parameter", "Field readers must match the engine", "Outdoor recipes require available-player evidence", "Simulator recipes require offering, duration and end-time proof", "Simulator player count is saved context and cannot parameterize availability", "Simulator availability may request only one bay; saved players are context"]);
    try {
      const value = JSON.parse(source) as { recipe: unknown };
      parseAccessRecipe(value.recipe);
      return { valid: true as const };
    } catch (error) {
      const issues = error instanceof z.ZodError ? error.issues.slice(0, 16).map(issue => ({
        path: issue.path.slice(0, 8).map(part => typeof part === "number" && part >= 0 && part < 1000 ? String(part) : knownPaths.has(String(part)) ? String(part) : "field").join("."),
        code: issue.code,
        message: safeMessages.has(issue.message) ? issue.message : "Recipe field does not match the required schema.",
      })) : [{ path: "recipe", code: "invalid_json", message: "Recipe must be a JSON object." }];
      return { valid: false as const, issues };
    }
}
