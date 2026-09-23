import { describe, expect, it } from "vitest";

import {
  selectUniqueNearbyOfficialCourse,
  type GenericCourseLocation,
  type NearbyOfficialCourse,
} from "./generic-course-nearby-source";

const generic: GenericCourseLocation = {
  name: "Golf Course",
  googlePlaceId: "generic-feature",
  address: "Madison, IL 62201, USA",
  city: "Madison",
  stateCode: "IL",
  latitude: 38.65945,
  longitude: -90.14365,
  website: null,
  isPublic: true,
};
const feature: NearbyOfficialCourse = {
  googlePlaceId: "generic-feature",
  name: "Golf Course",
  address: generic.address,
  city: generic.city,
  stateCode: generic.stateCode,
  latitude: generic.latitude,
  longitude: generic.longitude,
  website: null,
};
const named: NearbyOfficialCourse = {
  googlePlaceId: "named-course",
  name: "Gateway National Golf Links",
  address: "18 Golf Drive, Madison, IL 62060, USA",
  city: "Madison",
  stateCode: "IL",
  latitude: 38.65966,
  longitude: -90.13945,
  website: "https://gateway.example/",
};

describe("generic course nearby source selection", () => {
  it("selects one named public course near a generic fairway point despite differing postal zones", () => {
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, named]))
      .toMatchObject({ candidate: named });
  });

  it("uses the postal zone only when the generic feature has no city", () => {
    const withoutCity = { ...generic, address: "Illinois 62236, USA", city: null };
    const matching = { ...named, name: "Columbia Bridges",
      address: "1655 Course Road, Columbia, IL 62236, USA", city: "Columbia" };
    expect(selectUniqueNearbyOfficialCourse(withoutCity, [feature, matching]))
      .toMatchObject({ candidate: matching });
    expect(selectUniqueNearbyOfficialCourse(withoutCity, [feature, named])).toBeNull();
  });

  it("rejects adjacent distinct courses instead of guessing from proximity", () => {
    const other = { ...named, googlePlaceId: "other-course", name: "River Lakes Golf Course",
      latitude: 38.6601, longitude: -90.1401, website: "https://river.example/" };
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, named, other])).toBeNull();
  });

  it("requires the exact generic feature, an explicit named course, and a safe public site", () => {
    expect(selectUniqueNearbyOfficialCourse(generic, [named])).toBeNull();
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, { ...named, name: "Golf Club" }]))
      .toBeNull();
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, { ...named, website: "http://gateway.example/" }]))
      .toBeNull();
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, { ...named, address: "Madison, IL 62060" }]))
      .toBeNull();
  });

  it("preserves an existing official hostname and rejects changed locality", () => {
    expect(selectUniqueNearbyOfficialCourse(
      { ...generic, website: "https://another.example/" }, [feature, named],
    )).toBeNull();
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, { ...named, city: "Columbia" }]))
      .toBeNull();
    expect(selectUniqueNearbyOfficialCourse(generic, [feature, { ...named, stateCode: "MO" }]))
      .toBeNull();
  });

  it("does not promote a generic feature that is private or has no exact provider identity", () => {
    expect(selectUniqueNearbyOfficialCourse({ ...generic, isPublic: false }, [feature, named]))
      .toBeNull();
    expect(selectUniqueNearbyOfficialCourse({ ...generic, googlePlaceId: null }, [feature, named]))
      .toBeNull();
  });
});
