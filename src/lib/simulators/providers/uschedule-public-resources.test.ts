import { describe, expect, it } from "vitest";
import { matchesUSchedulePublicResourceSelection, readUSchedulePublicResourcePool, uschedulePublicResourcePoolProofSchema, hasUSchedulePublicEmptyResult } from "./uschedule-public-resources";
const html = (selected = "7", any = false) => `<section id="res_section"><label for="resource5">Simulators</label><select id="resource5" class="resSelect">${any ? '<option value="-1">Any Available</option>' : ""}<option value="7" ${selected === "7" ? "selected" : ""}>Simulator Bay Public</option><option value="8" ${selected === "8" ? "selected" : ""}>Simulator Bay Private</option></select></section>`;
describe("public simulator resource catalog", () => {
  it("accepts only an explicit visible empty result without conflicting inventory or continuation", () => {
    const empty = '<div class="choices no_times_avail pt-3 px-3"><p>Sorry, there are no times available for the selected criteria.</p></div>';
    expect(hasUSchedulePublicEmptyResult(empty)).toBe(true);
    for (const value of [empty.replace("no_times_avail", ""), empty.replace("criteria.", "criteria maybe."), `<div hidden>${empty}</div>`, empty + empty,
      empty + '<div class="next_avail_results"></div>', empty + '<div class="timeslot"></div>', empty + '<a id="more_next_avail">More</a>',
      empty.replace('<p>', '<p onclick="book()">'), empty.replace('<p>', '<p><span>')]) expect(hasUSchedulePublicEmptyResult(value)).toBe(false);
  });
  it("binds both visible physical resources, independently of the current selection", () => {
    const a = readUSchedulePublicResourcePool(html())!, b = readUSchedulePublicResourcePool(html("8"))!;
    expect(a.proof.resources).toEqual([{ id: "7", label: "Simulator Bay Public" }, { id: "8", label: "Simulator Bay Private" }]);
    expect(a.proof.catalogHash).toBe(b.proof.catalogHash); expect(a.selectedResourceId).toBe("7");
    expect(matchesUSchedulePublicResourceSelection(html("8"), { pool: a.proof, resourceId: "8" })).toBe(true);
    expect(matchesUSchedulePublicResourceSelection(html(), { pool: a.proof, resourceId: "8" })).toBe(false);
    expect(matchesUSchedulePublicResourceSelection(html(), { pool: a.proof, resourceId: "99" })).toBe(false);
    expect(readUSchedulePublicResourcePool(html("7", true))!.proof.catalogHash).not.toBe(a.proof.catalogHash);
  });
  it.each([
    (s: string) => s.replace('id="resource5"', 'id="unowned"'), (s: string) => s.replace('id="res_section"', 'id="other"'),
    (s: string) => s.replace("Simulators", "Add-ons"), (s: string) => s.replace('class="resSelect"', 'class="resSelect" disabled'),
    (s: string) => `<div hidden>${s}</div>`, (s: string) => s.replace("Simulator Bay Private", "Members Only Bay"),
    (s: string) => s.replace('value="8"', 'value="7"'), (s: string) => s.replace('value="8"', 'value="0"'),
    (s: string) => s.replace('value="8"', 'value="8" selected'), (s: string) => s.replace('selected', ''),
    (s: string) => s + s, (s: string) => s.replace('value="8"', 'onclick="reserve()" value="8"'),
    (s: string) => s.replace("Simulator Bay Private", "<script>reserve()</script>Simulator Bay Private"),
  ])("rejects ambiguous, hidden, restricted and unowned controls", mutate => { expect(readUSchedulePublicResourcePool(mutate(html()))).toBeUndefined(); });
  it("rejects edited immutable proof and changed labels or catalog", () => {
    const pool = readUSchedulePublicResourcePool(html())!.proof;
    expect(uschedulePublicResourcePoolProofSchema.safeParse({ ...pool, catalogHash: "a".repeat(64) }).success).toBe(false);
    expect(matchesUSchedulePublicResourceSelection(html().replace("Simulator Bay Public", "Different Bay"), { pool, resourceId: "7" })).toBe(false);
  });
});
