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
    expect(inspect("availability".repeat(150_001))).toMatchObject({ fragments: [], warnings: ["SOURCE_SIZE"], truncated: true });
    expect(inspect("function getAvailability(" )).toMatchObject({ fragments: [], warnings: ["SYNTAX_UNSUPPORTED"] });
    expect(inspect(`function getAvailability(){${"void 0;".repeat(600)}return fetch("/api/availability")}`))
      .toMatchObject({ fragments: [], warnings: ["CONTEXT_SIZE"], truncated: true });
  });
  it("discards every excerpt when the AST walk did not inspect every literal", () => {
    const source = `function getAvailability(){return fetch("/api/availability",{privateValue:"private-token"})}` + "0;".repeat(26_000);
    expect(inspect(source)).toMatchObject({ fragments: [], warnings: ["AST_BUDGET"], truncated: true });
  });
  it("deduplicates and bounds merged contexts deterministically", () => {
    const inputs = Array.from({ length: 8 }, (_, index) => inspect(`function getAvailability${index}(date){return fetch("/api/availability",{date})}`));
    const evidence = mergeSimulatorClientCodeEvidence(...inputs, ...inputs)!;
    expect(evidence.fragments).toHaveLength(4); expect(evidence.truncated).toBe(true);
    expect(evidence.fragments.reduce((total, fragment) => total + fragment.code.length, 0)).toBeLessThanOrEqual(10_000);
    expect(mergeSimulatorClientCodeEvidence(...inputs.reverse())?.fragments).toEqual(evidence.fragments);
  });
});
