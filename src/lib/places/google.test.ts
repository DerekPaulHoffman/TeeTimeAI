import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dedupeGolfCoursePlaces,
  filterPublicGolfCoursePlaces as filterPublicGolfCoursePlacesWithReviews,
  getGooglePlacePhoto,
  getGooglePlacesApiKey,
  mapGooglePlaceToCourseCandidate as mapGooglePlaceToCourseCandidateWithReviews,
  searchGolfCoursesByName as searchGolfCoursesByNameWithReviews,
  searchNearbyGolfCourses as searchNearbyGolfCoursesWithReviews,
  type GooglePlace
} from "./google";
import {
  buildGooglePlaceReviewIndex,
  type GooglePlaceReviewRecord
} from "./google-place-reviews";

const TEST_REVIEW_INDEX = buildGooglePlaceReviewIndex([
  testReview({
    googlePlaceId: "ChIJHRdhRQt16IkRnZxbawELtdM",
    name: "Grassy Hill Country Club",
    accessOverride: "VERIFIED_PUBLIC",
    latitude: 41.2675142,
    longitude: -73.044987
  }),
  ...[
    ["ChIJUTDSFL-w5IkRtjT_2vg_TJM", "Old Sandwich Golf Club"],
    ["ChIJa0Z9c_5QwokR83AzfcoIODI", "Liberty National Golf Club"],
    ["ChIJ7cBXOMNRwokREKeDC0xNIrY", "Bayonne Golf Club"],
    ["ChIJwYHDYQ5VwokRfkjeAFO-rcY", "Forest Hill Field Club"],
    ["ChIJmYaOBZeqw4kR8uLQ3-n-ies", "Montclair Golf Club"],
    ["ChIJMXRRcFvo5YkRkNXOrqSfVGM", "Shelter Harbor Golf Club"],
    ["ChIJyaYoSGzg54kRN_2lDR8PO_g", "Highland Golf Club"],
    ["ChIJy0obgpGr2YgR3puygnLMK5M", "Shell Bay Club"],
    ["ChIJ0fUoNOn24YkRd7n-n1PQsls", "Baker Hill Golf Club"],
    ["ChIJ-5eDKiZ64YkROEiuRnTjEKw", "Dublin Lake Club Golf Course"],
    ["ChIJXdJQJmTpwIcRsoa_jpffsqs", "18th Hole - Hallbrook CC"],
    ["ChIJtVWUTNtX0VQR4I_SquYKOr4", "Baywood Golf & Country Club"]
  ].map(([googlePlaceId, name]) =>
    testReview({
      googlePlaceId,
      name,
      accessOverride: "VERIFIED_PRIVATE",
      classification: "PRIVATE_MEMBER_CONTROLLED"
    })
  ),
  ...[
    ["ChIJaWYTRqBbwokRONcYEIxCk1k", "NEXUS Golf Club", "INDOOR_SIMULATOR"],
    [
      "ChIJV_YX1RG11okRxSmNMNmBRrY",
      "The Harmony Golf Club",
      "INDOOR_SIMULATOR"
    ],
    ["ChIJ7dQcqrv5wokRIats-Rg1dZo", "BackyardSwingsStudio", "NON_COURSE_BUSINESS"],
    ["ChIJdZB9I4hhwokRFfvXRLrWvi8", "Q5C9+8VQ New York", "NON_COURSE_BUSINESS"],
    ["ChIJy4_CTDEtDogR9wxAr-a-VGI", "Chicago Golf Authority", "INDOOR_SIMULATOR"],
    ["ChIJ67JAVPK12YgRnl_JdjR_gFs", "Green Girls Golf", "SERVICE_OR_MEDIA"],
    ["ChIJ6xdB1Jq02YgR4mExla8UqpE", "South Florida Golf Magazine", "SERVICE_OR_MEDIA"],
    ["ChIJQfF9gY612YgRgEZ2p_DUI0M", "Celebrity Amputee Golf Classic", "EVENT_ORGANIZATION"],
    ["ChIJ9zQbdAC72YgRyrZQ5alj1h4", "PGA TOUR Deliveries", "RETAIL_OR_DELIVERY"],
    ["ChIJbV3-V-av2YgRGc2i3GxAjEY", "Golf Miami 305", "INDOOR_SIMULATOR"],
    ["ChIJw4LoQ3TL4YkR--PVXKkrk7I", "The Barn At Fox Run", "NON_COURSE_VENUE"],
    ["ChIJu4ODUC01oFQRrHyJkM_URz4", "PARTEE GOLF AND GAMES, LLC", "INDOOR_SIMULATOR"],
    ["ChIJa52pBnx754gRry26du_jGzo", "BagBoyz2", "NON_COURSE_USER_PLACE"],
    [
      "ChIJOQuc9RPtMIgR33aMCl2HdBA",
      "Big Met Golf Course Parking",
      "NON_COURSE_PARKING"
    ]
  ].map(([googlePlaceId, name, classification]) =>
    testReview({
      googlePlaceId,
      name,
      accessOverride: "VERIFIED_NON_COURSE",
      classification
    })
  ),
  ...courseIdentityReviews({
    canonicalPlaceId: "ChIJL7Z5avQFK4cRO4PIpaKi9iA",
    placeIds: [
      "ChIJL7Z5avQFK4cRO4PIpaKi9iA",
      "ChIJAQAAgewFK4cRxjiU-zozIzs",
      "ChIJ____iusFK4cReVCFj6EmIBQ"
    ],
    name: "Arizona Grand Golf Course",
    address: "8000 S Arizona Grand Pkwy, Phoenix, AZ 85044, USA",
    websiteUrl: "https://www.arizonagrandgolf.com/"
  }),
  ...courseIdentityReviews({
    canonicalPlaceId: "ChIJq6qqPcgFK4cRuYv0flb88dY",
    placeIds: [
      "ChIJq6qqPcgFK4cRuYv0flb88dY",
      "ChIJ____G7MFK4cRf2hkJjIoEWo",
      "ChIJq6qqv7QFK4cRZNsSs47toA8"
    ],
    name: "Ahwatukee Golf Club",
    address: "12432 S 48th St, Phoenix, AZ 85044, USA",
    websiteUrl: "https://www.ahwatukeegolf.com/",
    phone: "(480) 893-1161"
  }),
  testReview({
    googlePlaceId: "ChIJj1vnKctZ4IkRr5BY1-F-5AE",
    name: "Stratton Golf Course",
    canonicalPlaceId: "ChIJvbRuDR9Y4IkRe4pD0YaU5fQ"
  }),
  testReview({
    googlePlaceId: "inactive-private-review",
    name: "Inactive Private Review",
    accessOverride: "VERIFIED_PRIVATE",
    active: false
  })
]);

function filterPublicGolfCoursePlaces(
  places: Parameters<typeof filterPublicGolfCoursePlacesWithReviews>[0],
  options: NonNullable<Parameters<typeof filterPublicGolfCoursePlacesWithReviews>[1]> = {}
) {
  return filterPublicGolfCoursePlacesWithReviews(places, {
    ...options,
    reviewIndex: TEST_REVIEW_INDEX
  });
}

function mapGooglePlaceToCourseCandidate(place: GooglePlace) {
  return mapGooglePlaceToCourseCandidateWithReviews(place, TEST_REVIEW_INDEX);
}

function searchGolfCoursesByName(
  input: Parameters<typeof searchGolfCoursesByNameWithReviews>[0]
) {
  return searchGolfCoursesByNameWithReviews(input, TEST_REVIEW_INDEX);
}

function searchNearbyGolfCourses(
  input: Parameters<typeof searchNearbyGolfCoursesWithReviews>[0]
) {
  return searchNearbyGolfCoursesWithReviews(input, TEST_REVIEW_INDEX);
}

function testReview(
  overrides: Pick<GooglePlaceReviewRecord, "googlePlaceId" | "name"> &
    Partial<GooglePlaceReviewRecord>
): GooglePlaceReviewRecord {
  return {
    googlePlaceId: overrides.googlePlaceId,
    accessOverride: null,
    name: overrides.name,
    classification: "COURSE_REVIEW",
    evidenceUrl: "https://example.com/google-place-review",
    reviewedAt: new Date("2026-07-14T00:00:00.000Z"),
    active: true,
    canonicalPlaceId: null,
    canonicalName: null,
    canonicalAddress: null,
    canonicalWebsiteUrl: null,
    canonicalPhone: null,
    latitude: null,
    longitude: null,
    retainWhenCanonicalAbsent: false,
    ...overrides
  };
}

function courseIdentityReviews({
  canonicalPlaceId,
  placeIds,
  name,
  address,
  websiteUrl,
  phone = null
}: {
  canonicalPlaceId: string;
  placeIds: readonly [string, string, string];
  name: string;
  address: string;
  websiteUrl: string;
  phone?: string | null;
}) {
  return placeIds.map((googlePlaceId, index) =>
    testReview({
      googlePlaceId,
      name,
      canonicalPlaceId,
      canonicalName: name,
      canonicalAddress: address,
      canonicalWebsiteUrl: websiteUrl,
      canonicalPhone: phone,
      retainWhenCanonicalAbsent: index > 0
    })
  );
}

