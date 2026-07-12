import { describe, expect, it } from "vitest";

import {
  areEquivalentNamedCourses,
  findUniqueGenericCourseMatch,
  haveCompatibleCourseNames,
  isGenericCourseName
} from "./course-identity";

describe("course identity matching", () => {
  it("matches the live Fairview generic label to its only nearby named course", () => {
    const fairview = {
      googlePlaceId: "fairview-farm",
      name: "Fairview Farm Golf Course",
      address: "300 Hill Rd, Harwinton, CT 06791, USA",
      latitude: 41.7470436,
      longitude: -73.07518,
      website: "http://fairviewfarmgc.com/",
      phone: "(860) 689-1000"
    };

    expect(
      findUniqueGenericCourseMatch(
        {
          googlePlaceId: "generic-fairview",
          name: "Golf Course",
          address: "Harwinton, CT 06791, USA",
          latitude: 41.7478038,
          longitude: -73.074469
        },
        [fairview]
      )
    ).toBe(fairview);
  });

  it("keeps an ambiguous generic label near multiple named courses", () => {
    const generic = {
      name: "Golf Course",
      latitude: 40.744,
      longitude: -73.455
    };
    const black = {
      name: "Bethpage Black Golf Course",
      latitude: 40.7445,
      longitude: -73.455
    };
    const red = {
      name: "Bethpage Red Golf Course",
      latitude: 40.7435,
      longitude: -73.455
    };

    expect(findUniqueGenericCourseMatch(generic, [black, red])).toBeUndefined();
  });

  it("uses a unique strong link when several courses are nearby", () => {
    const fairview = {
      name: "Fairview Farm Golf Course",
      latitude: 41.7470436,
      longitude: -73.07518,
      website: "https://fairviewfarmgc.com/"
    };

    expect(
      findUniqueGenericCourseMatch(
        {
          name: "Golf Course",
          latitude: 41.7475,
          longitude: -73.075,
          website: "http://www.fairviewfarmgc.com/"
        },
        [
          fairview,
          {
            name: "Neighboring Municipal Course",
            latitude: 41.7476,
            longitude: -73.075
          }
        ]
      )
    ).toBe(fairview);
  });

  it("keeps a generic course with a conflicting numbered street address", () => {
    expect(
      findUniqueGenericCourseMatch(
        {
          name: "Golf Course",
          address: "10 First St, Example, CT",
          latitude: 41.7475,
          longitude: -73.075
        },
        [
          {
            name: "Named Golf Course",
            address: "20 Second St, Example, CT",
            latitude: 41.7476,
            longitude: -73.075
          }
        ]
      )
    ).toBeUndefined();
  });

  it("preserves distinct courses sharing a venue, address, phone, or domain", () => {
    const bethpageBlack = {
      googlePlaceId: "bethpage-black",
      name: "Bethpage Black Golf Course",
      address: "99 Quaker Meeting House Rd, Farmingdale, NY",
      latitude: 40.744,
      longitude: -73.455,
      website: "https://www.bethpagegolfcourse.com/",
      phone: "(516) 249-0700",
      containingPlaceIds: ["bethpage-state-park"]
    };
    const bethpageRed = {
      googlePlaceId: "bethpage-red",
      name: "Bethpage Red Golf Course",
      address: "99 Quaker Meeting House Rd, Farmingdale, NY",
      latitude: 40.7442,
      longitude: -73.455,
      website: "https://www.bethpagegolfcourse.com/",
      phone: "(516) 249-0700",
      containingPlaceIds: ["bethpage-state-park"]
    };

    expect(areEquivalentNamedCourses(bethpageBlack, bethpageRed)).toBe(false);
    expect(haveCompatibleCourseNames(bethpageBlack.name, bethpageRed.name)).toBe(false);
    expect(haveCompatibleCourseNames("Pinehurst No. 2", "Pinehurst No. 4")).toBe(false);
    expect(
      haveCompatibleCourseNames("Torrey Pines Golf Course", "Torrey Pines South Course")
    ).toBe(false);
  });

  it("still recognizes harmless naming variants and composite facility labels", () => {
    expect(isGenericCourseName("Golf Course")).toBe(true);
    expect(
      haveCompatibleCourseNames(
        "Tashua Knolls & Tashua Glen Golf Course",
        "Tashua Knolls Golf Course"
      )
    ).toBe(true);
    expect(
      areEquivalentNamedCourses(
        {
          name: "Presidio Golf Course",
          latitude: 37.79049,
          longitude: -122.45979
        },
        {
          name: "Presidio Golf",
          latitude: 37.79057,
          longitude: -122.45987
        }
      )
    ).toBe(true);
  });
});
