// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

describe("actual warm CLI native contact forwarding", () => {
  it.each([
    { name: "current private context", trustedContext: { canonicalCoursePhone: "+19165554653" } },
    { name: "legacy undefined context", trustedContext: undefined },
  ])("executes the CLI's actual callback under tsx with $name, opting in only parsed CPS postal-proof recipes", ({ trustedContext }) => {
    const path = resolve("scripts/automation/course-discovery-browser.ts");
    const text = readFileSync(path, "utf8"), tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const callbacks: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "readNativeOfficialPage" && ts.isArrowFunction(node.initializer)) callbacks.push(node.initializer.getText(tree));
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(callbacks).toHaveLength(1);
    // This expression is taken from production source, rather than a mirrored
    // test callback. The real helper runtime must serialize no module helper.
    const expression = ts.transpile(callbacks[0], { target: ts.ScriptTarget.ES2022 }).trim().replace(/;$/u, "");
    expect(text).toContain("const recipe = parseAccessRecipe(value.recipe)");
    expect(text).toContain("const trustedContext = discoveryTrustedContextSchema.optional().parse(value.trustedContext)");
    expect(text).toContain("executeAccessRecipe(recipe,");
    const script = `const expression=${JSON.stringify(expression)},trustedContext=${JSON.stringify(trustedContext) ?? "undefined"};
      const cases=[
        {recipe:{engine:'EXISTING_ADAPTER',adapter:{family:'CPS',officialPostalConflictProof:{kind:'CANONICAL_PHONE_POSTAL_CONFLICT'}}},mode:'POSTAL'},
        {recipe:{engine:'EXISTING_ADAPTER',adapter:{family:'CPS',officialPhoneBookingProof:{kind:'OFFICIAL_PHONE_BOOKING_LINK'}}},mode:'PHONE_LINK'},
        {recipe:{engine:'EXISTING_ADAPTER',adapter:{family:'CPS',officialPhoneBookingProof:{kind:'OFFICIAL_PHONE_BOOKING_LINK'}}},mode:'POSTAL'},
        {recipe:{engine:'EXISTING_ADAPTER',adapter:{family:'CPS'}},mode:'PHONE_LINK'},
        {recipe:{engine:'EXISTING_ADAPTER',adapter:{family:'TEEITUP',officialPhoneBookingProof:{kind:'OFFICIAL_PHONE_BOOKING_LINK'}}},mode:'PHONE_LINK'},
        {recipe:{engine:'HTTP_JSON'},mode:'PHONE_LINK'}];
      const seen=[];for(const {recipe,mode} of cases){const requestLease=()=>{},before=JSON.stringify(trustedContext);
        const readNativeOfficialIdentityPage=async(source,url,deadline,options)=>{seen.push({contacts:options.collectPublicCourseContacts===true,phoneBooking:options.allowCpsPhoneBookingContact===true,lease:options.requestLease===requestLease,trustedContextForwarded:options.trustedContext===trustedContext,privateContextPresent:options.trustedContext!==undefined,source,url,deadline:deadline.toISOString()});return{privatePage:true};};
        const callback=Function('recipe','requestLease','trustedContext','readNativeOfficialIdentityPage','return ('+expression+')')(recipe,requestLease,trustedContext,readNativeOfficialIdentityPage);
        const value=await callback({officialUrl:'https://official.example/'},'https://official.example/',new Date('2030-01-01T00:00:00Z'),mode);
        if(!value.privatePage)throw Error('ACTUAL_WRAPPER_RESULT_LOST');if(JSON.stringify(trustedContext)!==before)throw Error('PRIVATE_CONTEXT_MUTATED');}
      process.stdout.write(JSON.stringify(seen));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    const seen = JSON.parse(child.stdout);
    expect(seen.map((row: { contacts: boolean }) => row.contacts)).toEqual([true, true, true, false, false, false]);
    expect(seen.map((row: { phoneBooking: boolean }) => row.phoneBooking)).toEqual([false, true, false, false, false, false]);
    expect(seen.every((row: { trustedContextForwarded: boolean; privateContextPresent: boolean }) => row.trustedContextForwarded && row.privateContextPresent === (trustedContext !== undefined))).toBe(true);
    expect(seen.every((row: { lease: boolean; url: string; deadline: string }) => row.lease && row.url === "https://official.example/" && row.deadline === "2030-01-01T00:00:00.000Z")).toBe(true);
  });
});
