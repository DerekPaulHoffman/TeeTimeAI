import { describe, expect, it } from "vitest";

import { validateCourseProfileDraft } from "@/lib/course-profiles/validation";

describe("course profile validation", () => {
  it("accepts original copy supported by an official source", () => {
    expect(validateCourseProfileDraft(validDraft())).toMatchObject({ valid: true, errors: [] });
  });

  it("requires two independent fallback publishers without official descriptive evidence", () => {
    const draft = validDraft();
    draft.sources = [
      { ...draft.sources[0], sourceType: "GOLF_ASSOCIATION", publisher: "Connecticut Golf Association" }
    ];
    expect(validateCourseProfileDraft(draft)).toMatchObject({ valid: false });
  });

  it("accepts two authoritative fallback publishers", () => {
    const draft = validDraft();
    draft.sources = [
      { ...draft.sources[0], sourceType: "GOLF_ASSOCIATION", publisher: "Connecticut Golf Association" },
      { ...draft.sources[0], url: "https://visit.example.gov/tashua", sourceType: "GOVERNMENT_TOURISM", publisher: "Visit Connecticut" }
    ];
    expect(validateCourseProfileDraft(draft)).toMatchObject({ valid: true });
  });

  it.each([
    ["an excluded review host", { sourceUrl: "https://www.yelp.com/biz/example" }],
    ["an unsupported superlative", { overview: "This is the best public golf course in Connecticut." }],
    ["missing claim evidence", { claimKeys: ["access", "course_type", "overview"] }]
  ])("rejects %s", (_label, change) => {
    const draft = validDraft();
    if (change.sourceUrl) draft.sources[0].url = change.sourceUrl;
    if (change.overview) draft.overview = change.overview;
    if (change.claimKeys) draft.sources[0].claimKeys = change.claimKeys;
    expect(validateCourseProfileDraft(draft).valid).toBe(false);
  });

  it("rejects long copied phrases from source evidence", () => {
    const draft = validDraft();
    draft.overview = "The property pairs a traditional municipal layout with wooded corridors and deliberate approaches that reward careful placement from tee to green.";
    draft.sources[0].evidenceSummary = draft.overview;
    expect(validateCourseProfileDraft(draft).errors).toContainEqual(
      expect.stringContaining("overlaps too closely")
    );
  });

  it("requires verification dates and a source matching the official website host", () => {
    const missingDate = validDraft();
    missingDate.profileVerifiedAt = "";
    expect(validateCourseProfileDraft(missingDate).valid).toBe(false);

    const mismatchedWebsite = { ...validDraft(), officialWebsiteUrl: "https://unverified.example.com/course" };
    expect(validateCourseProfileDraft(mismatchedWebsite).errors).toContainEqual(
      expect.stringContaining("officialWebsiteUrl must share a host")
    );
  });

  it("requires each notable fact to map to a source claim", () => {
    const draft = validDraft();
    draft.sources[0].claimKeys = draft.sources[0].claimKeys.filter(
      (claim) => claim !== "notable_fact_0"
    );
    expect(validateCourseProfileDraft(draft).errors).toContain(
      "At least one source must support the notable_fact_0 claim"
    );
  });
});

function validDraft() {
  return {
    courseId: "course-1",
    location: {
      city: "Trumbull",
      stateCode: "CT",
      stateName: "Connecticut",
      county: "Fairfield",
      countryCode: "US"
    },
    courseType: "MUNICIPAL" as const,
    accessSummary: "A public municipal course operated for residents and visiting golfers.",
    overview: "Tashua Knolls is a town-operated golf facility in Trumbull with an established eighteen-hole course and a shorter companion layout.",
    courseCharacter: "The property combines a full-length municipal round with a more compact option for golfers seeking a shorter outing.",
    notableFacts: ["The Town of Trumbull operates the golf facility."],
    profileVerifiedAt: "2026-07-15T12:00:00.000Z",
    sources: [
      {
        url: "https://www.trumbull-ct.gov/1020/Tashua-Knolls-Golf-Course",
        title: "Tashua Knolls Golf Course",
        publisher: "Town of Trumbull",
        sourceType: "MUNICIPAL_GOVERNMENT" as const,
        claimKeys: ["access", "course_type", "overview", "course_character", "notable_fact_0"],
        evidenceSummary: "The municipal page identifies the town golf facility and describes its two layouts.",
        accessedAt: "2026-07-15T12:00:00.000Z"
      }
    ]
  };
}
