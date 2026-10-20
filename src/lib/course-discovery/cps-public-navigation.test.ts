import { describe, expect, it } from "vitest";
import { canonicalCpsPublicUrl, cpsPublicEntryUrl, createCpsPublicSessionScope } from "./cps-public-navigation";
import { isSafeRecipeUrl } from "./recipe";

const entry = 'https://sc.cps.golf/ExampleV3/Home/nIndex?CourseId=1&Time=AnyTime&Player=99&Hole=Any';
const fresh = 'https://sc.cps.golf/ExampleV3/(S(abc123abc123abc123abc123))/Home/nIndex?CourseId=1&Date=2030-10-23&Time=AnyTime&Player=99&Hole=Any';
describe('CPS anonymous public navigation', () => {
  it('drops copied session and stale date only from the exact bounded public entry', () => {
    expect(cpsPublicEntryUrl(fresh.replace('2030-10-23', '2024-10-10'))).toBe(entry);
    expect(canonicalCpsPublicUrl(fresh)).toBe(entry.replace('&Time=', '&Date=2030-10-23&Time='));
    expect(isSafeRecipeUrl(fresh)).toBe(false);
    expect(isSafeRecipeUrl(entry)).toBe(true);
  });
  it.each([
    fresh.replace('https:', 'http:'), fresh.replace('sc.cps.golf', 'sc.cps.golf.evil.example'),
    fresh.replace('/Home/nIndex', '/Account/Login'), fresh + '&slot=123', fresh + '&token=secret',
    fresh.replace('2030-10-23','2030-02-30'), fresh.replace('CourseId=1','CourseId=0'),
    fresh.replace('Time=AnyTime','Time=09:00'), fresh.replace('abc123abc123abc123abc123','short'),
  ])('does not normalize unsafe or unproven entry %s', value => {
    expect(cpsPublicEntryUrl(value)).toBeNull();
  });
  it('accepts a session only from this context’s same-course canonical redirect', () => {
    const scope = createCpsPublicSessionScope([entry]);
    expect(scope.authorize(fresh)).toBe(false);
    expect(scope.authorize(fresh, entry.replace('CourseId=1','CourseId=2'))).toBe(false);
    expect(scope.authorize(fresh.replace('ExampleV3','OtherV3'), entry)).toBe(false);
    expect(scope.authorize(fresh, entry)).toBe(true);
    expect(scope.authorize(fresh.replace('2030-10-23','2030-10-24'))).toBe(true);
    expect(scope.authorize(fresh.replace('CourseId=1','CourseId=2'))).toBe(false);
    expect(scope.authorize(fresh.replace('abc123abc123abc123abc123','def456def456def456def456'))).toBe(false);
    expect(isSafeRecipeUrl(canonicalCpsPublicUrl(fresh.replace('/Home/nIndex','/Account/Login')))).toBe(false);
  });
  it('does not allow malformed session state to enter a persisted recipe', () => {
    expect(isSafeRecipeUrl(fresh.replace('abc123abc123abc123abc123', 'short'))).toBe(false);
    expect(isSafeRecipeUrl(fresh.replace('/(S(', '/%28s%28'))).toBe(false);
  });
});
