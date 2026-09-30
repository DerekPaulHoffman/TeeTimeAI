import { parse, type DefaultTreeAdapterMap } from "parse5";

import {
  createAddressPinnedPublicFetchTransport,
  type AddressPinnedPublicFetchDependencies,
} from "@/lib/automation/address-pinned-public-fetch";
import { isKnownPublicSearchSurfaceUrl, isSafeManualEvidenceUrl } from "@/lib/automation/browser-discovery";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { recoveryInputSchema, type RecoveryInput, type RecoveryInvestigation } from "@/lib/course-recovery/contracts";
import {
  findCatalogueRecoveryPlaces,
  readRecoveryResponseText,
  RECOVERY_MAX_CANDIDATES,
  searchRecoveryCoursePlaces,
  withRecoveryAbort,
  type RecoveryPlace,
} from "@/lib/course-recovery/places";
import {
  getCourseDistanceMeters,
  haveCompatibleCourseNames,
  haveCompatibleOfficialPageCourseNames,
  haveSameOfficialCourseIdentityCore,
  haveStrongCourseIdentityLink,
  isExplicitCourseIdentityName,
  normalizeCourseIdentityName,
  normalizeOfficialPagePresentationIdentity,
} from "@/lib/places/course-identity";
import type { CourseCandidate } from "@/lib/places/google";
import {
  loadActiveGooglePlaceReviewIndex,
  type GooglePlaceReviewIndex,
} from "@/lib/places/google-place-reviews";
import { getTimeZoneForCoordinates } from "@/lib/timezones";

export const RECOVERY_INVESTIGATION_TIMEOUT_MS = 30_000;
export const RECOVERY_MAX_OFFICIAL_REQUESTS = 8;
const OFFICIAL_PAGE_TIMEOUT_MS = 5_000;
const MAX_OFFICIAL_PAGE_BYTES = 256_000;
const NON_COURSE_TYPES = new Set(["association_or_organization", "indoor_golf_course", "sporting_goods_store", "store", "gym"]);
const NON_COURSE_NAME = /\b(?:maintenance|operations|club\s*fitting|pro\s*shop|general\s+store|clubhouse|driving\s+range|golf\s+(?:academy|school|lessons?)|disc\s+golf|mini(?:ature)?\s+golf|golf\s+galaxy|pga\s+tour\s+superstore|simulator|indoor)\b/iu;
const PRIVATE_NAME = /\b(?:private|members?\s+only|membership\s+required)\b/iu;
const PRIVATE_LABEL = /^\s*private\s+golf\s+course\s*$/iu;
const PUBLIC_PAGE = /\b(?:public\s+(?:golf\s+)?(?:course|club|tee\s*times?)|open\s+to\s+(?:the\s+)?public|public\s+(?:is\s+)?welcome|daily[-\s]+fee\s+(?:golf\s+)?course|municipal\s+golf\s+course)\b/iu;
const PLAYABLE_PAGE = /\b(?:\d{1,2}[-\s]+hole\s+(?:golf\s+)?(?:course|layout)|golf\s+course|golf\s+links|fairways|greens)\b/iu;
const MANUAL_BOOKING_PAGE = /\b(?:no\s+(?:online\s+)?(?:booking|reservations?|tee\s*times?)\s+(?:is\s+|are\s+)?(?:available|accepted|required|needed)|(?:book|reserve|request)\s+(?:your\s+)?tee\s*times?\s+(?:only\s+)?by\s+phone|(?:phone|call)\s+(?:us\s+)?(?:only|to\s+(?:book|reserve))|walk[-\s]+ins?\s+(?:only|welcome)|first[-\s]+come[,\s-]+first[-\s]+served)\b/iu;
const BOOKING_LINK = /\b(?:tee\s*times?|online\s+booking|book\s+(?:a\s+|your\s+)?round)\b/iu;
const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".toLowerCase().split(" "));
const US_STATE_NAMES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado", ct: "Connecticut", de: "Delaware",
  fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois", in: "Indiana", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana",
  me: "Maine", md: "Maryland", ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi", mo: "Missouri", mt: "Montana",
  ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico", ny: "New York", nc: "North Carolina", nd: "North Dakota",
  oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania", ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee",
  tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming", dc: "District of Columbia",
};

export type RecoveryInvestigatorDependencies = {
  loadReviews?: () => Promise<GooglePlaceReviewIndex>;
  findCataloguePlaces?: (input: RecoveryInput) => Promise<RecoveryPlace[]>;
  searchPlaces?: (input: RecoveryInput, signal: AbortSignal) => Promise<RecoveryPlace[]>;
  officialFetch?: typeof fetch;
  publicFetchDependencies?: AddressPinnedPublicFetchDependencies;
  signal?: AbortSignal;
};

