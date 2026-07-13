import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dedupeGolfCoursePlaces,
  filterPublicGolfCoursePlaces,
  getGooglePlacesApiKey,
  mapGooglePlaceToCourseCandidate,
  searchGolfCoursesByName,
  searchNearbyGolfCourses,
  type GooglePlace
} from "./google";

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

    expect(courses).toEqual([
      expect.objectContaining({
        googlePlaceId: "ChIJHRdhRQt16IkRnZxbawELtdM",
        name: "Grassy Hill Country Club",
        distanceMeters: expect.any(Number)
      })
    ]);
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
          "X-Goog-FieldMask": expect.stringContaining("places.primaryType")
        }),
        body: expect.stringContaining('"includedPrimaryTypes":["golf_course"]')
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
          "X-Goog-FieldMask": expect.stringContaining("places.displayName")
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
