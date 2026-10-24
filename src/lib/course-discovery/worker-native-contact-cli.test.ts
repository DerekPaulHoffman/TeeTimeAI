// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

describe("actual warm CLI native contact forwarding", () => {
  it("executes the CLI's actual callback under tsx, opting in only parsed CPS postal-proof recipes", () => {
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
    expect(text).toContain("executeAccessRecipe(recipe,");
    const script = `const expression=${JSON.stringify(expression)};
      const cases=[{engine:'EXISTING_ADAPTER',adapter:{family:'CPS',officialPostalConflictProof:{kind:'CANONICAL_PHONE_POSTAL_CONFLICT'}}},
        {engine:'EXISTING_ADAPTER',adapter:{family:'CPS'}},
        {engine:'EXISTING_ADAPTER',adapter:{family:'TEEITUP',officialPostalConflictProof:{kind:'OFFICIAL_POSTAL_CONFLICT'}}},
        {engine:'HTTP_JSON'}];
      const seen=[];for(const recipe of cases){const requestLease=()=>{};
        const readNativeOfficialIdentityPage=async(source,url,deadline,options)=>{seen.push({contacts:options.collectPublicCourseContacts===true,lease:options.requestLease===requestLease,source,url,deadline:deadline.toISOString()});return{privatePage:true};};
        const callback=Function('recipe','requestLease','readNativeOfficialIdentityPage','return ('+expression+')')(recipe,requestLease,readNativeOfficialIdentityPage);
        const value=await callback({officialUrl:'https://official.example/'},'https://official.example/',new Date('2030-01-01T00:00:00Z'));
        if(!value.privatePage)throw Error('ACTUAL_WRAPPER_RESULT_LOST');}
      process.stdout.write(JSON.stringify(seen));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    const seen = JSON.parse(child.stdout);
    expect(seen.map((row: { contacts: boolean }) => row.contacts)).toEqual([true, false, false, false]);
    expect(seen.every((row: { lease: boolean; url: string; deadline: string }) => row.lease && row.url === "https://official.example/" && row.deadline === "2030-01-01T00:00:00.000Z")).toBe(true);
  });
});
