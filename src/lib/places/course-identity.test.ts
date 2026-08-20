import { describe, expect, it } from "vitest";

import {
  areEquivalentNamedCourses,
  findUniqueGenericCourseMatch,
  haveCompatibleCourseNames,
  haveCompatibleOfficialPageCourseNames,
  haveCompatibleOfficialPageCourseNamesWithVerifiedLayout,
  haveSameOfficialCourseIdentityCore,
  hasConflictingOfficialCourseIdentityDiscriminator,
  isConflictingOfficialPageCourseIdentity,
  isExplicitCourseIdentityName,
  isGenericCourseName,
  isOfficialOrganizationIdentityCorroboratedByUrl
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

  it("matches a live official course name that omits only one-sided leading initials", () => {
    expect(
      haveCompatibleOfficialPageCourseNames(
        "A.H. Blank Golf Course",
        "Blank Golf Course"
      )
    ).toBe(true);
    expect(
      haveCompatibleOfficialPageCourseNames(
        "Blank Golf Course",
        "A. H. Blank Golf Course"
      )
    ).toBe(true);
    expect(
      haveCompatibleOfficialPageCourseNames(
        "A.H. Blank Golf Course",
        "a h blank golf course"
      )
    ).toBe(true);
});

  it("matches a one-sided municipal descriptor before the same golf-course name", () => {
    expect(
      haveCompatibleOfficialPageCourseNames(
        "Frear Park Municipal Golf Course",
        "Frear Park Golf Course"
      )
    ).toBe(true);
    expect(
      haveCompatibleOfficialPageCourseNames(
        "Rock Creek Park Golf",
        "Rock Creek Park Golf Course"
      )
    ).toBe(true);
  });

  it("accepts a one-sided layout qualifier only when that physical layout is verified", () => {
    expect(
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        "Aguila Golf Course",
        "Aguila 18 Golf Course",
        [18]
      )
    ).toBe(true);
    expect(
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        "Aguila Golf Course",
        "Aguila 18 Golf Courses",
        [18]
      )
    ).toBe(true);
    expect(
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        "Aguila Golf Course",
        "Aguila 9 Golf Course",
        [18]
      )
    ).toBe(false);
    expect(
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        "Aguila Golf Course",
        "Aguila 18 Golf Course",
        []
      )
    ).toBe(false);
    expect(
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        "Aguila Golf Course",
        "Aguila 18 Golf Courses",
        []
      )
    ).toBe(false);
    expect(
      haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
        "Aguila 9 Golf Course",
        "Aguila 18 Golf Course",
        [18]
      )
    ).toBe(false);
  });

  it("rejects conflicting initials and non-exact initial-free remainders", () => {
    expect(
      haveCompatibleOfficialPageCourseNames(
        "A.H. Blank Golf Course",
        "B.H. Blank Golf Course"
      )
    ).toBe(false);
    expect(
      haveSameOfficialCourseIdentityCore(
        "A.H. Blank Golf Course",
        "B H Blank Golf Course"
      )
    ).toBe(false);
    expect(
      haveSameOfficialCourseIdentityCore(
        "A.H. Blank Golf Course",
        "Blank Golf Course"
      )
    ).toBe(true);
    expect(
      haveCompatibleOfficialPageCourseNames(
        "A.H. Blank Golf Course",
        "Blank Park Golf Course"
      )
    ).toBe(false);
    expect(
      haveCompatibleOfficialPageCourseNames(
        "A.H. Blank Golf Course",
        "Blank Golf Club"
      )
    ).toBe(false);
  });

  it("treats singular municipal courses and one-token sibling names as conflicts", () => {
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "Cave Creek Municipal Golf Course"
      )
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity("Aguila Golf Course", "Papago")
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "Phoenix Golf Courses"
      )
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "City of Phoenix"
      )
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "Aguila 9 Golf Courses"
      )
    ).toBe(true);
  });

  it("does not treat a numbered sibling as an official-page name variant", () => {
    expect(
      haveCompatibleOfficialPageCourseNames(
        "Aguila Golf Course",
        "Aguila 9 Golf Course"
      )
    ).toBe(false);
    expect(
      haveCompatibleOfficialPageCourseNames(
        "Blank Golf Course",
        "Blank Park Golf Course"
      )
    ).toBe(false);
  });

  it("distinguishes explicit course identities from generic facility headings", () => {
    expect(isExplicitCourseIdentityName("Aguila 9 Golf Course")).toBe(true);
    expect(isExplicitCourseIdentityName("Pine Hills Executive Golf Club")).toBe(
      true
    );
    expect(isExplicitCourseIdentityName("City of Phoenix Golf")).toBe(false);
    expect(isExplicitCourseIdentityName("Phoenix Golf Courses")).toBe(false);
    expect(isExplicitCourseIdentityName("Golf Course")).toBe(false);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Arthur B. Sim Golf Course",
        "Facilities"
      )
    ).toBe(false);
  });

  it("detects abbreviated sibling identities without treating site brands as courses", () => {
    expect(
      isConflictingOfficialPageCourseIdentity("Aguila Golf Course", "Aguila 9")
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Pine Hills Golf Course",
        "Pine Hills Executive"
      )
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "City of Phoenix Golf"
      )
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "Phoenix Golf Courses"
      )
    ).toBe(true);
    expect(
      isConflictingOfficialPageCourseIdentity(
        "Aguila Golf Course",
        "Cave Creek"
      )
    ).toBe(true);
    expect(
      hasConflictingOfficialCourseIdentityDiscriminator(
        "Winter Park Golf Course",
        "Winter Park Country Club"
      )
    ).toBe(false);
  });

  it("requires official-origin corroboration before treating organization branding as neutral", () => {
    const officialUrl =
      "https://www.phoenix.gov/parks/golf/aguila-golf-course.html";

    expect(
      isOfficialOrganizationIdentityCorroboratedByUrl(
        "City of Phoenix",
        officialUrl
      )
    ).toBe(true);
    expect(
      isOfficialOrganizationIdentityCorroboratedByUrl(
        "Phoenix Golf Courses",
        officialUrl
      )
    ).toBe(true);
    expect(
      isOfficialOrganizationIdentityCorroboratedByUrl(
        "Papago City Golf Courses",
        officialUrl
      )
    ).toBe(false);
    expect(
      isOfficialOrganizationIdentityCorroboratedByUrl(
        "City of Papago Golf Courses",
        officialUrl
      )
    ).toBe(false);
  });

  it.each([
    ["Pine Hills Golf Course", "Pine Hills Executive Golf Course"],
    ["Bay Hill Golf Course", "Bay Hill Lakes Golf Course"]
  ])(
    "does not treat %s and %s as the same official page",
    (target, sibling) => {
      expect(haveCompatibleOfficialPageCourseNames(target, sibling)).toBe(
        false
      );
      expect(haveCompatibleOfficialPageCourseNames(sibling, target)).toBe(
        false
      );
    }
  );
});
