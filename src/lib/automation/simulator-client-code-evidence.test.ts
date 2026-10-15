import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectSimulatorClientCode, mergeSimulatorClientCodeEvidence } from "./simulator-client-code-evidence";

const url = "https://official.example.test/public.js?ver=1.2";
const inspect = (source: string) => inspectSimulatorClientCode(source, url, "EXTERNAL_SCRIPT");
describe("inert public client-code evidence", () => {
  it("retains call structure, methods, public paths and field names while removing literal data and comments", () => {
    const source = `function getAvailability(date) {
      /* secret@example.test comment-only-private */
      return fetch("/api/public/availability", {method:"POST", headers:{"Content-Type":"application/json", Authorization:"Bearer-private-value"},
        body:JSON.stringify({companyId:"11111111-2222-4333-8444-555555555555", contactEmail:"secret@example.test", phone:2025550123, date, action:"query"})});
    }`;
    const evidence = inspect(source)!;
    expect(evidence).toMatchObject({ version: 1, authority: "EVIDENCE_ONLY", truncated: false, fragments: [{ basis: "API_PATH",
      sourceKind: "EXTERNAL_SCRIPT", sourceUrl: url, sourceSha256: createHash("sha256").update(source).digest("hex") }] });
    const code = evidence.fragments[0].code;
    expect(code).toContain('"/api/public/availability"'); expect(code).toContain('method:"POST"');
    expect(code).toContain("companyId"); expect(code).toContain("Authorization");
    expect(evidence.fragments[0].literalRedactions).toBeGreaterThan(3);
    expect(JSON.stringify(evidence)).not.toMatch(/secret@example|Bearer-private|11111111-2222|2025550123|comment-only-private/u);
    expect(source).toContain("Bearer-private-value");
  });
  it("never evaluates captured source", () => {
    const source = `globalThis.__clientEvidenceExecuted = true; function getAvailability(){return fetch("/api/availability")} getAvailability();`;
    expect(inspect(source)?.fragments).toHaveLength(1);
    expect((globalThis as typeof globalThis & { __clientEvidenceExecuted?: boolean }).__clientEvidenceExecuted).toBeUndefined();
  });
  it("does not convert client names or write methods into permission or monitoring facts", () => {
    const evidence = inspect(`function getAvailability(){return fetch("/api/availability/reserve",{method:"DELETE",action:"reserve"})}`)!;
    expect(evidence.authority).toBe("EVIDENCE_ONLY"); expect(evidence.fragments[0].code).toContain('method:"DELETE"');
    expect(evidence).not.toHaveProperty("readOnly"); expect(evidence).not.toHaveProperty("publicConfiguration");
  });
  it("does not return data-only configuration or unrelated library code", () => {
    expect(inspect(`const BUSINESS={availability:[],client:{email:"secret@example.test",token:"private-token"}};`)).toBeUndefined();
    expect(inspect(`function renderCalendar(){return {email:"secret@example.test"}}`)).toBeUndefined();
  });
  it("keeps structural DOM labels and date formats without permitting value selectors or protocol-shaped secrets", () => {
    const evidence = inspect(`function getAvailability(){const id=document.querySelector("#venueId").value;
      const day=date.format("YYYY-MM-DD");return fetch("/api/availability",{method:"POST",password:"GET",userId:1,
      data:{selector:"input[name='calendarId']",privateSelector:"input[value='private-token']",id,day}})}`)!;
    const code = evidence.fragments[0].code;
    expect(code).toContain('"#venueId"'); expect(code).toContain('"YYYY-MM-DD"'); expect(code).toContain("input[name='calendarId']");
    expect(code).toContain('password:"[REDACTED_LITERAL]"'); expect(code).not.toContain("userId:1");
    expect(code).not.toContain("private-token");
  });
  it("keeps named arrow and object-method request functions inspectable", () => {
    for (const source of [`const getAvailability = date => client.post("/api/availability",{date});`,
      `const api = {getAvailability(date){return client.post("/api/availability",{date})}};`]) {
      expect(inspect(source)?.fragments[0].code).toContain("client.post");
    }
  });
  it("handles a top-level public request without treating it as a complete program", () => {
    expect(inspect(`fetch("/api/availability",{method:"POST"});`)?.fragments[0].code).toBe('fetch("/api/availability",{method:"POST"})');
  });
  it.each(["/api/availability?token=private-token", "https://user:private-pass@api.example.test/availability",
    "https://api.example.test/availability/11111111-2222-4333-8444-555555555555", "https://127.0.0.1/api/availability",
    "/api/availability/private%40example.test"])("redacts unsafe or data-bearing literal reference %s without stripping it into a new route", target => {
      const evidence = inspect(`function getAvailability(){return fetch(${JSON.stringify(target)})}`)!;
      expect(evidence.fragments[0].code).toContain("[REDACTED_LITERAL]");
      expect(evidence.fragments[0].code).not.toContain(target);
    });
  it("redacts template data including an invalid cooked escape", () => {
    const source = 'function getAvailability(id){const key=String.raw`\\unicode-private-token`; return fetch(`/api/availability/${id}?token=private-token`)}';
    const evidence = inspect(source)!;
    expect(JSON.stringify(evidence)).not.toMatch(/private-token|unicode/u);
    expect(evidence.fragments[0].literalRedactions).toBeGreaterThan(0);
  });
  it.each(["https://official.example.test/public.js?token=private-token", "https://official.example.test/public.js?email=secret%40example.test",
    "https://official.example.test/public.js#private-token", "https://user:pass@official.example.test/public.js", "http://localhost/public.js"])(
    "does not echo unsafe source reference %s", source => {
      expect(inspectSimulatorClientCode('function getAvailability(){return fetch("/api/availability")}', source, "EXTERNAL_SCRIPT")).toBeUndefined();
    });
  it("permits the exact already-owned inline booking reference", () => {
    const sourceUrl = "https://official.example.test/booking?owner=12345678&ref=embedded_csp";
    expect(inspectSimulatorClientCode('function getAvailability(){return fetch("/api/availability")}', sourceUrl, "INLINE_SCRIPT")?.fragments[0].sourceUrl).toBe(sourceUrl);
  });
  it("reports source and syntax limits without inventing provider restrictions", () => {
    expect(inspect("availability".repeat(1_600_001))).toMatchObject({ fragments: [], warnings: ["SOURCE_SIZE"], truncated: true });
    expect(inspect("function getAvailability(" )).toMatchObject({ fragments: [], warnings: ["SYNTAX_UNSUPPORTED"] });
    expect(inspect(`function getAvailability(){${"void 0;".repeat(600)}return fetch("/api/availability")}`))
      .toMatchObject({ fragments: [], warnings: ["CONTEXT_SIZE"], truncated: true });
  });
  it("uses independently redacted incomplete token windows when the full AST budget is exhausted", () => {
    const source = `function getAvailability(){return fetch("/api/availability",{privateValue:"private-token"})}` + "0;".repeat(26_000);
    const evidence = inspect(source)!;
    expect(evidence).toMatchObject({ fragments: [{ projection: "TOKEN_WINDOW" }], warnings: ["AST_BUDGET"], truncated: true });
    expect(JSON.stringify(evidence)).not.toContain("private-token");
  });
  it("projects a request and response context from a large already-admitted bundle without evaluating or copying data", () => {
    const source = `/*${"unrelated library ".repeat(100_000)}*/function getAvailability(date){
      const secret="private-token";return fetch("/api/public/availability",{method:"POST",body:JSON.stringify({date,venueId:"private-venue"})})
        .then(response=>response.json()).then(data=>data.availableSlots)};`;
    const evidence = inspect(source)!;
    expect(evidence).toMatchObject({ authority: "EVIDENCE_ONLY", fragments: [{ projection: "TOKEN_WINDOW", basis: "API_PATH" }], truncated: true });
    const code = evidence.fragments[0].code;
    expect(code).toContain('"/api/public/availability"'); expect(code).toContain('"POST"'); expect(code).toContain("availableSlots");
    expect(JSON.stringify(evidence)).not.toMatch(/private-token|private-venue|unrelated library/u);
    expect(evidence.fragments[0].sourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
  });
  it("redacts every token in a large-bundle window including comments, templates, regex, numeric and protocol-shaped secrets", () => {
    const source = `/*${"padding ".repeat(220_000)}*/function getAvailability(){
      const password="GET", privateNumber=12345678, pattern=/private-regex/;
      return fetch("/api/availability",{method:"POST",secret:true,authToken:"POST",apiKey:"POST",nonce:"GET",data:\`private-template\`})}`;
    const evidence = inspect(source)!;
    expect(evidence.fragments[0]).toMatchObject({ projection: "TOKEN_WINDOW" });
    expect(JSON.stringify(evidence)).not.toMatch(/private-regex|12345678|private-template/u);
    expect(evidence.fragments[0].literalRedactions).toBeGreaterThanOrEqual(6);
    expect(evidence.fragments[0].code).toContain('authToken : "[REDACTED_LITERAL]"');
    expect(evidence.fragments[0].code).toContain('password = "[REDACTED_LITERAL]"');
    expect(evidence.fragments[0].code).toContain('apiKey : "[REDACTED_LITERAL]"');
    expect(evidence.fragments[0].code).toContain('nonce : "[REDACTED_LITERAL]"');
  });
  it("finds a request after a large minified library prefix without enlarging output or reading beyond the source cap", () => {
    const source = "void 0;".repeat(250_000) + `function getAvailability(day){return fetch('/api/availability',{method:'POST',day,secret:'private-token'}).then(response=>response.json())}`;
    const evidence = inspect(source)!;
    expect(evidence).toMatchObject({ fragments: [{ projection: "TOKEN_WINDOW", basis: "API_PATH" }], truncated: true });
    expect(evidence.fragments[0].code).toContain("response . json");
    expect(evidence.fragments[0].code.length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(evidence)).not.toContain("private-token");
  });
  it("discards token windows if a later lexical error makes the source unsupported", () => {
    const source = `/*${"padding ".repeat(220_000)}*/function getAvailability(){return fetch('/api/availability')} /*unfinished`;
    expect(inspect(source)).toMatchObject({ fragments: [], warnings: ["SYNTAX_UNSUPPORTED"], truncated: true });
  });
  it("reports a bounded scan without interpreting omitted code or exposing uninspected data", () => {
    const source = `function getAvailability(){return fetch('/api/availability',{secret:'private-token'})}` + "0;".repeat(1_000_100);
    const evidence = inspect(source)!;
    expect(evidence).toMatchObject({ warnings: ["SCAN_BUDGET"], truncated: true });
    expect(JSON.stringify(evidence)).not.toContain("private-token");
    expect(evidence.fragments.every(fragment => fragment.projection === "TOKEN_WINDOW")).toBe(true);
    expect(evidence.fragments.reduce((sum, fragment) => sum + fragment.code.length, 0)).toBeLessThanOrEqual(10_000);
  });
  it("deduplicates and bounds merged contexts deterministically", () => {
    const inputs = Array.from({ length: 8 }, (_, index) => inspect(`function getAvailability${index}(date){return fetch("/api/availability",{date})}`));
    const evidence = mergeSimulatorClientCodeEvidence(...inputs, ...inputs)!;
    expect(evidence.fragments).toHaveLength(8); expect(evidence.truncated).toBe(false);
    expect(evidence.fragments.reduce((total, fragment) => total + fragment.code.length, 0)).toBeLessThanOrEqual(10_000);
    expect(mergeSimulatorClientCodeEvidence(...inputs.reverse())?.fragments).toEqual(evidence.fragments);
  });
  it("gives a later source a context before taking second contexts from one library", () => {
    const library = inspectSimulatorClientCode(Array.from({ length: 6 }, (_, index) =>
      `function getAvailability${index}(){return fetch('/api/availability/library')}`).join(";"), "https://official.example.test/a-library.js", "EXTERNAL_SCRIPT");
    const client = inspectSimulatorClientCode(`function getAvailability(){return fetch('/api/availability/client')}`,
      "https://official.example.test/z-client.js", "EXTERNAL_SCRIPT");
    const evidence = mergeSimulatorClientCodeEvidence(library, client)!;
    expect(evidence.fragments).toHaveLength(7);
    expect(new Set(evidence.fragments.map(fragment => fragment.sourceSha256)).size).toBe(2);
    expect(evidence.fragments.some(fragment => fragment.sourceUrl.endsWith("/z-client.js"))).toBe(true);
    expect(mergeSimulatorClientCodeEvidence(client, library)?.fragments).toEqual(evidence.fragments);
    expect(evidence.candidateSourceHashes).toHaveLength(2);
    expect(evidence.sourceCoverageTruncated).toBe(false);
  });
  it("retains bounded candidate-source coverage through incremental merges", () => {
    let evidence: ReturnType<typeof inspectSimulatorClientCode>;
    for (let index = 0; index < 70; index++) evidence = mergeSimulatorClientCodeEvidence(evidence,
      inspectSimulatorClientCode(`function getAvailability${index}(){return fetch('/api/availability')}`,
        `https://official.example.test/source-${index}.js`, "EXTERNAL_SCRIPT"));
    expect(evidence!.fragments).toHaveLength(16);
    expect(evidence!.candidateSourceHashes).toHaveLength(64);
    expect(evidence!.sourceCoverageTruncated).toBe(true);
    expect(evidence!.truncated).toBe(true);
    expect(evidence!.fragments.reduce((sum, fragment) => sum + fragment.code.length, 0)).toBeLessThanOrEqual(10_000);
    expect(JSON.stringify(evidence)).not.toContain("private-token");
  });
  it("uses duplicate bundle text only once and fills the freed slot with distinct evidence", () => {
    const shared = `function getAvailability(){return fetch('/api/availability/shared')}`;
    const bundle = shared + `;function getCalendar(){return fetch('/api/calendar/extra')}`;
    const first = inspectSimulatorClientCode(bundle, "https://official.example.test/a.js", "EXTERNAL_SCRIPT")!;
    const copy = inspectSimulatorClientCode(bundle + ";void 0;", "https://official.example.test/copy.js", "EXTERNAL_SCRIPT")!;
    const other = ["b", "d"].map(name => inspectSimulatorClientCode(
      `function getAvailability(){return fetch('/api/availability/${name}')}`,
      `https://official.example.test/${name}.js`, "EXTERNAL_SCRIPT")!);
    const evidence = mergeSimulatorClientCodeEvidence(first, other[0], copy, other[1])!;
    expect(evidence.fragments).toHaveLength(4);
    expect(new Set(evidence.fragments.map(fragment => fragment.code)).size).toBe(4);
    expect(evidence.fragments.some(fragment => fragment.code.includes("/api/calendar/extra"))).toBe(true);
    const duplicate = evidence.fragments.find(fragment => fragment.code.includes("/api/availability/shared"))!;
    expect(duplicate.duplicateLocations).toEqual([{ sourceKind: "EXTERNAL_SCRIPT", sourceUrl: "https://official.example.test/copy.js",
      sourceSha256: copy.fragments[0].sourceSha256, range: first.fragments[0].range }]);
    expect(evidence.candidateSourceHashes).toHaveLength(4);
    expect(mergeSimulatorClientCodeEvidence(other[1], copy, other[0], first)).toEqual(evidence);
    const incremental = [first, other[0], copy, other[1]].reduce((previous, value) => mergeSimulatorClientCodeEvidence(previous, value), undefined as ReturnType<typeof inspect>);
    expect(incremental).toEqual(evidence);
    expect(mergeSimulatorClientCodeEvidence(evidence, copy)).toEqual(evidence);
  });
  it("bounds duplicate attribution while retaining all candidate hashes and the incomplete marker", () => {
    const sources = Array.from({ length: 12 }, (_, index) => inspectSimulatorClientCode(
      `function getAvailability(){return fetch('/api/availability')}\n// private-copy-${index}`,
      `https://official.example.test/copy-${index}.js`, "EXTERNAL_SCRIPT")!);
    const evidence = mergeSimulatorClientCodeEvidence(...sources)!;
    expect(evidence.fragments).toHaveLength(1);
    expect(evidence.fragments[0].duplicateLocations).toHaveLength(8);
    expect(evidence.fragments[0].duplicateLocationsTruncated).toBe(true);
    expect(evidence.candidateSourceHashes).toHaveLength(12);
    expect(evidence.truncated).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("private-copy");
    expect(mergeSimulatorClientCodeEvidence(...sources.reverse())).toEqual(evidence);
  });
  it("does not collapse a complete scope with identical text from an incomplete token window", () => {
    const complete = inspect(`function getAvailability(){return fetch('/api/availability')}`)!;
    const incomplete = { ...complete, truncated: true, fragments: complete.fragments.map(fragment => ({
      ...fragment, sourceUrl: "https://official.example.test/window.js", projection: "TOKEN_WINDOW" as const,
    })) };
    const evidence = mergeSimulatorClientCodeEvidence(complete, incomplete)!;
    expect(evidence.fragments).toHaveLength(2);
    expect(evidence.fragments.every(fragment => !fragment.duplicateLocations)).toBe(true);
    expect(evidence.truncated).toBe(true);
  });
  it("uses the existing text budget for more than four short request contexts from one source", () => {
    const source = Array.from({ length: 12 }, (_, index) =>
      `function getAvailability${index}(date){return fetch('/api/availability/route-${index}',{date,secret:'private-token'})}`).join(";");
    const evidence = inspect(source)!;
    expect(evidence.fragments).toHaveLength(12);
    expect(evidence.fragments.reduce((sum, fragment) => sum + fragment.code.length, 0)).toBeLessThanOrEqual(10_000);
    expect(evidence.truncated).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain("private-token");
  });
  it("still bounds a large number of small excerpts and never exceeds the total character budget", () => {
    const small = inspect(Array.from({ length: 24 }, (_, index) =>
      `function getAvailability${index}(){return fetch('/api/availability/route-${index}')}`).join(";"))!;
    expect(small.fragments).toHaveLength(16); expect(small.truncated).toBe(true);
    const large = inspect(Array.from({ length: 24 }, (_, index) =>
      `function getAvailability${index}(){${"void 0;".repeat(240)}return fetch('/api/availability/route-${index}')}`).join(";"))!;
    expect(large.fragments.length).toBeGreaterThan(4);
    expect(large.fragments.reduce((sum, fragment) => sum + fragment.code.length, 0)).toBeLessThanOrEqual(10_000);
    expect(large.fragments.every(fragment => fragment.code.length <= 4_000)).toBe(true);
    expect(large.truncated).toBe(true);
  });
});