function makeOperationalGolfCoursePlace({
  id,
  name,
  address,
  latitude,
  longitude,
  websiteUri
}: {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  websiteUri?: string;
}): GooglePlace {
  return {
    id: `places/${id}`,
    displayName: { text: name },
    formattedAddress: address,
    primaryType: "golf_course",
    types: ["golf_course"],
    businessStatus: "OPERATIONAL",
    websiteUri,
    location: { latitude, longitude }
  };
}

describe("Google Places mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it("maps only the fields needed for course discovery", () => {
    const course = mapGooglePlaceToCourseCandidate({
      id: "places/abc123",
      displayName: { text: "Tashua Knolls Golf Course" },
      formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
      addressComponents: [
        { longText: "Trumbull", shortText: "Trumbull", types: ["locality"] },
        { longText: "Fairfield County", shortText: "Fairfield County", types: ["administrative_area_level_2"] },
        { longText: "Connecticut", shortText: "CT", types: ["administrative_area_level_1"] },
        { longText: "United States", shortText: "US", types: ["country"] }
      ],
      location: { latitude: 41.242, longitude: -73.209 },
      rating: 4.4,
      nationalPhoneNumber: "(203) 452-5171",
      websiteUri: "https://www.tashuaknolls.com",
      photos: [
        {
          name: "places/abc123/photos/photo1",
          authorAttributions: [
            {
              displayName: "Google contributor",
              uri: "//maps.google.com/maps/contrib/123"
            }
          ]
        }
      ]
    });

    expect(course).toEqual({
      googlePlaceId: "abc123",
      name: "Tashua Knolls Golf Course",
      address: "40 Tashua Knolls Ln, Trumbull, CT",
      city: "Trumbull",
      stateCode: "CT",
      stateName: "Connecticut",
      county: "Fairfield",
      countryCode: "US",
      latitude: 41.242,
      longitude: -73.209,
      timeZone: "America/New_York",
      rating: 4.4,
      phone: "(203) 452-5171",
      website: "https://www.tashuaknolls.com",
      photoReference: "places/abc123/photos/photo1",
      photoAttributions: [
        {
          displayName: "Google contributor",
          uri: "//maps.google.com/maps/contrib/123"
        }
      ]
    });
  });

  it("loads a fresh Google Places photo and its required attribution", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        photos: [
          {
            name: "places/course-1/photos/photo-1",
            authorAttributions: [
              {
                displayName: "Course Photographer",
                uri: "https://maps.google.com/maps/contrib/example"
              }
            ]
          }
        ]
      })
    } as Response);

    await expect(getGooglePlacePhoto("course/with spaces")).resolves.toEqual({
      photoReference: "places/course-1/photos/photo-1",
      authorAttributions: [
        {
          displayName: "Course Photographer",
          uri: "https://maps.google.com/maps/contrib/example"
        }
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places/course%2Fwith%20spaces",
      {
        cache: "no-store",
        headers: {
          "X-Goog-Api-Key": "test-key",
          "X-Goog-FieldMask": "photos"
        }
      }
    );
  });

  it("falls back when Google has no current course photo", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({})
    } as Response);

    await expect(getGooglePlacePhoto("course-1")).resolves.toBeNull();
  });

  it("normalizes copied Google Places API keys before use in headers", () => {
    process.env.GOOGLE_PLACES_API_KEY = "\uFEFF copied-key \n";

    expect(getGooglePlacesApiKey()).toBe("copied-key");

    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it("finds public golf courses by name with a location bias", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        places: [
          {
            id: "places/bethpage-black",
            displayName: { text: "Bethpage Black Course" },
            formattedAddress: "99 Quaker Meeting House Rd, Farmingdale, NY",
            primaryType: "golf_course",
            types: ["golf_course"],
            businessStatus: "OPERATIONAL",
            websiteUri: "https://parks.ny.gov/golf/11/details.aspx",
            location: { latitude: 40.744, longitude: -73.456 }
          },
          {
            id: "places/private-club",
            displayName: { text: "Example Private Country Club" },
            formattedAddress: "Farmingdale, NY",
            primaryType: "golf_course",
            types: ["golf_course"],
            businessStatus: "OPERATIONAL",
            location: { latitude: 40.75, longitude: -73.45 }
          }
        ]
      })
    } as Response);

    const courses = await searchGolfCoursesByName({
      query: " Bethpage Black ",
      latitude: 40.73,
      longitude: -73.44
    });

    expect(courses).toHaveLength(1);
    expect(courses[0]).toEqual(
      expect.objectContaining({
        googlePlaceId: "bethpage-black",
        name: "Bethpage Black Course",
        distanceMeters: expect.any(Number)
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        body: expect.stringContaining('"strictTypeFiltering":true')
      })
    );
    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string
    );
    expect(requestBody).toEqual(
      expect.objectContaining({
        textQuery: "Bethpage Black",
        languageCode: "en",
        includedType: "golf_course",
        pageSize: 8,
        locationBias: {
          circle: {
            center: { latitude: 40.73, longitude: -73.44 },
            radius: 50000
          }
        }
      })
    );
  });

  it("returns an operational golf-course result for review when Google uses a sports-club primary type", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/ChIJ99HILg3O54kRiJLIRU3WbfE",
              displayName: { text: "Wheeler Family Traditions Golf Club" },
              formattedAddress: "37 Harrison Rd, Wallingford, CT 06492",
              primaryType: "sports_club",
              types: ["golf_course", "sports_club", "point_of_interest"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://wheelertraditions.com/",
              location: { latitude: 41.4262453, longitude: -72.8153967 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ places: [] })
      } as Response);

    const courses = await searchGolfCoursesByName({
      query: "wheeler family tranditions in wallinford"
    });

    expect(courses).toEqual([
      expect.objectContaining({
        googlePlaceId: "ChIJ99HILg3O54kRiJLIRU3WbfE",
        name: "Wheeler Family Traditions Golf Club",
        publicAccessStatus: "UNVERIFIED",
        website: "https://wheelertraditions.com/"
      })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("corroborates a public course whose name contains Country Club", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const grassyHillPlace = {
      id: "places/ChIJHRdhRQt16IkRnZxbawELtdM",
      displayName: { text: "Grassy Hill Country Club" },
      formattedAddress: "441 Clark Ln, Orange, CT 06477",
      primaryType: "association_or_organization",
      types: ["association_or_organization", "point_of_interest", "establishment"],
      businessStatus: "OPERATIONAL",
      websiteUri: "https://grassyhillcountryclub.com/",
      location: { latitude: 41.278, longitude: -73.025 }
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/orange-hills",
              displayName: { text: "Orange Hills Country Club" },
              primaryType: "association_or_organization",
              types: ["golf_course", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://orangehillscountryclub.com/",
              location: { latitude: 41.276, longitude: -73.002 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ places: [grassyHillPlace] })
      } as Response);

    const courses = await searchGolfCoursesByName({
      query: "Grassy Hill Country Club, Orange CT",
      latitude: 41.2307,
      longitude: -73.064
    });

    expect(courses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          googlePlaceId: "orange-hills",
          name: "Orange Hills Country Club",
          publicAccessStatus: "UNVERIFIED"
        }),
        expect.objectContaining({
          googlePlaceId: "ChIJHRdhRQt16IkRnZxbawELtdM",
          name: "Grassy Hill Country Club",
          publicAccessStatus: "PUBLIC",
          distanceMeters: expect.any(Number)
        })
      ])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const corroborationBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body as string
    );
    expect(corroborationBody).toEqual(
      expect.objectContaining({
        textQuery: "Grassy Hill Country Club, Orange CT public golf course",
        pageSize: 8
      })
    );
    expect(corroborationBody).not.toHaveProperty("strictTypeFiltering");
  });

  it("keeps likely public outdoor golf courses from Places results", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "places/tashua",
        displayName: { text: "Tashua Knolls & Tashua Glen Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "point_of_interest"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.242, longitude: -73.209 }
      },
      {
        id: "places/fairchild",
        displayName: { text: "Fairchild Wheeler Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.199, longitude: -73.236 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Tashua Knolls & Tashua Glen Golf Course",
      "Fairchild Wheeler Golf Course"
    ]);
  });

  it("ignores inactive exact-ID access reviews", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "inactive-private-review",
        name: "Inactive Review Golf Course",
        address: "1 Public Way, Example, CT",
        latitude: 41.2,
        longitude: -73.2
      })
    ]);

    expect(places).toHaveLength(1);
  });

  it("recovers an operational exact-ID verified public course despite weak provider typing", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "places/ChIJHRdhRQt16IkRnZxbawELtdM",
        displayName: { text: "Grassy Hill Country Club" },
        primaryType: "association_or_organization",
        types: ["association_or_organization", "point_of_interest"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.2675142, longitude: -73.044987 }
      }
    ]);

    expect(places).toHaveLength(1);
  });

  it("keeps a semantically corroborated public course when Google omits its golf type", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/h-smith-richardson",
          displayName: { text: "H Smith Richardson Golf Course" },
          types: ["point_of_interest", "establishment"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://hsrgolf.com/",
          location: { latitude: 41.2158, longitude: -73.2689 }
        },
        {
          id: "places/connecticut-club",
          displayName: { text: "The Connecticut Golf Club" },
          primaryType: "sports_club",
          types: ["sports_club", "association_or_organization"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://example.com/",
          location: { latitude: 41.264, longitude: -73.331 }
        },
        {
          id: "places/unverified-course",
          displayName: { text: "Unverified Golf Course" },
          types: ["point_of_interest"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://example.com/",
          location: { latitude: 41.2, longitude: -73.2 }
        }
      ],
      { publicCourseEvidenceIds: new Set(["h-smith-richardson", "connecticut-club"]) }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "H Smith Richardson Golf Course"
    ]);
  });

  it("recovers only corroborated sports-club records with a playable golf-course shape", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/gillette-ridge",
          displayName: { text: "Gillette Ridge Golf Club" },
          primaryType: "sports_club",
          types: ["golf_course", "sports_club", "point_of_interest"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.gilletteridgegolf.com/",
          location: { latitude: 41.8117579, longitude: -72.7438363 }
        },
        {
          id: "places/uncorroborated-club",
          displayName: { text: "Uncorroborated Golf Club" },
          primaryType: "sports_club",
          types: ["golf_course", "sports_club", "point_of_interest"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://example.com/uncorroborated",
          location: { latitude: 41.8, longitude: -72.7 }
        },
        {
          id: "places/no-golf-course-type",
          displayName: { text: "Public Sports Golf Club" },
          primaryType: "sports_club",
          types: ["sports_club", "association_or_organization"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://example.com/no-golf-type",
          location: { latitude: 41.79, longitude: -72.68 }
        },
        {
          id: "places/no-website",
          displayName: { text: "Public Golf Club" },
          primaryType: "sports_club",
          types: ["golf_course", "sports_club"],
          businessStatus: "OPERATIONAL",
          location: { latitude: 41.78, longitude: -72.66 }
        },
        {
          id: "places/no-golf-identity",
          displayName: { text: "Public Sports Club" },
          primaryType: "sports_club",
          types: ["golf_course", "sports_club"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://example.com/no-golf-identity",
          location: { latitude: 41.77, longitude: -72.64 }
        }
      ],
      {
        publicCourseEvidenceIds: new Set([
          "gillette-ridge",
          "no-golf-course-type",
          "no-website",
          "no-golf-identity"
        ])
      }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Gillette Ridge Golf Club"
    ]);
  });

  it("lets an exact private review override corroborated sports-club evidence", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJyaYoSGzg54kRN_2lDR8PO_g",
          displayName: { text: "Highland Golf Club" },
          primaryType: "sports_club",
          types: ["golf_course", "sports_club", "association_or_organization"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.highlandgolfclub.com/",
          location: { latitude: 41.806563, longitude: -72.694177 }
        }
      ],
      {
        publicCourseEvidenceIds: new Set(["ChIJyaYoSGzg54kRN_2lDR8PO_g"])
      }
    );

    expect(places).toEqual([]);
  });

  it("filters ancillary listings, private membership clubs, and closed businesses", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "places/golf-galaxy",
        displayName: { text: "Golf Galaxy" },
        primaryType: "sporting_goods_store",
        types: ["indoor_golf_course", "golf_course", "sporting_goods_store", "store"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.102, longitude: -73.417 }
      },
      {
        id: "places/racebrook",
        displayName: { text: "Race Brook Country Club" },
        primaryType: "association_or_organization",
        types: ["golf_course", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.296, longitude: -73.043 }
      },
      {
        id: "places/private-primary-course",
        displayName: { text: "Example Country Club" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.29, longitude: -73.04 }
      },
      {
        id: "places/ChIJMXRRcFvo5YkRkNXOrqSfVGM",
        displayName: { text: "Shelter Harbor Golf Club" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        websiteUri: "http://www.shgcri.com/",
        location: { latitude: 41.3564605, longitude: -71.7331924 }
      },
      {
        id: "places/presidio-fitting",
        displayName: { text: "Presidio Club Fitting" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.097, longitude: -73.392 }
      },
      {
        id: "places/general-store",
        displayName: { text: "General Store" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.163, longitude: -73.42 }
      },
      {
        id: "places/alameda-junior",
        displayName: { text: "Alameda Junior Golf Club" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.164, longitude: -73.421 }
      },
      {
        id: "places/olympic",
        displayName: { text: "The Olympic Club" },
        primaryType: "golf_course",
        types: ["golf_course", "sports_club", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 37.709, longitude: -122.495 }
      },
      {
        id: "places/monarch",
        displayName: { text: "Monarch Bay Golf Club" },
        primaryType: "golf_course",
        types: ["golf_course", "sports_club", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 37.695, longitude: -122.186 }
      },
      {
        id: "places/whitney-farms",
        displayName: { text: "Chris Bargas Golf Club at Whitney Farms" },
        primaryType: "golf_course",
        types: [
          "golf_course",
          "indoor_golf_course",
          "sports_club",
          "association_or_organization"
        ],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.304, longitude: -73.213 }
      },
      {
        id: "places/x-golf",
        displayName: { text: "X-Golf Stratford" },
        primaryType: "indoor_golf_course",
        types: ["indoor_golf_course", "golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.184, longitude: -73.13 }
      },
      {
        id: "places/closed-course",
        displayName: { text: "Closed Public Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "CLOSED_PERMANENTLY",
        location: { latitude: 41.2, longitude: -73.2 }
      },
      {
        id: "places/municipal",
        displayName: { text: "Short Beach Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "tourist_attraction"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.16, longitude: -73.12 }
      },
      {
        id: "places/ChIJHRdhRQt16IkRnZxbawELtdM",
        displayName: { text: "Grassy Hill Country Club" },
        primaryType: "association_or_organization",
        types: ["association_or_organization", "point_of_interest", "establishment"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://grassyhillcountryclub.com/",
        location: { latitude: 41.278, longitude: -73.025 }
      }
    ], {
      publicCourseEvidenceIds: new Set([
        "monarch",
        "olympic",
        "ChIJMXRRcFvo5YkRkNXOrqSfVGM",
        "ChIJHRdhRQt16IkRnZxbawELtdM"
      ])
    });

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Monarch Bay Golf Club",
      "Chris Bargas Golf Club at Whitney Farms",
      "Short Beach Golf Course",
      "Grassy Hill Country Club"
    ]);
  });

  it("filters maintenance and operations facilities without hiding their playable courses", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "ChIJfcMHKwCNmYARqWlJL4cM8LE",
        displayName: { text: "TPGC Maintenance Area" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 38.916, longitude: -119.996 }
      },
      {
        id: "ChIJoclV4c-NmYARi9m23CSEr8A",
        displayName: { text: "Tahoe Paradise Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.tahoeparadisegc.com/",
        location: { latitude: 38.921, longitude: -120.036 }
      },
      {
        id: "ChIJR6sij3COmYAR8Qc4BobIN7o",
        displayName: { text: "Lake Tahoe Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.laketahoegc.com/",
        location: { latitude: 38.925, longitude: -120.05 }
      },
      {
        id: "ChIJ_0OyqiG_mYARnWg5NLnXnuM",
        displayName: { text: "Carson Valley Golf Course Maintenance" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 38.949, longitude: -119.748 }
      },
      {
        id: "ChIJu8a6OOe-mYARUSzEeY_FMSI",
        displayName: { text: "Carson Valley Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.carsonvalleygolf.com/",
        location: { latitude: 38.95, longitude: -119.746 }
      },
      {
        id: "ChIJVwdGqOVLQIgRpEvBKvmw344",
        displayName: { text: "Winton Woods Operations" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 39.252, longitude: -84.514 }
      },
      {
        id: "ChIJ64HnP-FLQIgRJNKKarwJo4Y",
        displayName: { text: "Winton Woods Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.greatparks.org/recreation/golf/the-mill-course",
        location: { latitude: 39.272, longitude: -84.505 }
      },
      {
        id: "ChIJs9q-WF9JQIgRvJ2cRnefLSw",
        displayName: { text: "The Mill Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.greatparks.org/parks/winton-woods/the-mill-course",
        location: { latitude: 39.272, longitude: -84.505 }
      },
      {
        id: "ChIJpUnXVcO2QYgRRq54lylTTlo",
        displayName: { text: "Devou Park Golf & Event Center" },
        primaryType: "golf_course",
        types: ["golf_course", "event_venue", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.devouparkgolf.com/",
        location: { latitude: 39.076, longitude: -84.532 }
      },
      {
        id: "ChIJtwfFyOS4QYgRgwxug_LedR4",
        displayName: { text: "The Golf Courses Of Kenton County" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 38.978, longitude: -84.536 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Tahoe Paradise Golf Course",
      "Lake Tahoe Golf Course",
      "Carson Valley Golf Course",
      "Winton Woods Golf Course",
      "The Mill Course",
      "Devou Park Golf & Event Center",
      "The Golf Courses Of Kenton County"
    ]);
  });

  it("filters a verified indoor simulator that Google misclassifies as a golf course", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJy4_CTDEtDogR9wxAr-a-VGI",
          displayName: { text: "Chicago Golf Authority" },
          formattedAddress: "355 N Laflin St Suite 101, Chicago, IL 60607, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://chicagogolfauthority.com/",
          location: { latitude: 41.8881627, longitude: -87.664067 }
        }
      ],
      { publicCourseEvidenceIds: new Set(["ChIJy4_CTDEtDogR9wxAr-a-VGI"]) }
    );

    expect(places).toEqual([]);
  });

  it("filters Harmony's exact Rochester simulator while preserving nearby public courses", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJV_YX1RG11okRxSmNMNmBRrY",
          displayName: { text: "The Harmony Golf Club" },
          formattedAddress: "274 N Goodman St Ste D308, Rochester, NY 14610, USA",
          primaryType: "golf_course",
          types: [
            "golf_course",
            "sports_club",
            "association_or_organization",
            "athletic_field",
            "sports_activity_location"
          ],
          businessStatus: "OPERATIONAL",
          location: { latitude: 43.1586496, longitude: -77.5853794 }
        },
        makeOperationalGolfCoursePlace({
          id: "genesee-valley",
          name: "Genesee Valley Golf Course",
          address: "1000 E River Rd, Rochester, NY 14623, USA",
          latitude: 43.112,
          longitude: -77.655
        }),
        makeOperationalGolfCoursePlace({
          id: "durand-eastman",
          name: "Durand Eastman Golf Course",
          address: "1200 Kings Hwy N, Rochester, NY 14617, USA",
          latitude: 43.233,
          longitude: -77.558
        }),
        makeOperationalGolfCoursePlace({
          id: "eagle-vale",
          name: "Eagle Vale Golf Club",
          address: "4344 Fairport Nine Mile Point Rd, Fairport, NY 14450, USA",
          latitude: 43.071,
          longitude: -77.442
        })
      ],
      {
        publicCourseEvidenceIds: new Set([
          "ChIJV_YX1RG11okRxSmNMNmBRrY",
          "genesee-valley",
          "durand-eastman",
          "eagle-vale"
        ])
      }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Genesee Valley Golf Course",
      "Durand Eastman Golf Course",
      "Eagle Vale Golf Club"
    ]);
  });

  it("filters provider-labeled private courses while preserving public and verified controls", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "places/cda-main-gate",
        displayName: { text: "CDA National Reserve Main Gate" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Private Golf Course" },
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.cdanational.com/",
        location: { latitude: 47.554, longitude: -116.893 }
      },
      {
        id: "places/black-rock",
        displayName: { text: "The Golf Club At Black Rock" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: " private   golf course " },
        types: ["golf_course", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.blackrockidaho.com/",
        location: { latitude: 47.518, longitude: -116.871 }
      },
      {
        id: "places/liberty-lake",
        displayName: { text: "Liberty Lake Golf Course" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Golf Course" },
        types: ["golf_course", "athletic_field"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.spokanecounty.org/1210/Liberty-Lake",
        location: { latitude: 47.639, longitude: -117.032 }
      },
      {
        id: "places/cda-public",
        displayName: { text: "Coeur d'Alene Public Golf Club" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Public Golf Course" },
        types: ["golf_course", "sports_club", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://cdagolfclub.com/",
        location: { latitude: 47.704, longitude: -116.811 }
      },
      {
        id: "places/cda-resort",
        displayName: { text: "The Coeur d'Alene Resort Golf Course" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Golf Course" },
        types: ["golf_course", "resort_hotel", "restaurant"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.floatinggreen.com/",
        location: { latitude: 47.673, longitude: -116.773 }
      },
      {
        id: "places/pinehurst-no-2",
        displayName: { text: "Pinehurst No. 2" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Golf Course" },
        types: ["golf_course", "athletic_field"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.pinehurst.com/golf/courses/no-2/",
        location: { latitude: 35.195, longitude: -79.473 }
      },
      {
        id: "places/pinehurst-no-4",
        displayName: { text: "Pinehurst No. 4" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Golf Course" },
        types: ["golf_course", "athletic_field"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://www.pinehurst.com/golf/courses/no-4/",
        location: { latitude: 35.194, longitude: -79.477 }
      },
      {
        id: "places/ChIJHRdhRQt16IkRnZxbawELtdM",
        displayName: { text: "Grassy Hill Country Club" },
        primaryType: "golf_course",
        googleMapsTypeLabel: { text: "Private Golf Course" },
        types: ["golf_course", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        websiteUri: "https://grassyhillcountryclub.com/",
        location: { latitude: 41.278, longitude: -73.025 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Liberty Lake Golf Course",
      "Coeur d'Alene Public Golf Club",
      "The Coeur d'Alene Resort Golf Course",
      "Pinehurst No. 2",
      "Pinehurst No. 4",
      "Grassy Hill Country Club"
    ]);
  });

  it("filters the exact BagBoyz2 non-course while preserving Orlando public-course controls", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJa52pBnx754gRry26du_jGzo",
        name: "BagBoyz2",
        address: "401 Golfview St, Orlando, FL 32804, USA",
        latitude: 28.5638655,
        longitude: -81.389342
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJLT54-35654gRFv8axnThb4w",
        name: "Dubsdread Golf Course",
        address: "549 W Par St, Orlando, FL 32804, USA",
        latitude: 28.5827337,
        longitude: -81.3870569,
        websiteUri: "https://www.historicaldubsdread.com/"
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJZbxj1RVw54gRaBEj0ep2cgA",
        name: "Winter Park Golf Course",
        address: "761 Old England Ave, Winter Park, FL 32789, USA",
        latitude: 28.6036803,
        longitude: -81.3485347,
        websiteUri: "https://cityofwinterpark.org/departments/parks-recreation/golf-course/"
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ44Xwt6qA3YgRdgyVqjRvKiE",
        name: "The Ritz-Carlton Golf Club, Orlando, Grande Lakes",
        address: "4040 Central Florida Pkwy, Orlando, FL 32837, USA",
        latitude: 28.4109,
        longitude: -81.432,
        websiteUri: "https://www.ritzcarlton.com/en/hotels/mcorz-the-ritz-carlton-orlando-grande-lakes/golf/"
      }),
      makeOperationalGolfCoursePlace({
        id: "similar-bag-boyz-public-course",
        name: "Bag Boyz Golf Course",
        address: "100 Public Links Dr, Orlando, FL 32801, USA",
        latitude: 28.54,
        longitude: -81.38,
        websiteUri: "https://example.com/bag-boyz-golf-course"
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJHRdhRQt16IkRnZxbawELtdM",
        name: "Grassy Hill Country Club",
        address: "441 Clark Ln, Orange, CT 06477, USA",
        latitude: 41.2675142,
        longitude: -73.044987,
        websiteUri: "https://grassyhillcountryclub.com/"
      })
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Dubsdread Golf Course",
      "Winter Park Golf Course",
      "The Ritz-Carlton Golf Club, Orlando, Grande Lakes",
      "Bag Boyz Golf Course",
      "Grassy Hill Country Club"
    ]);
  });

  it("filters the exact Big Met parking place while preserving public-course controls", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJOQuc9RPtMIgR33aMCl2HdBA",
        name: "Big Met Golf Course Parking",
        address: "Cleveland, OH 44135, USA",
        latitude: 41.4472838,
        longitude: -81.8387709
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJIddckhHtMIgRSZrZkh6uwkY",
        name: "Big Met Golf Course",
        address: "4811 Valley Pkwy, Fairview Park, OH 44126, USA",
        latitude: 41.451927,
        longitude: -81.848156
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJRa-DdAztMIgRG3quwtOychI",
        name: "Little Met Golf Course",
        address: "18599 Old Lorain Rd, Cleveland, OH 44111, USA",
        latitude: 41.451423,
        longitude: -81.832236
      }),
      makeOperationalGolfCoursePlace({
        id: "resort-control",
        name: "The Coeur d'Alene Resort Golf Course",
        address: "900 S Floating Green Dr, Coeur d'Alene, ID 83814, USA",
        latitude: 47.6721,
        longitude: -116.7608
      }),
      makeOperationalGolfCoursePlace({
        id: "multi-layout-control",
        name: "Pinehurst No. 2",
        address: "1 Carolina Vista Dr, Pinehurst, NC 28374, USA",
        latitude: 35.1955,
        longitude: -79.4734
      })
    ]);

    expect(places.map((place) => place.id)).toEqual([
      "places/ChIJIddckhHtMIgRSZrZkh6uwkY",
      "places/ChIJRa-DdAztMIgRG3quwtOychI",
      "places/resort-control",
      "places/multi-layout-control"
    ]);
  });

  it("filters the verified ParTee simulator while preserving state-border public-course controls", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        makeOperationalGolfCoursePlace({
          id: "ChIJu4ODUC01oFQRrHyJkM_URz4",
          name: "PARTEE GOLF AND GAMES, LLC",
          address: "714 Main St, Lewiston, ID 83501, USA",
          latitude: 46.42,
          longitude: -117.024,
          websiteUri: "https://parteegolfgame.com/"
        }),
        makeOperationalGolfCoursePlace({
          id: "ChIJD4ko7ZS1oVQRrdP69CGMukM",
          name: "Quail Ridge Golf Course",
          address: "3600 Swallows Nest Loop, Clarkston, WA 99403, USA",
          latitude: 46.368,
          longitude: -117.081,
          websiteUri: "http://www.golfquailridge.com/"
        }),
        makeOperationalGolfCoursePlace({
          id: "ChIJ_dxXZWu1oVQRAmPX0GvVV_E",
          name: "Bryden Canyon Public Golf Course",
          address: "445 O'Connor Rd, Lewiston, ID 83501, USA",
          latitude: 46.379,
          longitude: -117.026,
          websiteUri: "https://www.playbrydencanyon.com/"
        }),
        makeOperationalGolfCoursePlace({
          id: "similar-par-tee-public-course",
          name: "Par Tee Golf Course",
          address: "100 Fairway Dr, Example, WA 99000, USA",
          latitude: 46.5,
          longitude: -117.1,
          websiteUri: "https://example.com/par-tee-golf-course"
        }),
        makeOperationalGolfCoursePlace({
          id: "resort-public-course",
          name: "Mountain Resort Golf Course",
          address: "200 Resort Way, Example, ID 83000, USA",
          latitude: 43.5,
          longitude: -111.1,
          websiteUri: "https://example.com/resort-golf"
        }),
        makeOperationalGolfCoursePlace({
          id: "ChIJHRdhRQt16IkRnZxbawELtdM",
          name: "Grassy Hill Country Club",
          address: "441 Clark Ln, Orange, CT 06477, USA",
          latitude: 41.268,
          longitude: -73.045,
          websiteUri: "https://grassyhillcountryclub.com/"
        })
      ],
      {
        publicCourseEvidenceIds: new Set([
          "ChIJu4ODUC01oFQRrHyJkM_URz4",
          "ChIJD4ko7ZS1oVQRrdP69CGMukM",
          "ChIJ_dxXZWu1oVQRAmPX0GvVV_E",
          "similar-par-tee-public-course",
          "resort-public-course",
          "ChIJHRdhRQt16IkRnZxbawELtdM"
        ])
      }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Quail Ridge Golf Course",
      "Bryden Canyon Public Golf Course",
      "Par Tee Golf Course",
      "Mountain Resort Golf Course",
      "Grassy Hill Country Club"
    ]);
  });

  it("filters verified private, non-course, and duplicate state-border results", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJ_XcwMtag4YkRTZLeHPhjYdg",
          displayName: { text: "Hooper Golf Course" },
          formattedAddress: "166 Prospect Hill Rd, Walpole, NH 03608, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "http://www.hoopergolfcourse.com/",
          location: { latitude: 43.0655468, longitude: -72.4168696 }
        },
        {
          id: "places/ChIJw4LoQ3TL4YkR--PVXKkrk7I",
          displayName: { text: "The Barn At Fox Run" },
          formattedAddress: "89 Fox Ln Ext, Ludlow, VT 05149, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.thebarnatfoxrunvt.com/the-barn",
          location: { latitude: 43.39, longitude: -72.69 }
        },
        {
          id: "places/ChIJvbRuDR9Y4IkRe4pD0YaU5fQ",
          displayName: { text: "Stratton Mountain Golf Course" },
          formattedAddress: "251 Stratton Mountain Rd, Stratton Mountain, VT 05155, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.stratton.com/things-to-do/activities/stratton-golf",
          location: { latitude: 43.1250868, longitude: -72.9046048 }
        },
        {
          id: "places/ChIJj1vnKctZ4IkRr5BY1-F-5AE",
          displayName: { text: "Stratton Golf Course" },
          formattedAddress: "South Londonderry, VT 05155, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.stratton.com/things-to-do/activities/stratton-golf",
          location: { latitude: 43.122, longitude: -72.905 }
        },
        {
          id: "places/ChIJ-5eDKiZ64YkROEiuRnTjEKw",
          displayName: { text: "Dublin Lake Club Golf Course" },
          formattedAddress: "180 Old Marlborough Rd, Dublin, NH 03444, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          location: { latitude: 42.91, longitude: -72.08 }
        },
        {
          id: "places/ChIJ0fUoNOn24YkRd7n-n1PQsls",
          displayName: { text: "Baker Hill Golf Club" },
          formattedAddress: "101 Baker Hill Rd, Newbury, NH 03255, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.bakerhill.org/",
          location: { latitude: 43.35, longitude: -72.0 }
        }
      ],
      {
        publicCourseEvidenceIds: new Set([
          "ChIJ_XcwMtag4YkRTZLeHPhjYdg",
          "ChIJw4LoQ3TL4YkR--PVXKkrk7I",
          "ChIJvbRuDR9Y4IkRe4pD0YaU5fQ",
          "ChIJj1vnKctZ4IkRr5BY1-F-5AE",
          "ChIJ-5eDKiZ64YkROEiuRnTjEKw",
          "ChIJ0fUoNOn24YkRd7n-n1PQsls"
        ])
      }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Hooper Golf Course",
      "Stratton Mountain Golf Course"
    ]);
  });

  it("filters verified NYC private and non-course records while preserving public golf-club controls", () => {
    const places = [
      {
        id: "ChIJaWYTRqBbwokRONcYEIxCk1k",
        displayName: { text: "NEXUS Golf Club" },
        formattedAddress: "100 Church St Basement, New York, NY 10007, USA",
        websiteUri: "https://www.nexusgolf.com/",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.7133174, longitude: -74.0101115 }
      },
      {
        id: "ChIJa0Z9c_5QwokR83AzfcoIODI",
        displayName: { text: "Liberty National Golf Club" },
        formattedAddress: "100 Caven Point Rd, Jersey City, NJ 07305, USA",
        websiteUri: "http://www.libertynationalgc.com/",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.6941222, longitude: -74.0740038 }
      },
      {
        id: "ChIJ7dQcqrv5wokRIats-Rg1dZo",
        displayName: { text: "BackyardSwingsStudio" },
        formattedAddress: "31 Roosevelt St, Little Ferry, NJ 07643, USA",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.8498815, longitude: -74.0469424 }
      },
      {
        id: "ChIJ7cBXOMNRwokREKeDC0xNIrY",
        displayName: { text: "Bayonne Golf Club" },
        formattedAddress: "1 Lefante Way, Bayonne, NJ 07002, USA",
        websiteUri: "http://www.bayonnegolfclub.com/",
        types: ["golf_course", "sports_club", "association_or_organization"],
        location: { latitude: 40.6628266, longitude: -74.0965313 }
      },
      {
        id: "ChIJwYHDYQ5VwokRfkjeAFO-rcY",
        displayName: { text: "Forest Hill Field Club" },
        formattedAddress: "Forest Hill Field Club, 9 Belleville Ave, Bloomfield, NJ 07003, USA",
        websiteUri: "http://www.foresthillfc.com/",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.7991535, longitude: -74.1792906 }
      },
      {
        id: "ChIJmYaOBZeqw4kR8uLQ3-n-ies",
        displayName: { text: "Montclair Golf Club" },
        formattedAddress: "25 Prospect Ave, West Orange, NJ 07052, USA",
        websiteUri: "http://www.montclairgolfclub.org/",
        types: ["golf_course", "sports_club", "association_or_organization"],
        location: { latitude: 40.817941, longitude: -74.240543 }
      },
      {
        id: "ChIJdZB9I4hhwokRFfvXRLrWvi8",
        displayName: { text: "Q5C9+8VQ New York" },
        formattedAddress: "138-12 28th Rd apt 5E 5E, Flushing, NY 11354, USA",
        websiteUri: "https://github.com/makesdiff-web/Q5C9-8VQ-New-York/issues/2",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.7722206, longitude: -73.8303981 }
      },
      {
        id: "ChIJuaPE_8xWwokRusP2aevpDu8",
        displayName: { text: "Skyway Golf Course" },
        formattedAddress: "515 Duncan Ave, Jersey City, NJ 07306, USA",
        websiteUri: "http://www.skywaygolfcourse.com/",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.7301, longitude: -74.0877 }
      },
      {
        id: "ChIJR9a-vwpewokR-SW471X22V8",
        displayName: { text: "Forest Park Golf Course" },
        formattedAddress: "1-01 Forest Park Dr, Woodhaven, NY 11421, USA",
        websiteUri: "http://www.golfnyc.com/forest-park-course/",
        types: ["golf_course", "athletic_field", "sports_activity_location"],
        location: { latitude: 40.7018, longitude: -73.8575 }
      },
      {
        id: "places/whitney-farms",
        displayName: { text: "Chris Bargas Golf Club at Whitney Farms" },
        formattedAddress: "175 Shelton Rd, Monroe, CT 06468, USA",
        websiteUri: "https://www.chrisbargasgolf.com/",
        types: ["golf_course", "sports_club", "association_or_organization"],
        location: { latitude: 41.304, longitude: -73.213 }
      }
    ].map((place) => ({
      ...place,
      primaryType: "golf_course",
      businessStatus: "OPERATIONAL" as const
    }));

    const filtered = filterPublicGolfCoursePlaces(places, {
      publicCourseEvidenceIds: new Set(places.map((place) => place.id.replace(/^places\//, "")))
    });

    expect(filtered.map((place) => place.displayName?.text)).toEqual([
      "Skyway Golf Course",
      "Forest Park Golf Course",
      "Chris Bargas Golf Club at Whitney Farms"
    ]);
  });

  it("filters the verified member-only Baywood record while preserving public 95501 controls", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        makeOperationalGolfCoursePlace({
          id: "ChIJweiRhX0A1FQRCXE20jewqVQ",
          name: "Eureka Municipal Golf Course",
          address: "4750 Fairway Dr, Eureka, CA 95503, USA",
          latitude: 40.773,
          longitude: -124.171,
          websiteUri: "https://www.eurekagolfcourse.com/"
        }),
        makeOperationalGolfCoursePlace({
          id: "ChIJtVWUTNtX0VQR4I_SquYKOr4",
          name: "Baywood Golf & Country Club",
          address: "3600 Buttermilk Ln, Arcata, CA 95521, USA",
          latitude: 40.886,
          longitude: -124.083,
          websiteUri: "https://baywoodgcc.com/"
        }),
        makeOperationalGolfCoursePlace({
          id: "ChIJwWPQgChb0VQRKYvyfu16ypM",
          name: "Beau Pre Golf Course",
          address: "1777 Norton Rd, McKinleyville, CA 95519, USA",
          latitude: 40.94,
          longitude: -124.111,
          websiteUri: "https://beaupre.golf/"
        }),
        makeOperationalGolfCoursePlace({
          id: "ChIJHRdhRQt16IkRnZxbawELtdM",
          name: "Grassy Hill Country Club",
          address: "441 Clark Ln, Orange, CT 06477, USA",
          latitude: 41.268,
          longitude: -73.045,
          websiteUri: "https://grassyhillcountryclub.com/"
        })
      ],
      {
        publicCourseEvidenceIds: new Set([
          "ChIJweiRhX0A1FQRCXE20jewqVQ",
          "ChIJtVWUTNtX0VQR4I_SquYKOr4",
          "ChIJwWPQgChb0VQRKYvyfu16ypM",
          "ChIJHRdhRQt16IkRnZxbawELtdM"
        ])
      }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Eureka Municipal Golf Course",
      "Beau Pre Golf Course",
      "Grassy Hill Country Club"
    ]);
  });

  it("filters the verified private Hallbrook hole pin despite public-query evidence", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJXdJQJmTpwIcRsoa_jpffsqs",
          displayName: { text: "18th Hole - Hallbrook CC" },
          formattedAddress: "Leawood, KS 66211, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.hallbrookcc.org/",
          location: { latitude: 38.9221969, longitude: -94.6295394 }
        }
      ],
      { publicCourseEvidenceIds: new Set(["ChIJXdJQJmTpwIcRsoa_jpffsqs"]) }
    );

    expect(places).toEqual([]);
  });

  it("filters verified private Old Sandwich while preserving nearby public Waverly Oaks", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJUTDSFL-w5IkRtjT_2vg_TJM",
          displayName: { text: "Old Sandwich Golf Club" },
          formattedAddress: "247 Old Sandwich Rd, Plymouth, MA 02360, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "http://www.osgolfclub.com/",
          location: { latitude: 41.9069709, longitude: -70.6042556 }
        },
        {
          id: "places/ChIJQxFz-eK55IkRdhhkVf6ox7M",
          displayName: { text: "Waverly Oaks Golf Club" },
          formattedAddress: "444 Long Pond Rd, Plymouth, MA 02360, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "http://www.waverlyoaksgc.com/",
          location: { latitude: 41.8896675, longitude: -70.6190414 }
        }
      ],
      {
        publicCourseEvidenceIds: new Set([
          "ChIJUTDSFL-w5IkRtjT_2vg_TJM",
          "ChIJQxFz-eK55IkRdhhkVf6ox7M"
        ])
      }
    );

    expect(places.map((place) => place.id)).toEqual([
      "places/ChIJQxFz-eK55IkRdhhkVf6ox7M"
    ]);
  });

  it("keeps canonical Phoenix courses while suppressing their verified aliases", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJAQAAgewFK4cRxjiU-zozIzs",
        name: "Arizona Grand Golf Course",
        address: "9433 S 50th St, Phoenix, AZ 85044, USA",
        latitude: 33.3613688,
        longitude: -111.9733018
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ____iusFK4cReVCFj6EmIBQ",
        name: "Arizona Grand Golf Course",
        address: "9201 S 51st St, Phoenix, AZ 85044, USA",
        latitude: 33.363,
        longitude: -111.969
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJL7Z5avQFK4cRO4PIpaKi9iA",
        name: "Arizona Grand Golf Course",
        address: "8000 S Arizona Grand Pkwy, Phoenix, AZ 85044, USA",
        latitude: 33.3732199,
        longitude: -111.9703264,
        websiteUri: "https://www.arizonagrandgolf.com/"
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ____G7MFK4cRf2hkJjIoEWo",
        name: "Golf Course",
        address: "Phoenix, AZ 85044, USA",
        latitude: 33.334078,
        longitude: -111.9846664
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJq6qqv7QFK4cRZNsSs47toA8",
        name: "Golf Course",
        address: "12000 S 50th Way, Phoenix, AZ 85044, USA",
        latitude: 33.3343027,
        longitude: -111.980754
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJq6qqPcgFK4cRuYv0flb88dY",
        name: "Golf Course",
        address: "12432 S 48th St, Phoenix, AZ 85044, USA",
        latitude: 33.3433448,
        longitude: -111.9751648
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJq6qqBnIGK4cRPpgjylaZoIo",
        name: "Golf Course",
        address: "Tempe, AZ 85283, USA",
        latitude: 33.3568985,
        longitude: -111.940698
      })
    ]);

    expect(places.map((place) => place.id)).toEqual([
      "places/ChIJL7Z5avQFK4cRO4PIpaKi9iA",
      "places/ChIJq6qqPcgFK4cRuYv0flb88dY",
      "places/ChIJq6qqBnIGK4cRPpgjylaZoIo"
    ]);
    expect(places.map(mapGooglePlaceToCourseCandidate)).toEqual([
      expect.objectContaining({
        googlePlaceId: "ChIJL7Z5avQFK4cRO4PIpaKi9iA",
        name: "Arizona Grand Golf Course",
        address: "8000 S Arizona Grand Pkwy, Phoenix, AZ 85044, USA",
        website: "https://www.arizonagrandgolf.com/"
      }),
      expect.objectContaining({
        googlePlaceId: "ChIJq6qqPcgFK4cRuYv0flb88dY",
        name: "Ahwatukee Golf Club",
        address: "12432 S 48th St, Phoenix, AZ 85044, USA",
        phone: "(480) 893-1161",
        website: "https://www.ahwatukeegolf.com/"
      }),
      expect.objectContaining({
        googlePlaceId: "ChIJq6qqBnIGK4cRPpgjylaZoIo",
        name: "Golf Course",
        address: "Tempe, AZ 85283, USA"
      })
    ]);
  });

  it("retains verified Phoenix aliases when their canonical records are absent", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJ____iusFK4cReVCFj6EmIBQ",
        name: "Arizona Grand Golf Course",
        address: "9201 S 51st St, Phoenix, AZ 85044, USA",
        latitude: 33.363,
        longitude: -111.969
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ____G7MFK4cRf2hkJjIoEWo",
        name: "Golf Course",
        address: "Phoenix, AZ 85044, USA",
        latitude: 33.334078,
        longitude: -111.9846664
      })
    ]).map(mapGooglePlaceToCourseCandidate);

    expect(places).toEqual([
      expect.objectContaining({
        googlePlaceId: "ChIJL7Z5avQFK4cRO4PIpaKi9iA",
        name: "Arizona Grand Golf Course",
        address: "8000 S Arizona Grand Pkwy, Phoenix, AZ 85044, USA",
        website: "https://www.arizonagrandgolf.com/"
      }),
      expect.objectContaining({
        googlePlaceId: "ChIJq6qqPcgFK4cRuYv0flb88dY",
        name: "Ahwatukee Golf Club",
        address: "12432 S 48th St, Phoenix, AZ 85044, USA",
        phone: "(480) 893-1161",
        website: "https://www.ahwatukeegolf.com/"
      })
    ]);
  });

  it("retains one official course when Google returns multiple aliases without a canonical", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJAQAAgewFK4cRxjiU-zozIzs",
        name: "Arizona Grand Golf Course",
        address: "9433 S 50th St, Phoenix, AZ 85044, USA",
        latitude: 33.3613688,
        longitude: -111.9733018
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ____iusFK4cReVCFj6EmIBQ",
        name: "Arizona Grand Golf Course",
        address: "9201 S 51st St, Phoenix, AZ 85044, USA",
        latitude: 33.363,
        longitude: -111.969
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ____G7MFK4cRf2hkJjIoEWo",
        name: "Golf Course",
        address: "Phoenix, AZ 85044, USA",
        latitude: 33.334078,
        longitude: -111.9846664
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJq6qqv7QFK4cRZNsSs47toA8",
        name: "Golf Course",
        address: "12000 S 50th Way, Phoenix, AZ 85044, USA",
        latitude: 33.3343027,
        longitude: -111.980754
      })
    ]).map(mapGooglePlaceToCourseCandidate);

    expect(places).toHaveLength(2);
    expect(places.map((place) => place.name)).toEqual([
      "Arizona Grand Golf Course",
      "Ahwatukee Golf Club"
    ]);
  });

  it("chooses stable Phoenix aliases and canonical persisted IDs regardless of provider order", () => {
    const filtered = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJ____iusFK4cReVCFj6EmIBQ",
        name: "Arizona Grand Golf Course",
        address: "9201 S 51st St, Phoenix, AZ 85044, USA",
        latitude: 33.363,
        longitude: -111.969
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJAQAAgewFK4cRxjiU-zozIzs",
        name: "Arizona Grand Golf Course",
        address: "9433 S 50th St, Phoenix, AZ 85044, USA",
        latitude: 33.3613688,
        longitude: -111.9733018
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJq6qqv7QFK4cRZNsSs47toA8",
        name: "Golf Course",
        address: "12000 S 50th Way, Phoenix, AZ 85044, USA",
        latitude: 33.3343027,
        longitude: -111.980754
      }),
      makeOperationalGolfCoursePlace({
        id: "ChIJ____G7MFK4cRf2hkJjIoEWo",
        name: "Golf Course",
        address: "Phoenix, AZ 85044, USA",
        latitude: 33.334078,
        longitude: -111.9846664
      })
    ]);

    expect(filtered.map((place) => place.id)).toEqual([
      "places/ChIJAQAAgewFK4cRxjiU-zozIzs",
      "places/ChIJ____G7MFK4cRf2hkJjIoEWo"
    ]);
    expect(filtered.map(mapGooglePlaceToCourseCandidate)).toEqual([
      expect.objectContaining({ googlePlaceId: "ChIJL7Z5avQFK4cRO4PIpaKi9iA" }),
      expect.objectContaining({ googlePlaceId: "ChIJq6qqPcgFK4cRuYv0flb88dY" })
    ]);
  });

  it("keeps the verified Stratton secondary identity suppressed when canonical data is absent", () => {
    const places = filterPublicGolfCoursePlaces([
      makeOperationalGolfCoursePlace({
        id: "ChIJj1vnKctZ4IkRr5BY1-F-5AE",
        name: "Stratton Golf Course",
        address: "Stratton, VT 05155, USA",
        latitude: 43.114,
        longitude: -72.908
      })
    ]);

    expect(places).toEqual([]);
  });

  it("filters verified Miami non-courses and an invitation-only club from live discovery", () => {
    const places = filterPublicGolfCoursePlaces(
      [
        {
          id: "places/ChIJ67JAVPK12YgRnl_JdjR_gFs",
          displayName: { text: "Green Girls Golf" },
          formattedAddress: "551 Collins Ave, Miami Beach, FL 33139, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.greengirlsgolf.om/",
          location: { latitude: 25.773, longitude: -80.134 }
        },
        {
          id: "places/ChIJ6xdB1Jq02YgR4mExla8UqpE",
          displayName: { text: "South Florida Golf Magazine" },
          formattedAddress: "326 Lincoln Rd #228, Miami Beach, FL 33139, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          location: { latitude: 25.79, longitude: -80.131 }
        },
        {
          id: "places/ChIJQfF9gY612YgRgEZ2p_DUI0M",
          displayName: { text: "Celebrity Amputee Golf Classic" },
          formattedAddress: "6700 Crandon Blvd, Key Biscayne, FL 33149, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          location: { latitude: 25.708, longitude: -80.156 }
        },
        {
          id: "places/ChIJ9zQbdAC72YgRyrZQ5alj1h4",
          displayName: { text: "PGA TOUR Deliveries" },
          formattedAddress: "8864 NW 58th St, Doral, FL 33178, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          location: { latitude: 25.827, longitude: -80.339 }
        },
        {
          id: "places/ChIJbV3-V-av2YgRGc2i3GxAjEY",
          displayName: { text: "Golf Miami 305" },
          formattedAddress: "19715 NW 37th Ave, Miami Gardens, FL 33056, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://www.golfmiami305.com/",
          location: { latitude: 25.954, longitude: -80.263 }
        },
        {
          id: "places/ChIJy0obgpGr2YgR3puygnLMK5M",
          displayName: { text: "Shell Bay Club" },
          formattedAddress: "661 Diplomat Pkwy, Hallandale Beach, FL 33009, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://shellbayclub.com/",
          location: { latitude: 25.994, longitude: -80.138 }
        },
        {
          id: "places/ChIJC_uG9o612YgR4-xHKDaSVBE",
          displayName: { text: "Crandon Golf at Key Biscayne" },
          formattedAddress: "6700 Crandon Blvd, Key Biscayne, FL 33149, USA",
          primaryType: "golf_course",
          types: ["golf_course"],
          businessStatus: "OPERATIONAL",
          websiteUri: "http://golfcrandon.com/",
          location: { latitude: 25.708, longitude: -80.156 }
        }
      ],
      {
        publicCourseEvidenceIds: new Set([
          "ChIJ67JAVPK12YgRnl_JdjR_gFs",
          "ChIJ6xdB1Jq02YgR4mExla8UqpE",
          "ChIJQfF9gY612YgRgEZ2p_DUI0M",
          "ChIJ9zQbdAC72YgRyrZQ5alj1h4",
          "ChIJbV3-V-av2YgRGc2i3GxAjEY",
          "ChIJy0obgpGr2YgR3puygnLMK5M",
          "ChIJC_uG9o612YgR4-xHKDaSVBE"
        ])
      }
    );

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Crandon Golf at Key Biscayne"
    ]);
  });

  it("dedupes the same logical course without collapsing distinct courses at one venue", () => {
    const places = dedupeGolfCoursePlaces([
      {
        id: "places/presidio-canonical",
        displayName: { text: "Presidio Golf Course" },
        formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        rating: 4.5,
        websiteUri: "https://www.presidiogolf.com/",
        photos: [{ name: "places/presidio-canonical/photos/1" }],
        location: { latitude: 37.79049, longitude: -122.45979 }
      },
      {
        id: "places/presidio-duplicate",
        displayName: { text: "Presidio Golf" },
        formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        location: { latitude: 37.79057, longitude: -122.45987 }
      },
      {
        id: "places/fleming",
        displayName: { text: "Fleming 9 Course" },
        formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        websiteUri: "https://tpc.com/tpc-harding-park-fleming-course",
        location: { latitude: 37.72563, longitude: -122.49106 }
      },
      {
        id: "places/harding",
        displayName: { text: "TPC Harding Park" },
        formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        websiteUri: "https://tpc.com/hardingpark",
        location: { latitude: 37.72482, longitude: -122.4932 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Presidio Golf Course",
      "Fleming 9 Course",
      "TPC Harding Park"
    ]);
  });

  it("replaces a generic same-location result with the identified course", () => {
    const places = dedupeGolfCoursePlaces([
      {
        id: "places/generic-fairview",
        displayName: { text: "Golf Course" },
        formattedAddress: "Harwinton, CT 06791, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        location: { latitude: 41.7478038, longitude: -73.074469 }
      },
      {
        id: "places/fairview-farm",
        displayName: { text: "Fairview Farm Golf Course" },
        formattedAddress: "300 Hill Rd, Harwinton, CT 06791, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        websiteUri: "https://fairviewfarmgc.com/",
        location: { latitude: 41.7470436, longitude: -73.07518 }
      }
    ]);

    expect(places).toHaveLength(1);
    expect(places[0]?.displayName?.text).toBe("Fairview Farm Golf Course");
  });

  it("dedupes the generic Fairview label regardless of result ordering", () => {
    const fairview = {
      id: "places/fairview-farm",
      displayName: { text: "Fairview Farm Golf Course" },
      formattedAddress: "300 Hill Rd, Harwinton, CT 06791, USA",
      primaryType: "golf_course",
      types: ["golf_course"],
      location: { latitude: 41.7470436, longitude: -73.07518 }
    };
    const generic = {
      id: "places/generic-fairview",
      displayName: { text: "Golf Course" },
      formattedAddress: "Harwinton, CT 06791, USA",
      primaryType: "golf_course",
      types: ["golf_course"],
      location: { latitude: 41.7478038, longitude: -73.074469 }
    };

    expect(dedupeGolfCoursePlaces([fairview, generic])).toEqual([fairview]);
    expect(dedupeGolfCoursePlaces([generic, fairview])).toEqual([fairview]);
  });

  it("does not collapse an ambiguous generic label or distinct courses at dense venues", () => {
    const places = dedupeGolfCoursePlaces([
      {
        id: "places/generic-bethpage",
        displayName: { text: "Golf Course" },
        formattedAddress: "Farmingdale, NY 11735, USA",
        location: { latitude: 40.744, longitude: -73.455 }
      },
      {
        id: "places/bethpage-black",
        displayName: { text: "Bethpage Black Golf Course" },
        formattedAddress: "99 Quaker Meeting House Rd, Farmingdale, NY 11735, USA",
        nationalPhoneNumber: "(516) 249-0700",
        websiteUri: "https://www.bethpagegolfcourse.com/",
        location: { latitude: 40.7445, longitude: -73.455 }
      },
      {
        id: "places/bethpage-red",
        displayName: { text: "Bethpage Red Golf Course" },
        formattedAddress: "99 Quaker Meeting House Rd, Farmingdale, NY 11735, USA",
        nationalPhoneNumber: "(516) 249-0700",
        websiteUri: "https://www.bethpagegolfcourse.com/",
        location: { latitude: 40.7435, longitude: -73.455 }
      },
      {
        id: "places/torrey-facility",
        displayName: { text: "Torrey Pines Golf Course" },
        formattedAddress: "11480 N Torrey Pines Rd, La Jolla, CA 92037, USA",
        websiteUri: "https://www.sandiego.gov/torrey-pines",
        location: { latitude: 32.8998, longitude: -117.243 }
      },
      {
        id: "places/torrey-south",
        displayName: { text: "Torrey Pines Golf Course: South Course" },
        formattedAddress: "11480 N Torrey Pines Rd, La Jolla, CA 92037, USA",
        websiteUri: "https://www.sandiego.gov/torrey-pines",
        location: { latitude: 32.8995, longitude: -117.243 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Golf Course",
      "Bethpage Black Golf Course",
      "Bethpage Red Golf Course",
      "Torrey Pines Golf Course",
      "Torrey Pines Golf Course: South Course"
    ]);
  });

  it("merges popularity and distance ranked Places results before filtering", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/centennial",
              displayName: { text: "Centennial Golf Club" },
              formattedAddress: "185 John Simpson Rd, Carmel Hamlet, NY",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.35, longitude: -73.4 }
            },
            {
              id: "places/tashua",
              displayName: { text: "Tashua Knolls & Tashua Glen Golf Course" },
              formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.242, longitude: -73.209 }
            },
            {
              id: "places/golf-galaxy",
              displayName: { text: "Golf Galaxy" },
              primaryType: "sporting_goods_store",
              types: ["golf_course", "sporting_goods_store"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.102, longitude: -73.417 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/tashua",
              displayName: { text: "Tashua Knolls & Tashua Glen Golf Course" },
              formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.242, longitude: -73.209 }
            },
            {
              id: "places/fairchild",
              displayName: { text: "Fairchild Wheeler Golf Course" },
              formattedAddress: "2390 Easton Tpke, Fairfield, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.199, longitude: -73.236 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [{ id: "places/centennial" }, { id: "places/tashua" }, { id: "places/fairchild" }]
        })
      } as Response)
      .mockResolvedValueOnce({ ok: false } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 41.242,
      longitude: -73.209,
      radiusMeters: 30000
    });

    expect(courses.map((course) => course.name)).toEqual([
      "Tashua Knolls & Tashua Glen Golf Course",
      "Fairchild Wheeler Golf Course",
      "Centennial Golf Club"
    ]);
    expect(courses[0]?.distanceMeters).toBe(0);
    expect(courses[1]?.distanceMeters).toBeLessThan(courses[2]?.distanceMeters ?? 0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://places.googleapis.com/v1/places:searchNearby",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-FieldMask": expect.stringContaining("places.googleMapsTypeLabel")
        }),
        body: expect.stringContaining('"includedPrimaryTypes":["golf_course"]')
      })
    );
    const nearbyRequestBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string
    );
    expect(nearbyRequestBody).toEqual(
      expect.objectContaining({
        languageCode: "en",
        includedPrimaryTypes: ["golf_course"]
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://places.googleapis.com/v1/places:searchNearby",
      expect.objectContaining({
        body: expect.stringContaining('"rankPreference":"DISTANCE"')
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-FieldMask": expect.stringContaining("places.googleMapsTypeLabel")
        }),
        body: expect.stringContaining('"locationRestriction"')
      })
    );
  });

  it("adds a nearby semantic course that Google no longer types as a golf course", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/tashua",
              displayName: { text: "Tashua Knolls Golf Course" },
              formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.242, longitude: -73.209 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: []
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/h-smith-richardson",
              displayName: { text: "H Smith Richardson Golf Course" },
              formattedAddress: "2425 Morehouse Hwy, Fairfield, CT",
              types: ["point_of_interest", "establishment"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://hsrgolf.com/",
              location: { latitude: 41.2158, longitude: -73.2689 }
            },
            {
              id: "places/private-club",
              displayName: { text: "The Connecticut Golf Club" },
              formattedAddress: "915 Black Rock Tpke, Easton, CT",
              primaryType: "sports_club",
              types: ["sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://example.com/",
              location: { latitude: 41.264, longitude: -73.331 }
            },
            {
              id: "places/general-store",
              displayName: { text: "General Store" },
              formattedAddress: "Fairfield, CT",
              types: ["point_of_interest"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://example.com/",
              location: { latitude: 41.21, longitude: -73.26 }
            },
            {
              id: "places/far-course",
              displayName: { text: "Far Away Golf Course" },
              formattedAddress: "Far Away, CT",
              types: ["point_of_interest"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://example.com/",
              location: { latitude: 41.55, longitude: -73.209 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({ ok: false } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 41.242,
      longitude: -73.209,
      radiusMeters: 24140
    });

    expect(courses.map((course) => course.name)).toEqual([
      "Tashua Knolls Golf Course",
      "H Smith Richardson Golf Course"
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        body: expect.not.stringContaining('"strictTypeFiltering"')
      })
    );
  });

  it("adds a public-text sports club with golf-course evidence while excluding an exact private club", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ places: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ places: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/ChIJvbgDvA-r54kRnKZmg_Lj1Wc",
              displayName: { text: "Gillette Ridge Golf Club" },
              formattedAddress: "1360 Hall Blvd, Bloomfield, CT 06002",
              primaryType: "sports_club",
              types: ["golf_course", "sports_club", "point_of_interest"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://www.gilletteridgegolf.com/",
              location: { latitude: 41.8117579, longitude: -72.7438363 }
            },
            {
              id: "places/ChIJyaYoSGzg54kRN_2lDR8PO_g",
              displayName: { text: "Highland Golf Club" },
              formattedAddress: "10 Goodwin St, Hartford, CT 06103",
              primaryType: "sports_club",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              websiteUri: "https://www.highlandgolfclub.com/",
              location: { latitude: 41.775, longitude: -72.694 }
            }
          ]
        })
      } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 41.7658,
      longitude: -72.6734,
      radiusMeters: 24140
    });

    expect(courses).toEqual([
      expect.objectContaining({
        googlePlaceId: "ChIJvbgDvA-r54kRnKZmg_Lj1Wc",
        name: "Gillette Ridge Golf Club",
        website: "https://www.gilletteridgegolf.com/",
        distanceMeters: expect.any(Number)
      })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://places.googleapis.com/v1/places:searchNearby",
      expect.objectContaining({
        body: expect.stringContaining('"includedPrimaryTypes":["golf_course"]')
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        body: expect.stringContaining('"textQuery":"public golf courses"')
      })
    );
  });

  it("guarantees a verified reported course in nearby Milford discovery", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ places: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ places: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ places: [] }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "ChIJHRdhRQt16IkRnZxbawELtdM",
          displayName: { text: "Grassy Hill Country Club" },
          formattedAddress: "441 Clark Ln, Orange, CT 06477",
          primaryType: "association_or_organization",
          types: ["association_or_organization", "point_of_interest", "establishment"],
          businessStatus: "OPERATIONAL",
          websiteUri: "https://grassyhillcountryclub.com/",
          location: { latitude: 41.2675142, longitude: -73.044987 }
        })
      } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 41.2306979,
      longitude: -73.064036,
      radiusMeters: 24140
    });

    expect(courses).toEqual([
      expect.objectContaining({
        googlePlaceId: "ChIJHRdhRQt16IkRnZxbawELtdM",
        name: "Grassy Hill Country Club",
        distanceMeters: expect.any(Number)
      })
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://places.googleapis.com/v1/places/ChIJHRdhRQt16IkRnZxbawELtdM",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-FieldMask": expect.stringContaining("displayName")
        })
      })
    );
  });

  it("removes SF sub-venues and an uncorroborated private club from discovery", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/presidio",
              displayName: { text: "Presidio Golf Course" },
              formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.79049, longitude: -122.45979 }
            },
            {
              id: "places/olympic",
              displayName: { text: "The Olympic Club" },
              formattedAddress: "599 CA-35, San Francisco, CA 94132, USA",
              primaryType: "golf_course",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.70939, longitude: -122.49463 }
            },
            {
              id: "places/monarch",
              displayName: { text: "Monarch Bay Golf Club" },
              formattedAddress: "13800 Monarch Bay Dr, San Leandro, CA 94577, USA",
              primaryType: "golf_course",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.6951, longitude: -122.1856 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/presidio-fitting",
              displayName: { text: "Presidio Club Fitting" },
              formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.79057, longitude: -122.45987 }
            },
            {
              id: "places/general-store",
              displayName: { text: "General Store" },
              formattedAddress: "San Francisco, CA 94129, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.79425, longitude: -122.46874 }
            },
            {
              id: "places/fleming",
              displayName: { text: "Fleming 9 Course" },
              formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.72563, longitude: -122.49106 }
            },
            {
              id: "places/harding",
              displayName: { text: "TPC Harding Park" },
              formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
              primaryType: "golf_course",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.72482, longitude: -122.4932 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            { id: "places/presidio" },
            { id: "places/monarch" },
            { id: "places/fleming" },
            { id: "places/harding" }
          ]
        })
      } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 37.7749,
      longitude: -122.4194,
      radiusMeters: 38624
    });

    expect(courses.map((course) => course.name)).toEqual(
      expect.arrayContaining([
        "Presidio Golf Course",
        "Monarch Bay Golf Club",
        "Fleming 9 Course",
        "TPC Harding Park"
      ])
    );
    expect(courses).toHaveLength(4);
  });
});
