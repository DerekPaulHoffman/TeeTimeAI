// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { compactDiscoveryRecipeSchema, discoveryPromptInstructions, selectDiscoveryRecipeSchema } from "../../../scripts/automation/course-discovery-prompt-schema.mjs";
import { DISCOVERY_TOOLS, discoveryRecipeGuidance } from "../../../scripts/automation/course-discovery-worker.mjs";

const modern = () => new Ajv2020({ strict: false, validateFormats: false, logger: false, code: { optimize: 0 } });
const freeze = (value: unknown): unknown => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const repeated = () => ({ type: "string", minLength: 3, maxLength: 50, pattern: "^[a-z]+$", description: "Public display text only", title: "Display" });
const repeatedSchema = () => ({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
  properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, repeated()])), additionalProperties: false });

describe("model-facing schema compaction", () => {
  it.each([true, false])("keeps boolean assertion %j", value => expect(compactDiscoveryRecipeSchema(value)).toBe(value));
  it("deduplicates actual schema subtrees with valid local definitions without mutating input", () => {
    const original = repeatedSchema(), before = JSON.stringify(original); freeze(original);
    const compact = compactDiscoveryRecipeSchema(original);
    expect(JSON.stringify(original)).toBe(before); expect(compact).not.toBe(original);
    expect(compact.$schema).toBe(original.$schema); expect(Object.keys(compact.$defs)).toHaveLength(1);
    expect(compact.properties.field0).toEqual({ $ref: "#/$defs/c0" });
    expect(compact.$defs.c0).toEqual({ type: "string", minLength: 3, maxLength: 50, pattern: "^[a-z]+$" });
    expect(JSON.stringify(compactDiscoveryRecipeSchema(original))).toBe(JSON.stringify(compact));
    expect(modern().validateSchema(compact)).toBe(true); expect(size(compact)).toBeLessThan(size(original));
  });
  it("preserves JSON literal objects and property keys that happen to name schema annotations", () => {
    const literal = { description: "actual data", title: "actual title", examples: [{ $id: "literal-only", $ref: "not-a-reference" }], default: { description: "nested data" } };
    const original = { type: "object", description: "drop annotation", title: "drop title", examples: [literal], $comment: "drop comment",
      properties: { description: { const: literal, default: literal, description: "drop child annotation" }, title: { enum: [literal] },
        examples: { type: "array", items: { const: literal } }, default: { const: { description: { type: "literal" } } } } };
    const before = JSON.stringify(original), compact = compactDiscoveryRecipeSchema(original);
    expect(compact).not.toHaveProperty("description"); expect(compact).not.toHaveProperty("examples"); expect(compact).not.toHaveProperty("$comment");
    expect(compact.properties.description.const).toEqual(literal); expect(compact.properties.description.default).toEqual(literal);
    expect(compact.properties.title.enum).toEqual([literal]); expect(compact.properties.examples.items.const).toEqual(literal);
    expect(compact.properties.default.const).toEqual({ description: { type: "literal" } }); expect(JSON.stringify(original)).toBe(before);
    const validateOriginal = modern().compile(original), validateCompact = modern().compile(compact);
    for (const value of [{ description: literal, title: literal, examples: [literal] }, { description: { ...literal, title: "wrong" } }, { default: { description: { type: "literal" } } }])
      expect(validateCompact(value)).toBe(validateOriginal(value));
  });
  it("keeps boolean children, tuple items, schema maps, string dependencies and escaped property names in their own grammar", () => {
    const original = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {
      "a/b~description": { type: "array", items: [true, false], additionalItems: false }, title: true, description: false,
      nested: { type: "object", properties: { a: repeated(), b: repeated(), c: repeated(), d: repeated() }, dependencies: { a: ["b"], b: { required: ["c"] } } } },
      patternProperties: { "^extra": { type: "integer" } }, additionalProperties: false };
    const compact = compactDiscoveryRecipeSchema(original), validateOriginal = new Ajv({ strict: false, logger: false }).compile(original), validateCompact = new Ajv({ strict: false, logger: false }).compile(compact);
    for (const value of [{}, { "a/b~description": [1] }, { "a/b~description": [1, 2] }, { description: 1 }, { nested: { a: "abc" } },
      { nested: { a: "abc", b: "def", c: "ghi" } }, { extra: 1 }, { extra: "wrong" }, { unknown: 1 }]) expect(validateCompact(value)).toBe(validateOriginal(value));
    expect(compact.properties.title).toBe(true); expect(compact.properties.description).toBe(false);
    expect(compact.properties.nested.dependencies.a).toEqual(["b"]);
  });
  it("preserves combinator, conditional and unevaluated assertion semantics through references", () => {
    const shared = { type: "object", properties: { public: { const: true }, count: { type: "integer", minimum: 1 } }, required: ["public"] };
    const original = { $schema: "https://json-schema.org/draft/2020-12/schema", allOf: [shared, shared, shared, shared],
      if: { required: ["count"] }, then: { properties: { count: { maximum: 5 } } }, else: { properties: { absent: false } }, unevaluatedProperties: false };
    const compact = compactDiscoveryRecipeSchema(original), left = modern().compile(original), right = modern().compile(compact);
    expect(compact.$defs).toBeDefined();
    for (const value of [{ public: true }, { public: true, count: 3 }, { public: true, count: 6 }, { public: true, extra: 1 }, { public: false }, {}, null]) expect(right(value)).toBe(left(value));
  });
  it.each([
    { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { item: { type: "string", description: "target remains" } }, $ref: "#/$defs/item" },
    { $schema: "http://json-schema.org/draft-07/schema#", definitions: { item: { type: "string" } }, $ref: "#/definitions/item", type: "integer" },
    { $id: "https://schema-fixture.example/root", properties: { nested: { $id: "child", type: "string" } }, description: "retain" },
    { $anchor: "root", description: "retain" }, { $dynamicRef: "#node", description: "retain" }, { $recursiveRef: "#", description: "retain" },
    { $vocabulary: { "https://vocabulary-fixture.example/strict": true }, description: "retain" },
    { $schema: "https://dialect-fixture.example/custom", description: "retain" }, { properties: { value: { $schema: "http://json-schema.org/draft-07/schema#" } }, description: "retain" },
    { customAssertion: { description: "not known to be a schema" }, description: "retain" },
  ])("returns an unchanged independent clone when reference or dialect scope cannot be relocated safely (%j)", original => {
    const compact = compactDiscoveryRecipeSchema(original); expect(compact).toEqual(original); expect(compact).not.toBe(original);
  });
  it("does not overwrite existing definition names", () => {
    const original = { ...repeatedSchema(), $defs: { c0: { const: "existing" } } }, compact = compactDiscoveryRecipeSchema(original);
    expect(compact.$defs.c0).toEqual({ const: "existing" }); expect(compact.properties.field0.$ref).not.toBe("#/$defs/c0");
    expect(modern().validateSchema(compact)).toBe(true);
  });
  it("does not expand schemas when references cost more than the repeated literals", () => {
    const original = { properties: { a: { type: "string" }, b: { type: "string" } } };
    expect(compactDiscoveryRecipeSchema(original)).toEqual(original);
  });
  it("bounds cyclic, non-JSON, oversized and deeply nested inputs without invoking getters", () => {
    const cycle: Record<string, unknown> = {}; cycle.properties = cycle;
    const getter = Object.defineProperty({}, "description", { enumerable: true, get: () => { throw Error("GETTER_EXECUTED"); } });
    let deep: unknown = true; for (let depth = 0; depth < 140; depth++) deep = { not: deep };
    const overridden = Object.assign([], { map: () => { throw Error("CUSTOM_ARRAY_METHOD_EXECUTED"); } });
    for (const value of [null, [], "not-a-schema", cycle, getter, { default: undefined }, { const: Infinity }, { default: Array(2) }, { default: overridden }, { description: "a".repeat(2_000_001) }, deep])
      expect(() => compactDiscoveryRecipeSchema(value)).toThrow("DISCOVERY_PROMPT_SCHEMA_INVALID");
  });
  it("falls back unchanged before deeply repeated large fingerprints can amplify memory", () => {
    let nested: unknown = { const: "x".repeat(700_000) };
    for (let depth = 0; depth < 30; depth++) nested = { not: nested };
    const original = { ...(nested as Record<string, unknown>), description: "retained on bounded fallback" };
    expect(compactDiscoveryRecipeSchema(original)).toEqual(original);
  });
});