type PreparedPlace = RecoveryPlace & { reviewedPublic: boolean; rejected: boolean; requestedAliasName: string };
type OfficialPage = {
  url: string;
  identities: string[];
  structuredCourses: Array<{ name: string; town?: string; region?: string }>;
  addresses: string[];
  text: string;
  links: Array<{ url: string; label: string }>;
};

/** Reads identity and source evidence only; the caller owns all durable writes. */
export async function investigateCourseRecovery(
  rawInput: RecoveryInput,
  dependencies: RecoveryInvestigatorDependencies = {},
): Promise<RecoveryInvestigation> {
  const input = recoveryInputSchema.parse(rawInput);
  if (!normalizeCourseIdentityName(input.name)) {
    return needsDetails("What is the course's full name in that town?", "The supplied name does not distinguish a facility.");
  }
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(RECOVERY_INVESTIGATION_TIMEOUT_MS)])
    : AbortSignal.timeout(RECOVERY_INVESTIGATION_TIMEOUT_MS);
  const reviews = await withRecoveryAbort((dependencies.loadReviews ?? loadActiveGooglePlaceReviewIndex)(), signal);
  const catalogue = await withRecoveryAbort((dependencies.findCataloguePlaces ?? findCatalogueRecoveryPlaces)(input), signal);
  const reviewPlaces = findReviewedRecoveryPlaces(input, reviews);
  // Prefer already established identities, but still corroborate the current official source.
  let rawPlaces = [...catalogue, ...reviewPlaces];
  const localRelated = rawPlaces.some(place => place.candidate.website && namesMatch(input.name, place.candidate.name) && townMatch(input.town, place.candidate) === "MATCH");
  let searched = false;
  if (!localRelated) {
    const searched = await withRecoveryAbort(
      dependencies.searchPlaces ? dependencies.searchPlaces(input, signal) : searchRecoveryCoursePlaces(input, { signal }), signal,
    );
    rawPlaces = [...rawPlaces, ...searched];
    // The alternate helper itself is limited to two fixed text queries.
    // This stage must not be repeated by the local-source fallback below.
  }
  searched = !localRelated;
  const prepared = rawPlaces.map(place => applyRecoveryReviews(place, reviews));
  const requestedPlaces = prepared.filter(place => namesMatch(input.name, place.candidate.name) || namesMatch(input.name, place.requestedAliasName));
  const rejectedKeys = new Set(prepared.filter(place => place.rejected).map(place => place.candidate.googlePlaceId));
  const matchingRejected = requestedPlaces.find(place => (place.rejected || rejectedKeys.has(place.candidate.googlePlaceId)) && townMatch(input.town, place.candidate) === "MATCH");
  const relevant = requestedPlaces.filter(place => !place.rejected && !rejectedKeys.has(place.candidate.googlePlaceId) && townMatch(input.town, place.candidate) !== "MISMATCH" && matchesRecoveryHints(input, place.candidate));
  const candidates = dedupeRecoveryPlaces(relevant).slice(0, RECOVERY_MAX_CANDIDATES);
  if (candidates.length === 0) {
    if (matchingRejected) {
      return { status: "NOT_PUBLIC", reason: "The matching place is classified as private or not a playable public golf course.", evidenceSummary: "Current exact review or facility evidence rejects this identity." };
    }
    if ((input.address || input.officialWebsite) && requestedPlaces.length > 0) return unresolved("The supplied street address or official website does not match an independently found course identity.");
    const wrongTown = requestedPlaces.find(place => townMatch(input.town, place.candidate) === "MISMATCH");
    if (wrongTown?.candidate.city) {
      return needsDetails(`I found ${wrongTown.candidate.name} in ${wrongTown.candidate.city}. Is that the course you mean, or can you give its street address in ${input.town}?`, "The matching name has a different verified location.");
    }
    const sibling = prepared.find(place => !place.rejected && townMatch(input.town, place.candidate) === "MATCH" && haveCompatibleCourseNamesWithoutLayout(input.name, place.candidate.name));
    if (sibling) {
      return needsDetails(`I found ${sibling.candidate.name} in ${input.town}. Which course or layout do you mean?`, "The supplied identity does not match the facility's specific course or layout.");
    }
    return unresolved("We could not verify that course from the bounded evidence available. This does not mean it does not exist.");
  }

  let requestCount = 0;
  const transport = dependencies.officialFetch ?? createAddressPinnedPublicFetchTransport({
    parseUrl: parseRecoveryPublicUrl, maxResponseBytes: MAX_OFFICIAL_PAGE_BYTES,
    redirectLimit: 0, timeoutMs: OFFICIAL_PAGE_TIMEOUT_MS,
  }, dependencies.publicFetchDependencies);
  const officialFetch: typeof fetch = async (url, init) => {
    if (++requestCount > RECOVERY_MAX_OFFICIAL_REQUESTS) throw new RecoveryRequestLimitError("Course recovery official-source request limit reached");
    const parsed = parseRecoveryPublicUrl(String(url));
    if (dependencies.officialFetch) return withRecoveryAbort(transport(parsed, { ...init, signal, redirect: "manual" }), signal);
    const execution = await withRecoveryAbort(runWithProviderRequestLease(
      resolveProviderCapability({ detectedBookingUrl: parsed.toString() }).providerFamilyKey,
      async () => {
        signal.throwIfAborted();
        const response = await transport(parsed, { ...init, signal, redirect: "manual" });
        // Keep the global/family slot until the bounded body is fully consumed.
        const body = await readRecoveryResponseText(response, MAX_OFFICIAL_PAGE_BYTES, signal);
        const buffered = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
        Object.defineProperty(buffered, "url", { value: response.url || parsed.toString() });
        return buffered;
      },
    ), signal);
    if (!execution.acquired) throw new Error("Course recovery official-source read deferred by provider capacity");
    return execution.value;
  };
  const outcomes = new Map<string, RecoveryInvestigation>();
  for (const place of candidates) {
    if (requestCount >= RECOVERY_MAX_OFFICIAL_REQUESTS) break;
    const investigation = await inspectOfficialSource(input, place, officialFetch, signal, requestCount < RECOVERY_MAX_OFFICIAL_REQUESTS - 1);
    outcomes.set(place.candidate.googlePlaceId, investigation);
  }
  // Catalogue identity is reusable knowledge, but an obsolete website is not a
  // reason to permanently suppress the two bounded alternate queries.
  if (!searched && ![...outcomes.values()].some(result => result.status === "VERIFIED") && requestCount < RECOVERY_MAX_OFFICIAL_REQUESTS) {
    const alternate = await withRecoveryAbort(
      dependencies.searchPlaces ? dependencies.searchPlaces(input, signal) : searchRecoveryCoursePlaces(input, { signal }), signal,
    );
    const newPrepared = alternate.map(place => applyRecoveryReviews(place, reviews));
    for (const rejected of newPrepared.filter(place => place.rejected)) rejectedKeys.add(rejected.candidate.googlePlaceId);
    const existingKeys = new Set(candidates.map(place => place.candidate.googlePlaceId));
    for (const place of dedupeRecoveryPlaces(newPrepared)) {
      if (requestCount >= RECOVERY_MAX_OFFICIAL_REQUESTS) break;
      if (place.rejected || rejectedKeys.has(place.candidate.googlePlaceId) || !matchesRecoveryHints(input, place.candidate) ||
          (!namesMatch(input.name, place.candidate.name) && !namesMatch(input.name, place.requestedAliasName)) || townMatch(input.town, place.candidate) === "MISMATCH") continue;
      if (!existingKeys.has(place.candidate.googlePlaceId) && existingKeys.size >= RECOVERY_MAX_CANDIDATES) continue;
      const known = candidates.find(candidate => candidate.candidate.googlePlaceId === place.candidate.googlePlaceId);
      if (known?.candidate.website === place.candidate.website) continue;
      if (known?.candidate.courseId) place.candidate.courseId = known.candidate.courseId;
      existingKeys.add(place.candidate.googlePlaceId);
      outcomes.set(place.candidate.googlePlaceId, await inspectOfficialSource(input, place, officialFetch, signal, requestCount < RECOVERY_MAX_OFFICIAL_REQUESTS - 1));
    }
  }
  const verified = [...outcomes.values()].filter((result): result is Extract<RecoveryInvestigation, { status: "VERIFIED" }> => result.status === "VERIFIED");
  const uncertain = [...outcomes.values()].filter(result => result.status !== "VERIFIED");
  if (verified.length > 1) {
    const choices = verified.map(result => `${result.course.name} (${result.course.address ?? result.course.city ?? input.town})`).join(" or ");
    return needsDetails(`Which course do you mean: ${choices}?`, "More than one independently verified facility matches the supplied name and town.");
  }
  if (verified.length === 1) {
    // A second unresolved matching facility may still be the one the golfer meant.
    if (outcomes.size > 1 && uncertain.some(result => result.status !== "NOT_PUBLIC")) {
      return needsDetails(`Is ${verified[0].course.name} at ${verified[0].course.address ?? verified[0].course.city ?? input.town} the course you mean?`, "Another matching facility could not yet be distinguished from the verified result.");
    }
    return verified[0];
  }
  return uncertain.find(result => result.status === "NEEDS_DETAILS") ??
    uncertain.find(result => result.status === "ACCESS_LIMITED") ??
    (uncertain.length > 0 && uncertain.every(result => result.status === "NOT_PUBLIC") ? uncertain[0] : uncertain.find(result => result.status === "UNRESOLVED") ?? unresolved("The matching place has no verified official public-course and booking source yet."));
}

