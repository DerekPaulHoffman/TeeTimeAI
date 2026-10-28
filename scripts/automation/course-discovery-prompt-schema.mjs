// A prompt representation only. Server validation always uses its original
// schema. Only ordinary schema locations are traversed; JSON instance literals
// (including const/default/enum/examples values) never become schema locations.
const MAX_BYTES = 2_000_000, MAX_NODES = 100_000, MAX_DEPTH = 128, MAX_SIGNATURE_BYTES = 16_000_000;
const annotations = new Set(["description", "title", "examples", "$comment"]);
const single = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "not", "if", "then", "else", "additionalItems", "unevaluatedItems", "contentSchema"]);
const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const opaque = new Set(["type", "enum", "const", "default", "format", "pattern", "required", "dependentRequired", "minProperties", "maxProperties",
  "minItems", "maxItems", "uniqueItems", "minContains", "maxContains", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType"]);
const scoped = new Set(["$ref", "$id", "id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveAnchor", "$recursiveRef", "$vocabulary"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid() { throw new Error("DISCOVERY_PROMPT_SCHEMA_INVALID"); }

function cloneJson(input) {
  let count = 0, stringBytes = 0;
  const parents = new Set();
  const clone = (value, depth) => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (typeof value === "string") { stringBytes += Buffer.byteLength(value); if (stringBytes > MAX_BYTES) invalid(); return value; }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || parents.has(value)) invalid();
    if (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    if (Object.getOwnPropertySymbols(value).length) invalid();
    parents.add(value);
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) => descriptor.enumerable);
    if (entries.some(([, descriptor]) => !Object.hasOwn(descriptor, "value"))) invalid();
    if (Array.isArray(value) && (value.length > MAX_NODES || entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) invalid();
    const result = Array.isArray(value) ? entries.map(([, descriptor]) => clone(descriptor.value, depth + 1)) : Object.fromEntries(entries.map(([key, descriptor]) => {
      stringBytes += Buffer.byteLength(key); if (stringBytes > MAX_BYTES) invalid();
      return [key, clone(descriptor.value, depth + 1)];
    }));
    parents.delete(value); return result;
  };
  const result = clone(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) invalid();
  return result;
}

function dialect(schema) {
  const value = schema.$schema;
  if (value === undefined) return "definitions";
  if (typeof value !== "string") return null;
  if (/^https:\/\/json-schema\.org\/draft\/(?:2020-12|2019-09)\/schema#?$/u.test(value)) return "$defs";
  if (/^https?:\/\/json-schema\.org\/draft-0[67]\/schema#?$/u.test(value)) return "definitions";
  return null;
}

/** Return an independent JSON schema with equivalent assertion behavior.
 * Existing references/identifiers, unknown vocabularies/keywords and unsupported
 * dialects conservatively retain the complete original clone: relocating their
 * targets or changing lexical resource scope cannot be proven safe here. */
export function compactDiscoveryRecipeSchema(input) {
  const original = cloneJson(input);
  if (typeof original === "boolean") return original;
  if (!object(original)) invalid();
  const definitionsKey = dialect(original);
  if (!definitionsKey) return original;
  let supported = true, schemaNodes = 0;
  const mapChildren = (node, transform) => {
    if (typeof node === "boolean") return node;
    if (!object(node) || ++schemaNodes > MAX_NODES) invalid();
    const entries = [];
    for (const [key, value] of Object.entries(node)) {
      if (scoped.has(key) || key === "$schema" && node !== original) supported = false;
      if (annotations.has(key)) {
        if (key === "examples" ? !Array.isArray(value) : typeof value !== "string") supported = false;
        continue;
      }
      if (single.has(key)) entries.push([key, transform(value)]);
      else if (arrays.has(key) || key === "items" && Array.isArray(value)) {
        if (!Array.isArray(value)) invalid();
        entries.push([key, value.map(transform)]);
      } else if (maps.has(key)) {
        if (!object(value)) invalid();
        entries.push([key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transform(child)]))]);
      } else if (key === "items") entries.push([key, transform(value)]);
      else if (key === "dependencies") {
        if (!object(value)) invalid();
        entries.push([key, Object.fromEntries(Object.entries(value).map(([name, child]) => {
          if (Array.isArray(child)) {
            if (child.some(entry => typeof entry !== "string")) invalid();
            return [name, child];
          }
          return [name, transform(child)];
        }))]);
      } else {
        if (key !== "$schema" && !opaque.has(key)) supported = false;
        entries.push([key, value]);
      }
    }
    return Object.fromEntries(entries);
  };
  const counts = new Map(); let signatureBytes = 0;
  const strip = node => {
    const result = mapChildren(node, strip);
    if (object(result) && supported) {
      const key = JSON.stringify(result), entry = counts.get(key);
      if (entry) entry.count++;
      else {
        const bytes = Buffer.byteLength(key); signatureBytes += bytes;
        if (signatureBytes > MAX_SIGNATURE_BYTES) supported = false;
        else counts.set(key, { count: 1, node: result, bytes });
      }
    }
    return result;
  };
  const stripped = strip(original);
  if (!supported) return original;
  const existingNames = new Set(Object.keys(stripped[definitionsKey] ?? {})), chosen = new Map();
  let ordinal = 0;
  // Post-order discovery plus fixed ordinal names makes output deterministic.
  for (const [key, entry] of counts) {
    if (entry.count < 2) continue;
    let name;
    do { name = `c${ordinal++}`; } while (existingNames.has(name));
    const ref = { $ref: `#/${definitionsKey}/${name}` }, refBytes = Buffer.byteLength(JSON.stringify(ref));
    const definitionBytes = entry.bytes + Buffer.byteLength(JSON.stringify(name)) + 2;
    if (entry.count * (entry.bytes - refBytes) <= definitionBytes) continue;
    chosen.set(key, { ...entry, name, ref });
  }
  if (!chosen.size) return stripped;
  const replace = (node, definitionRoot = false) => {
    if (typeof node === "boolean") return node;
    const entry = chosen.get(JSON.stringify(node));
    if (entry && !definitionRoot) return { ...entry.ref };
    return mapChildren(node, child => replace(child));
  };
  const result = replace(stripped);
  result[definitionsKey] = { ...result[definitionsKey], ...Object.fromEntries([...chosen.values()].map(entry => [entry.name, replace(entry.node, true)])) };
  // Small/overlapping repetitions can cost more than they save. The annotation-
  // stripped alternative has the same assertions and avoids that regression.
  return Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(stripped)) ? result : stripped;
}