describe("the actual CLI-generated recipe schema", () => {
  it("retains actual validation decisions while reducing the model-facing JSON to at most one third", () => {
    const serialized = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/automation/course-discovery-browser.ts", "--recipe-schema"], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 3_000_000,
    });
    const original = JSON.parse(serialized), before = JSON.stringify(original); freeze(original);
    const compact = compactDiscoveryRecipeSchema(original);
    expect(JSON.stringify(original)).toBe(before); expect(size(compact)).toBeLessThanOrEqual(size(original) / 3);
    expect(Object.keys(compact.$defs).length).toBeGreaterThan(0);
    const left = modern().compile(original), right = modern().compile(compact);
    const source = { officialUrl: "https://recipe-fixture.example/golf", bookingUrl: "https://recipe-fixture.example/tee-times", venueName: "Recipe Fixture Golf",
      providerFamily: "EXAMPLE", timeZone: "America/New_York" };
    const http = { schemaVersion: 1, engine: "HTTP_JSON", target: { courseId: "fixture-course", kind: "OUTDOOR" }, source,
      permittedRoutes: [{ origin: "https://recipe-fixture.example", path: "/api/availability", methods: ["GET"], queryKeys: ["date", "players"] }],
      request: { url: "https://recipe-fixture.example/api/availability?date={{date}}&players={{players}}", method: "GET" },
      proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" }, players: { path: "players" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "capacity" }, holes: { path: "holes" } } };
    const adapter = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: http.target,
      source: { ...source, officialUrl: "https://recipe-fixture.teesnap.net/", bookingUrl: "https://recipe-fixture.teesnap.net/", providerFamily: "TEESNAP" },
      adapter: { family: "TEESNAP", tenant: "recipe-fixture", courseId: 731, defaultHoles: 18, defaultAddons: "off", timeZone: "America/New_York", catalogHash: "a".repeat(64) } };
    expect(left(http)).toBe(true); expect(left(adapter)).toBe(true);
    const cases: unknown[] = [http, adapter, {}, null, true, [], { ...http, engine: "UNSAFE_ENGINE" }, { ...http, schemaVersion: 2 },
      { ...http, unexpected: "extra authority" }, { ...adapter, adapter: { ...adapter.adapter, defaultHoles: 9 } },
      { ...adapter, adapter: { ...adapter.adapter, tenant: "unrelated.host" } }, { ...adapter, adapter: { family: "UNSUPPORTED" } }];
    for (const key of Object.keys(http)) { const missing = structuredClone(http) as Record<string, unknown>; delete missing[key]; cases.push(missing); }
    for (const value of ["", 0, false, {}, [], null]) for (const key of ["target", "source", "proof", "request", "slots", "permittedRoutes"]) cases.push({ ...http, [key]: value });
    for (const value of cases) expect(right(value), JSON.stringify(value)).toBe(left(value));
    expect(JSON.stringify(compactDiscoveryRecipeSchema(original))).toBe(JSON.stringify(compact));
    const originalSchema = original as { oneOf: Array<{ properties?: { adapter?: { oneOf: Array<{ properties: { family: { const: string } } }> } } }> };
    const selections: Array<{ engine: string; family?: string; requestBinding?: string }> = [{ engine: "HTTP_JSON" }, { engine: "HTTP_JSON", requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS" },
      { engine: "BROWSER_DOM" }, { engine: "BROWSER_JSON", requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS" },
      { engine: "BROWSER_JSON", requestBinding: "MEMBERSPORTS_PUBLIC_TEE_SHEET" },
      ...originalSchema.oneOf[3].properties!.adapter!.oneOf.map(node => ({ engine: "EXISTING_ADAPTER", family: node.properties.family.const }))];
    for (const selection of selections) {
      const selected = selectDiscoveryRecipeSchema(original, selection), validate = modern().compile(selected);
      expect(modern().validateSchema(selected)).toBe(true);
      expect(size({ schema: selected, guidance: discoveryRecipeGuidance(selection) })).toBeLessThan(18_000);
      for (const value of cases) {
        const candidate = value as typeof http & { adapter?: { family?: string }; requestBinding?: string };
        const inVariant = candidate?.engine === selection.engine && candidate.requestBinding === selection.requestBinding &&
          (selection.family === undefined || candidate.adapter?.family === selection.family);
        expect(validate(value), JSON.stringify({ selection, value })).toBe(inVariant && left(value));
      }
    }
    expect(JSON.stringify(original)).toBe(before);
    for (const selection of [{ engine: "UNSAFE" }, { engine: "EXISTING_ADAPTER" }, { engine: "EXISTING_ADAPTER", family: "UNKNOWN" },
      { engine: "BROWSER_JSON" }, { engine: "BROWSER_DOM", family: "CPS" }, { engine: "BROWSER_DOM", unexpected: true }])
      expect(() => selectDiscoveryRecipeSchema(original, selection)).toThrow("DISCOVERY_PROMPT_SCHEMA_SELECTION_UNAVAILABLE");
  }, 45_000);
});