async function inspectOfficialSource(
  input: RecoveryInput, place: PreparedPlace, fetchImpl: typeof fetch, signal: AbortSignal, allowFollowup: boolean,
): Promise<RecoveryInvestigation> {
  const website = place.candidate.website;
  if (!website) return unresolved("The matching place has no established official website yet.");
  let page: OfficialPage | RecoveryInvestigation;
  try {
    page = await readOfficialPage(website, fetchImpl, signal);
  } catch (error) {
    if (error instanceof RecoveryRequestLimitError) return unresolved("The bounded official-source read budget was exhausted.");
    if (error instanceof UnsafeRecoveryUrlError || (error instanceof Error && error.message === "Official site resolved to a non-public network address")) {
      return unresolved("The supplied source is not a safe public official website.");
    }
    throw error;
  }
  if (!("identities" in page)) return page;
  const source = page;
  if (!source.identities.some(identity => namesMatch(place.candidate.name, identity))) {
    const otherIdentity = source.identities.find(isExplicitCourseIdentityName);
    return otherIdentity
      ? needsDetails(`The listed website identifies ${otherIdentity}. Can you provide the official website or street address for ${input.name} in ${input.town}?`, "The candidate and its official-page identity disagree.", source.url)
      : unresolved("The listed website does not corroborate the specific course identity.", source.url);
  }
  const matchingStructured = source.structuredCourses.filter(course => namesMatch(place.candidate.name, course.name));
  const conflictingCourse = source.identities.find(identity => isExplicitCourseIdentityName(identity) && !namesMatch(place.candidate.name, identity));
  if (conflictingCourse) return needsDetails(`The official page also identifies ${conflictingCourse}. Which course or layout at this facility do you mean?`, "The official source includes a conflicting course identity.", source.url);
  const conflictingTown = matchingStructured.find(course => course.town && townMatch(input.town, { city: course.town, stateCode: course.region, stateName: course.region }) === "MISMATCH");
  if (conflictingTown) return needsDetails(`The official page places ${place.candidate.name} in ${conflictingTown.town}. Is that the course you mean, or can you give its street address in ${input.town}?`, "The provider location and current official source disagree.", source.url);
  if (source.addresses.some(address => townMatch(input.town, { address, stateCode: getAddressRegion(address) }) === "MISMATCH")) return needsDetails(`The official page lists a different course location. Can you give the street address for ${input.name} in ${input.town}?`, "The provider town and current official course address disagree.", source.url);
  let confirmedTown = officialPageCorroboratesTown(input, place.candidate, source);

  let evidenceText = source.text;
  let links = source.links;
  const hasPlayableIdentity = () => matchingStructured.length > 0 || place.types?.includes("golf_course") || PLAYABLE_PAGE.test(evidenceText);
  const bookingLink = () => links.find(link => isBookingLink(link, place.candidate.name));
  if (allowFollowup && !hasPrivateFacilityEvidence(evidenceText, place.candidate.name) && (!confirmedTown || !PUBLIC_PAGE.test(evidenceText) || (!bookingLink() && !MANUAL_BOOKING_PAGE.test(evidenceText)))) {
    const followup = source.links.find(link => new URL(link.url).origin === new URL(source.url).origin &&
      /\b(?:contact|about|course|golf|tee\s*times?)\b/iu.test(link.label) && !isBookingLink(link, place.candidate.name));
    if (followup && followup.url !== source.url) {
      const extra = await readOfficialPage(followup.url, fetchImpl, signal);
      if ("identities" in extra) {
        const conflicting = extra.identities.some(identity => isExplicitCourseIdentityName(identity) && !namesMatch(place.candidate.name, identity));
        if (!conflicting) {
          const townConflict = extra.structuredCourses.some(course => namesMatch(place.candidate.name, course.name) && course.town && townMatch(input.town, { city: course.town, stateCode: course.region, stateName: course.region }) === "MISMATCH") ||
            extra.addresses.some(address => townMatch(input.town, { address, stateCode: getAddressRegion(address) }) === "MISMATCH");
          if (townConflict) return needsDetails(`The official contact page lists a different course location. Can you give the street address for ${input.name} in ${input.town}?`, "The official course and contact sources disagree about location.", extra.url);
          evidenceText += ` ${extra.text}`; links = [...links, ...extra.links];
          confirmedTown ||= officialPageCorroboratesTown(input, place.candidate, extra);
        }
      }
    }
  }
  if (hasPrivateFacilityEvidence(evidenceText, place.candidate.name) || NON_COURSE_NAME.test(source.identities.join(" "))) {
    return { status: "NOT_PUBLIC", reason: "The official source identifies a private or non-course facility.", evidenceUrl: source.url, evidenceSummary: "Current official facility evidence rejects public playable-course access." };
  }
  if (!confirmedTown) return unresolved("The course's town has not been corroborated by its official source. Nearby coordinates or provider location alone cannot establish its location.", source.url);
  if (!hasPlayableIdentity() || (!place.reviewedPublic && !PUBLIC_PAGE.test(evidenceText))) {
    return unresolved("The official source does not yet establish a playable course open to the public.", source.url);
  }
  const booking = bookingLink();
  const manualBooking = MANUAL_BOOKING_PAGE.test(evidenceText);
  if (!booking && !manualBooking) return unresolved("The official public course was identified, but its booking or contact method is not yet established.", source.url);
  return {
    status: "VERIFIED",
    course: {
      ...place.candidate,
      website: source.url,
      publicAccessStatus: "PUBLIC",
      monitoringReadiness: "VERIFYING",
      monitoringSupport: booking ? "UNCONFIRMED" : "MANUAL_ONLY",
    },
    bookingUrl: booking?.url ?? null,
    evidenceUrl: source.url,
    evidenceSummary: booking
      ? "The matching course identity and town are corroborated; the official public-course page links to its tee-time booking source. Availability monitoring remains unverified."
      : "The matching course identity and town are corroborated; the official public-course source explicitly describes phone, walk-in, or no-online-booking access. Availability monitoring remains unverified.",
  };
}

async function readOfficialPage(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OfficialPage | RecoveryInvestigation> {
  const source = parseRecoveryPublicUrl(url);
  let current = source;
  let response: Response;
  for (let redirect = 0; ; redirect += 1) {
    response = await fetchImpl(current, { method: "GET", headers: { Accept: "text/html" }, credentials: "omit", redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirect >= 2) return unresolved("The official source exceeded the bounded redirect allowance.", source.toString());
    const next = parseRecoveryPublicUrl(new URL(location, current).toString());
    if (next.hostname.replace(/^www\./u, "") !== source.hostname.replace(/^www\./u, "")) return unresolved("The listed official source redirected to a different website and could not be corroborated.", source.toString());
    current = next;
  }
  const finalUrl = parseRecoveryPublicUrl(response.url || current.toString());
  if (finalUrl.hostname.replace(/^www\./u, "") !== source.hostname.replace(/^www\./u, "")) {
    await response.body?.cancel().catch(() => undefined);
    return unresolved("The listed official source redirected to a different website and could not be corroborated.", source.toString());
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Course recovery official source temporarily failed (${response.status})`);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "ACCESS_LIMITED", reason: `The listed official course source currently denies signed-out access (HTTP ${response.status}).`, evidenceUrl: finalUrl.toString(), evidenceSummary: "A current public read returned an authentication or access-denial boundary; no bypass was attempted." };
  }
  if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)\b/iu.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => undefined);
    return unresolved("The official source did not return a readable course page.", finalUrl.toString());
  }
  const html = await readRecoveryResponseText(response, MAX_OFFICIAL_PAGE_BYTES, signal);
  const page = parseOfficialPage(html, finalUrl.toString());
  if (page.identities.some(identity => /^(?:just a moment|verify (?:you are|you're) human|access denied|waiting room|sign in|log in)$/iu.test(identity)) &&
      /(?:cf-chl|challenge-platform|captcha|verify.{0,20}human|waiting room|sign in|log in)/iu.test(html)) {
    return { status: "ACCESS_LIMITED", reason: "The listed official course source currently shows a verification, waiting-room, or sign-in screen.", evidenceUrl: page.url, evidenceSummary: "Current returned page markup shows an access boundary; no bypass or sign-in was attempted." };
  }
  return page;
}

function applyRecoveryReviews(place: RecoveryPlace, reviews: GooglePlaceReviewIndex): PreparedPlace {
  const exact = reviews.byPlaceId.get(place.candidate.googlePlaceId);
  const canonical = exact?.canonicalPlaceId ? reviews.byPlaceId.get(exact.canonicalPlaceId) : undefined;
  const rejectedReview = [exact, canonical].some(review => review?.accessOverride === "VERIFIED_PRIVATE" || review?.accessOverride === "VERIFIED_NON_COURSE");
  const override = exact;
  const candidate: CourseCandidate = {
    ...place.candidate,
    ...(override?.canonicalPlaceId ? { googlePlaceId: override.canonicalPlaceId } : {}),
    ...(override?.canonicalName ? { name: override.canonicalName } : {}),
    ...(override?.canonicalAddress ? { address: override.canonicalAddress, city: getAddressTown(override.canonicalAddress), stateCode: getAddressRegion(override.canonicalAddress), stateName: US_STATE_NAMES[getAddressRegion(override.canonicalAddress) ?? ""] } : {}),
    ...(override?.canonicalWebsiteUrl ? { website: override.canonicalWebsiteUrl } : {}),
    ...(override?.canonicalPhone ? { phone: override.canonicalPhone } : {}),
    ...(override?.latitude !== null && override?.latitude !== undefined && override.longitude !== null ? {
      latitude: override.latitude, longitude: override.longitude,
      timeZone: getTimeZoneForCoordinates(override.latitude, override.longitude),
    } : {}),
  };
  return {
    ...place, candidate,
    requestedAliasName: place.candidate.name,
    reviewedPublic: [exact, canonical].some(review => review?.accessOverride === "VERIFIED_PUBLIC"),
    rejected: rejectedReview || place.isPublic === false || PRIVATE_NAME.test(candidate.name) || NON_COURSE_NAME.test(candidate.name) ||
      PRIVATE_LABEL.test(place.typeLabel ?? "") || Boolean(place.primaryType && NON_COURSE_TYPES.has(place.primaryType)) ||
      Boolean(place.businessStatus && place.businessStatus !== "OPERATIONAL"),
  };
}

function findReviewedRecoveryPlaces(input: RecoveryInput, reviews: GooglePlaceReviewIndex): RecoveryPlace[] {
  return reviews.verifiedPublicCourses.flatMap(review => {
    const name = review.canonicalName ?? review.name;
    if (!namesMatch(input.name, name) || review.latitude === null || review.longitude === null) return [];
    return [{
      source: "REVIEW" as const,
      candidate: {
        googlePlaceId: review.googlePlaceId, name,
        address: review.canonicalAddress ?? undefined, city: getAddressTown(review.canonicalAddress),
        stateCode: review.canonicalAddress ? getAddressRegion(review.canonicalAddress) : undefined,
        stateName: review.canonicalAddress ? US_STATE_NAMES[getAddressRegion(review.canonicalAddress) ?? ""] : undefined,
        latitude: review.latitude, longitude: review.longitude,
        timeZone: getTimeZoneForCoordinates(review.latitude, review.longitude),
        // An access-review evidence article is not automatically the official site.
        website: review.canonicalWebsiteUrl ?? undefined,
        publicAccessStatus: "UNVERIFIED" as const,
      },
    }];
  }).slice(0, RECOVERY_MAX_CANDIDATES);
}

function dedupeRecoveryPlaces(places: PreparedPlace[]) {
  const unique: PreparedPlace[] = [];
  for (const place of places) {
    const same = unique.find(other => other.candidate.googlePlaceId === place.candidate.googlePlaceId ||
      (namesMatch(other.candidate.name, place.candidate.name) && getCourseDistanceMeters(other.candidate, place.candidate) <= 175 && haveStrongCourseIdentityLink(other.candidate, place.candidate)));
    if (!same) unique.push(place);
  }
  return unique;
}

function namesMatch(left: string, right: string) {
  return haveCompatibleOfficialPageCourseNames(left, right) || haveSameOfficialCourseIdentityCore(left, right);
}

function matchesRecoveryHints(input: RecoveryInput, candidate: CourseCandidate) {
  if (input.address) {
    const hint = normalizeLocation(input.address);
    const address = normalizeLocation(candidate.address ?? "");
    const street = normalizeLocation(candidate.address?.split(",")[0] ?? "");
    if (!address || (hint !== address && hint !== street)) return false;
  }
  if (input.officialWebsite) {
    try {
      const known = parseRecoveryPublicUrl(candidate.website ?? "");
      const hinted = parseRecoveryPublicUrl(input.officialWebsite);
      if (known.hostname.replace(/^www\./u, "") !== hinted.hostname.replace(/^www\./u, "")) return false;
    } catch { return false; }
  }
  return true;
}

function officialPageCorroboratesTown(input: RecoveryInput, candidate: CourseCandidate, page: OfficialPage) {
  if (page.structuredCourses.some(course => namesMatch(candidate.name, course.name) && course.town && townMatch(input.town, { city: course.town, stateCode: course.region, stateName: course.region }) === "MATCH")) return true;
  if (page.addresses.some(address => townMatch(input.town, { address, city: getAddressTown(address), stateCode: getAddressRegion(address) }) === "MATCH")) return true;
  const city = candidate.city ?? getAddressTown(candidate.address);
  if (!city || townMatch(input.town, candidate) !== "MATCH") return false;
  const normalizedText = normalizeLocation(page.text);
  const escapedCity = escapeRegExp(normalizeLocation(city));
  // A facility-location assertion, not an incidental nearby-town mention.
  const requested = normalizeLocation(input.town);
  const expectsRegion = US_STATES.has(requested.split(" ").at(-1) ?? "") || Object.values(US_STATE_NAMES).some(stateName => requested.endsWith(` ${normalizeLocation(stateName)}`)) || Boolean(candidate.stateName && requested.endsWith(` ${normalizeLocation(candidate.stateName)}`));
  const regions = [candidate.stateCode, candidate.stateName, US_STATE_NAMES[normalizeLocation(candidate.stateCode ?? "")]].filter((value): value is string => Boolean(value)).map(value => escapeRegExp(normalizeLocation(value)));
  const regionPattern = expectsRegion ? ` (?:${regions.join("|") || "never-match-region"})` : "";
  return new RegExp(`\\b(?:located|situated|golf course|public course) (?:in|at) ${escapedCity}${regionPattern}(?:\\b|$)`, "u").test(normalizedText);
}

function hasPrivateFacilityEvidence(text: string, name: string) {
  const target = `(?:${escapeRegExp(name)}|${escapeRegExp(normalizeCourseIdentityName(name))})`;
  return new RegExp(`\\b(?:we are|this(?: golf)? (?:course|club) is|our (?:course|club) is|${target} is) (?:a )?private(?: golf)? (?:course|club)\\b`, "iu").test(text) ||
    /\b(?:private\s+golf\s+(?:course|club)[,.]?\s+(?:open|available)\s+(?:only|exclusively)\s+to\s+members|(?:this|our|the)\s+(?:golf\s+)?(?:course|club)\s+(?:is\s+)?(?:members?[-\s]+only|open\s+(?:only|exclusively)\s+to\s+members))\b/iu.test(text);
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

function haveCompatibleCourseNamesWithoutLayout(left: string, right: string) {
  const removeLayout = (value: string) => value.replace(/\b(?:black|blue|east|green|north|red|south|west|yellow|\d+)\b/giu, " ");
  return haveCompatibleCourseNames(removeLayout(left), removeLayout(right));
}

function townMatch(town: string, candidate: Pick<CourseCandidate, "city" | "stateCode" | "stateName" | "address">): "MATCH" | "MISMATCH" | "UNKNOWN" {
  const requested = normalizeLocation(town);
  if (/^\d{5}(?: \d{4})?$/u.test(requested)) {
    return new RegExp(`(?:^|\\s)${requested.replace(/ /gu, "[- ]?")}(?:$|\\s)`, "u").test(normalizeLocation(candidate.address ?? "")) ? "MATCH" : "UNKNOWN";
  }
  let requestedCity = requested;
  let requestedState = "";
  const parts = requested.split(" ");
  if (US_STATES.has(parts.at(-1) ?? "")) { requestedState = parts.pop()!; requestedCity = parts.join(" "); }
  else if (Object.values(US_STATE_NAMES).some(stateName => requested.endsWith(` ${normalizeLocation(stateName)}`))) {
    requestedState = normalizeLocation(Object.values(US_STATE_NAMES).find(stateName => requested.endsWith(` ${normalizeLocation(stateName)}`))!);
    requestedCity = requested.slice(0, -(requestedState.length + 1));
  }
  else if (candidate.stateName && requested.endsWith(` ${normalizeLocation(candidate.stateName)}`)) {
    requestedState = normalizeLocation(candidate.stateName);
    requestedCity = requested.slice(0, -(requestedState.length + 1));
  }
  const city = normalizeLocation(candidate.city ?? getAddressTown(candidate.address) ?? "");
  if (!city) return "UNKNOWN";
  if (city !== requestedCity) return "MISMATCH";
  const stateCode = normalizeLocation(candidate.stateCode ?? candidate.stateName ?? "");
  const stateName = US_STATE_NAMES[stateCode];
  const requestedCode = Object.entries(US_STATE_NAMES).find(([, name]) => normalizeLocation(name) === requestedState)?.[0] ?? requestedState;
  if (requestedState && ![candidate.stateCode, candidate.stateName, stateName, ...(candidate.address?.split(",") ?? [])]
    .some(value => value && (normalizeLocation(value) === requestedState || normalizeLocation(value).split(" ").includes(requestedCode)))) {
    if (!candidate.stateCode && !candidate.stateName) return "UNKNOWN";
    return "MISMATCH";
  }
  return "MATCH";
}

function normalizeLocation(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ").replace(/^(?:city|town) of /u, "");
}

function getAddressTown(address?: string | null) {
  const parts = address?.split(",").map(part => part.trim());
  if (!parts || parts.length < 3) return undefined;
  const regionIndex = parts.findIndex((part, index) => index > 0 && US_STATES.has(normalizeLocation(part).split(" ")[0]));
  return (regionIndex > 0 ? parts[regionIndex - 1] : parts.at(-2))?.replace(/\s+\d{5}(?:-\d{4})?$/u, "");
}

function getAddressRegion(address: string) {
  return address.split(",").map(part => normalizeLocation(part).split(" ")[0]).find(part => US_STATES.has(part));
}

function isBookingLink(link: { url: string; label: string }, courseName: string) {
  if (!BOOKING_LINK.test(link.label) && !(/\bbook\s+now\b/iu.test(link.label) && /tee[-_]?times?/iu.test(new URL(link.url).pathname))) return false;
  const identity = normalizeOfficialPagePresentationIdentity(link.label);
  const courseTokens = normalizeCourseIdentityName(courseName).split(" ");
  const linkTokens = normalizeCourseIdentityName(identity).split(" ").filter(token => token && !["book", "now", "online", "booking", "reserve", "view", "tee", "time", "times", "a", "your", "round"].includes(token));
  return linkTokens.length === 0 || (linkTokens.every(token => courseTokens.includes(token)) && courseTokens.every(token => linkTokens.includes(token)));
}

function parseOfficialPage(html: string, url: string): OfficialPage {
  const document = parse(html);
  const identities: string[] = [];
  const text: string[] = [];
  const links: OfficialPage["links"] = [];
  const structuredCourses: OfficialPage["structuredCourses"] = [];
  const addresses: string[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
      if (["title", "h1"].includes(node.tagName)) {
        identities.push(...textContent(node).split(/\s+[|–—]\s+/u).map(value => normalizeOfficialPagePresentationIdentity(value)).filter(Boolean));
      }
      if (node.tagName === "address" && addresses.length < 8) addresses.push(textContent(node));
      if (node.tagName === "a" && attrs.get("href") && links.length < 40) {
        try { links.push({ url: parseRecoveryPublicUrl(new URL(attrs.get("href")!, url).toString()).toString(), label: textContent(node).slice(0, 250) }); } catch { /* Unsafe and transaction links are not sources. */ }
      }
      if (node.tagName === "script" && attrs.get("type")?.toLowerCase() === "application/ld+json") {
        try { readStructuredCourses(JSON.parse(textContent(node)), structuredCourses); } catch { /* Invalid structured data is not evidence. */ }
      }
      if (["script", "style", "noscript", "template"].includes(node.tagName) || attrs.has("hidden") || attrs.get("aria-hidden") === "true") return;
    }
    if (node.nodeName === "#text" && "value" in node) text.push(node.value);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  identities.push(...structuredCourses.map(course => course.name));
  return { url, identities: identities.slice(0, 20), text: text.join(" ").replace(/\s+/gu, " ").slice(0, MAX_OFFICIAL_PAGE_BYTES), links, structuredCourses, addresses };
}

function textContent(node: DefaultTreeAdapterMap["node"]): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join(" ").trim() : "";
}

function readStructuredCourses(value: unknown, courses: OfficialPage["structuredCourses"], depth = 0) {
  if (depth > 5 || courses.length >= 8) return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 20)) readStructuredCourses(item, courses, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
  if (types.includes("GolfCourse") && typeof record.name === "string" && record.name.length <= 250) {
    const address = record.address && typeof record.address === "object" ? record.address as Record<string, unknown> : {};
    courses.push({ name: record.name, ...(typeof address.addressLocality === "string" ? { town: address.addressLocality } : {}), ...(typeof address.addressRegion === "string" ? { region: address.addressRegion } : {}) });
  }
  if (record["@graph"]) readStructuredCourses(record["@graph"], courses, depth + 1);
}

class UnsafeRecoveryUrlError extends Error {}
class RecoveryRequestLimitError extends Error {}

function parseRecoveryPublicUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new UnsafeRecoveryUrlError("Course recovery source URL is invalid"); }
  if (!isSafeManualEvidenceUrl(url) || isKnownPublicSearchSurfaceUrl(url) || /(?:^|\.)(?:yelp\.com|tripadvisor\.com|facebook\.com|instagram\.com)$/iu.test(url.hostname)) {
    throw new UnsafeRecoveryUrlError("Course recovery source is not a safe public official URL");
  }
  url.hash = "";
  return url;
}

function unresolved(summary: string, evidenceUrl?: string): RecoveryInvestigation {
  return { status: "UNRESOLVED", reason: "We have not verified that course yet.", ...(evidenceUrl ? { evidenceUrl } : {}), evidenceSummary: summary };
}

function needsDetails(question: string, summary: string, evidenceUrl?: string): RecoveryInvestigation {
  return { status: "NEEDS_DETAILS", reason: question.slice(0, 500), ...(evidenceUrl ? { evidenceUrl } : {}), evidenceSummary: summary };
}