describe("bounded initial discovery instructions", () => {
  it("keeps every common safety/identity rule and all tool schemas below12k without eager recipe/provider documentation", () => {
    const instructions = discoveryPromptInstructions({ browserTransport: "NATIVE_CHROME" });
    expect(size(instructions) + size(DISCOVERY_TOOLS) + 500).toBeLessThan(12_000);
    for (const rule of ["signed-out", "Never select/hold/reserve", "canonical", "Standard Public", "Players are attendee context", "fixed",
      "modelPreview", "never prove", "two fresh independent challenges", "sixteen-operation", "INCOMPLETE"])
      expect(instructions).toContain(rule);
    expect(instructions).not.toContain('"$defs"'); expect(instructions).not.toContain("CPS .cps.golf");
    expect(discoveryPromptInstructions({ recipeEngineConstraint: "EXISTING_ADAPTER" })).toContain("Other engines and stale metadata/source reports are forbidden");
  });

  it("returns long provider guidance only for the selected engine/family or binding", () => {
    const browser = discoveryRecipeGuidance({ engine: "BROWSER_DOM" });
    expect(browser).toContain("Every BROWSER_DOM recipe requires availabilityResponse");
    expect(browser).not.toContain("CPS .cps.golf"); expect(browser).not.toContain("tenant.teesnap.net");
    const cps = discoveryRecipeGuidance({ engine: "EXISTING_ADAPTER", family: "CPS" });
    expect(cps).toContain("CPS .cps.golf"); expect(cps).not.toContain("tenant.teesnap.net");
    const json = discoveryRecipeGuidance({ engine: "BROWSER_JSON", requestBinding: "MEMBERSPORTS_PUBLIC_TEE_SHEET" });
    expect(json).toContain("A public MemberSports"); expect(json).not.toContain("CPS .cps.golf");
  });
});
