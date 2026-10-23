import { createHash } from "node:crypto";
import { parse, type Node } from "acorn";
import { isSafeBrowserAssetUrl, isSafeBrowserAvailabilityReadUrl, isSafeBrowserMemberSportsEventsReadUrl, isSafeRecipeUrl } from "./recipe";
import { isMemberSportsPublicTeeSheetPost } from "@/lib/automation/membersports-public-read-policy";

/** These facts must come from controller-private token maps, never a model,
 * recipe, checkpoint, or a caller-supplied serialized claim of admission. */
export type PublicClientReadHeaderAttestors = {
  document(token: object): unknown;
  script(token: object): unknown;
  request(token: object): unknown;
};
export type PublicClientDocumentFacts = {
  url: string; loader: object; live: boolean; rootFrame: boolean;
};
export type PublicClientScriptFacts = {
  document: object; loader: object; url: string; method: string; resourceType: string;
  rootFrame: boolean; live: boolean; hasBody: boolean; status: number; mimeType: string;
  admitted: boolean; complete: boolean; redirected: boolean; body: string;
};
export type PublicClientRequestFacts = {
  document: object; loader: object; url: string; method: string; resourceType: string;
  rootFrame: boolean; live: boolean; hasBody: boolean;
  /** Bounded controller-private bytes; never supplied by a recipe or exposed. */
  body?: string | null;
  headers: readonly (readonly [string, string])[];
  /** Only the controller's exact native preflight correlation may set this. */
  sourceRequest?: object;
};
declare const proofBrand: unique symbol;
export type PublicClientReadHeaderProof = { readonly [proofBrand]: true };
export type PublicClientReadHeaderFailureReason = "PROOF_NOT_ATTESTED" | "SCRIPT_VERSION_CHANGED" | "REVOCATION_EPOCH_CHANGED" |
  "DOCUMENT_NOT_CURRENT" | "PUBLIC_VALUES_MISSING" | "PUBLIC_SOURCE_INVALID" | "REQUEST_SIGNATURE_CHANGED";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_AST_NODES = 250_000;
const MAX_PUBLIC_VALUES = 8;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (value: unknown): value is object => !!value && typeof value === "object";

// Read own data descriptors only: this boundary must not invoke input getters.
function data(value: unknown): Record<string, unknown> | null {
  if (!token(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return null;
    result[name] = descriptor.value;
  }
  return result;
}
function array(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}
type Ast = Node & Record<string, unknown>;
const ast = (value: unknown): value is Ast => token(value) && typeof (value as Node).type === "string";
const name = (value: unknown) => ast(value) && value.type === "Identifier" ? value.name :
  ast(value) && value.type === "Literal" ? value.value : null;
const ordinaryProperty = (value: unknown): value is Ast => ast(value) && value.type === "Property" &&
  value.kind === "init" && value.computed === false && value.method === false;
function staticString(value: unknown): string | null {
  if (!ast(value)) return null;
  if (value.type === "Literal") return typeof value.value === "string" ? value.value : null;
  if (value.type !== "TemplateLiteral" || !Array.isArray(value.expressions) || value.expressions.length !== 0 ||
      !Array.isArray(value.quasis) || value.quasis.length !== 1) return null;
  const quasi = value.quasis[0];
  if (!ast(quasi) || quasi.type !== "TemplateElement" || !token(quasi.value)) return null;
  const cooked = (quasi.value as { cooked?: unknown }).cooked;
  return typeof cooked === "string" ? cooked : null;
}

/** Proves only that a literal value is public in a setHeaders expression. It
 * does not interpret merge helpers, determine their result, or attest API routes. */
function publicValueDigests(source: string): Set<string> | null {
  if (!source || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return null;
  try {
    const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    if (!ast(program)) return null;
    const pending: Ast[] = [program];
    const values = new Set<string>();
    let visited = 0;
    const headers = (root: Ast) => {
      const expressions: Ast[] = [root];
      while (expressions.length) {
        if (++visited > MAX_AST_NODES) throw new Error("BOUND");
        const expression = expressions.pop()!;
        if (expression.type === "ObjectExpression") {
          for (const property of expression.properties as unknown[]) {
            if (ordinaryProperty(property) && name(property.key) === "x-api-key") {
              const literal = staticString(property.value);
              if (literal && literal.length <= 4096 && literal.trim() === literal && /^[\x20-\x7e]+$/u.test(literal))
                values.add(hash(literal));
            } else if (ast(property) && property.type === "SpreadElement" && ast(property.argument)) expressions.push(property.argument);
          }
        } else if (expression.type === "CallExpression") {
          for (const argument of expression.arguments as unknown[]) if (ast(argument)) expressions.push(argument);
        } else if (expression.type === "ConditionalExpression") {
          if (ast(expression.consequent)) expressions.push(expression.consequent);
          if (ast(expression.alternate)) expressions.push(expression.alternate);
        }
        if (values.size > MAX_PUBLIC_VALUES) throw new Error("BOUND");
      }
    };
    while (pending.length) {
      if (++visited > MAX_AST_NODES) return null;
      const current = pending.pop()!;
      if (current.type === "CallExpression" && ast(current.callee) && current.callee.type === "MemberExpression" &&
          current.callee.computed === false && name(current.callee.property) === "clone" &&
          Array.isArray(current.arguments) && current.arguments.length === 1 && ast(current.arguments[0]) &&
          current.arguments[0].type === "ObjectExpression") {
        for (const property of current.arguments[0].properties as unknown[])
          if (ordinaryProperty(property) && name(property.key) === "setHeaders" && ast(property.value)) headers(property.value);
      }
      for (const child of Object.values(current)) {
        if (ast(child)) pending.push(child);
        else if (Array.isArray(child)) for (const item of child) if (ast(item)) pending.push(item);
      }
    }
    return values;
  } catch { return null; }
}

const ordinaryHeaders = new Set(["accept", "accept-language", "accept-encoding", "cache-control", "pragma", "content-type",
  "origin", "referer", "user-agent", "priority", "dnt", "host", "connection", "upgrade-insecure-requests",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "sec-ch-ua", "sec-ch-ua-mobile",
  "sec-ch-ua-platform", "sec-ch-ua-platform-version", "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-model",
  "sec-ch-ua-full-version", "sec-ch-ua-full-version-list", "sec-ch-ua-wow64"]);
// The reviewed public interceptor's dependency produces these browse-correlation
// values with crypto.randomUUID. Stored values and its non-UUID fallback gain
// no permission unless the actual outgoing value is itself canonical UUIDv4.
const anonymousCorrelationHeaders = new Set(["x-ms-device-id", "x-ms-client-session-id", "x-ms-request-id", "x-ms-attempt-id"]);
const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const requestedHeaders = new Set(["accept", "accept-language", "cache-control", "pragma", "content-type", "authorization", "x-api-key",
  ...anonymousCorrelationHeaders]);
function headerMap(value: unknown): Map<string, string> | null {
  const entries = array(value, 64), result = new Map<string, string>();
  if (!entries) return null;
  for (const entry of entries) {
    const pair = array(entry, 2);
    if (!pair || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string" ||
        !/^[a-z0-9-]{1,80}$/iu.test(pair[0]) || pair[1].length > 8192 || /[\r\n\0]/u.test(pair[1])) return null;
    const key = pair[0].toLowerCase();
    if (result.has(key)) return null;
    // Cookie is deliberately not evidence for this proof. Its existing caller
    // policy must still run; this helper neither authorizes nor returns it.
    result.set(key, key === "cookie" ? "" : pair[1]);
  }
  return result;
}

type Read = { facts: Record<string, unknown>; headers: Map<string, string>; signature: string };
type ProofState = { version: number; kind: "script" } |
  { revocationEpoch: number; kind: "read"; request: object; signature: string } |
  { revocationEpoch: number; kind: "preflight"; request: object; source: object; signature: string };

/** Prototype boundary only: constructing this scope does not brand native
 * requests. Integration must supply controller-private WeakMap attestors and
 * keep normal URL/DNS/method/cookie/lease policy and response proof unchanged. */
export function createPublicClientReadHeaderScope(document: object, attestors: PublicClientReadHeaderAttestors) {
  const sources = new Map<object, string>(), publicValues = new Set<string>();
  const proofs = new WeakMap<object, ProofState>(), failedSources = new WeakSet<object>(), failedRequests = new WeakSet<object>();
  const proofFailures = new WeakMap<object, PublicClientReadHeaderFailureReason>();
  let version = 0, revocationEpoch = 0, closed = false, loader: object | null = null, origin = "";
  const attest = (kind: keyof PublicClientReadHeaderAttestors, value: object) => {
    try { return data(attestors[kind](value)); } catch { return null; }
  };
  const invalidate = () => { version++; revocationEpoch++; sources.clear(); publicValues.clear(); };
  const currentDocument = () => {
    const facts = attest("document", document);
    if (closed || !facts || facts.live !== true || facts.rootFrame !== true || !token(facts.loader) ||
        typeof facts.url !== "string" || facts.url.length > 2048 || !isSafeRecipeUrl(facts.url)) {
      closed = true; invalidate(); return null;
    }
    const currentOrigin = new URL(facts.url).origin;
    if (loader && (facts.loader !== loader || currentOrigin !== origin)) { closed = true; invalidate(); return null; }
    loader = facts.loader; origin = currentOrigin;
    return facts;
  };
  const scriptFacts = (source: object) => {
    if (!currentDocument() || failedSources.has(source)) return null;
    const facts = attest("script", source);
    if (!facts || facts.document !== document || facts.loader !== loader || facts.rootFrame !== true || facts.live !== true ||
        facts.method !== "GET" || facts.hasBody !== false || facts.resourceType !== "script" || facts.status !== 200 ||
        facts.admitted !== true || facts.complete !== true || facts.redirected !== false || typeof facts.url !== "string" ||
        !isSafeBrowserAssetUrl(facts.url, "script", "GET") || new URL(facts.url).origin !== origin ||
        typeof facts.mimeType !== "string" || facts.mimeType.length > 128 ||
        !/^(?:application|text)\/(?:javascript|ecmascript)(?:\s*;[^\r\n]*)?$/iu.test(facts.mimeType) ||
        typeof facts.body !== "string" || !facts.body || Buffer.byteLength(facts.body, "utf8") > MAX_SOURCE_BYTES) return null;
    return facts as Record<string, unknown> & { body: string };
  };
  const scriptDigest = (facts: Record<string, unknown> & { body: string }) =>
    hash(JSON.stringify([facts.url, facts.mimeType, hash(facts.body)]));
  const currentSources = (rejected?: (reason: PublicClientReadHeaderFailureReason) => void) => {
    if (!currentDocument()) { rejected?.("DOCUMENT_NOT_CURRENT"); return false; }
    if (!publicValues.size) { rejected?.("PUBLIC_VALUES_MISSING"); return false; }
    for (const [source, digest] of sources) {
      const facts = scriptFacts(source);
      if (!facts || scriptDigest(facts) !== digest) { rejected?.("PUBLIC_SOURCE_INVALID"); failedSources.add(source); invalidate(); return false; }
    }
    return true;
  };
  const requestFacts = (request: object, method: "read" | "preflight", correlatedOrigin?: string) => {
    const current = currentDocument();
    if (failedRequests.has(request) || !current) return null;
    const facts = attest("request", request);
    if (!facts || facts.document !== document || facts.loader !== loader || facts.rootFrame !== true || facts.live !== true ||
        !["xhr", "fetch"].includes(String(facts.resourceType)) || typeof facts.url !== "string" ||
        facts.url.length > 2048) return null;
    const headers = headerMap(facts.headers);
    if (!headers) return null;
    const effectiveMethod = method === "preflight" ? headers.get("access-control-request-method") : facts.method;
    if (!isSafeRecipeUrl(facts.url) && !isSafeBrowserAvailabilityReadUrl(facts.url, String(facts.resourceType), String(effectiveMethod)) &&
        !isSafeBrowserMemberSportsEventsReadUrl(facts.url, String(facts.resourceType), String(effectiveMethod))) return null;
    const noBody = facts.hasBody === false && (facts.body === undefined || facts.body === null);
    if (method === "preflight") return facts.method === "OPTIONS" && noBody ? { facts, headers } : null;
    if (["GET", "HEAD"].includes(String(facts.method))) return noBody ? { facts, headers } : null;
    // Only this reviewed public tee-sheet body may extend the header witness to
    // a POST. All existing source/key/auth/current-request checks still run.
    if (facts.method !== "POST" || facts.hasBody !== true || typeof facts.body !== "string" ||
        Buffer.byteLength(facts.body) > 32_768) return null;
    if (headers.has("origin") && headers.get("origin") !== origin) return null;
    try {
      const policyHeaders = new Headers([...headers]);
      // Chrome's early Network event can omit Origin. Only an exact private
      // linked preflight may supply it for this validation copy; the raw source
      // headers/signature and eventual Fetch proof stay unchanged and strict.
      if (!headers.has("origin") && correlatedOrigin === origin) policyHeaders.set("origin", correlatedOrigin);
      return isMemberSportsPublicTeeSheetPost(new URL(facts.url), policyHeaders, facts.body, String(current.url))
        ? { facts, headers } : null;
    } catch { return null; }
  };
  const read = (request: object, correlatedOrigin?: string): Read | null => {
    const input = requestFacts(request, "read", correlatedOrigin);
    if (!input || [...input.headers].some(([key, value]) => anonymousCorrelationHeaders.has(key) ? !uuidV4.test(value) :
      !ordinaryHeaders.has(key) && !["authorization", "x-api-key", "cookie"].includes(key))) return null;
    const key = input.headers.get("x-api-key"), authorization = input.headers.get("authorization");
    if (!key || !publicValues.has(hash(key)) || authorization !== undefined && authorization !== "Bearer null") return null;
    return { ...input, signature: hash(JSON.stringify([input.facts.url, input.facts.method, input.facts.resourceType,
      input.facts.body ?? null, [...input.headers]])) };
  };
  const preflight = (request: object, source: object) => {
    const input = requestFacts(request, "preflight");
    if (!input || input.facts.sourceRequest !== source || input.headers.get("origin") !== origin ||
        [...input.headers.keys()].some(key => !ordinaryHeaders.has(key) && !["access-control-request-method", "access-control-request-headers"].includes(key)) ||
        !["GET", "HEAD", "POST"].includes(input.headers.get("access-control-request-method") ?? "")) return null;
    const actual = read(source, input.headers.get("origin"));
    if (!actual || input.facts.url !== actual.facts.url || input.headers.get("access-control-request-method") !== actual.facts.method) return null;
    const value = input.headers.get("access-control-request-headers");
    if (!value || value.length > 512) return null;
    const names = value.split(",").map(item => item.trim().toLowerCase());
    if (names.length > 16 || new Set(names).size !== names.length || !names.includes("x-api-key") ||
        names.some(key => !requestedHeaders.has(key) || !actual.headers.has(key))) return null;
    return hash(JSON.stringify([actual.signature, input.facts.url, input.facts.resourceType, [...input.headers]]));
  };
  const proof = (state: ProofState) => {
    const result = Object.freeze({}) as PublicClientReadHeaderProof;
    proofs.set(result, state); return result;
  };
  return Object.freeze({
    captureScript(source: object): PublicClientReadHeaderProof | null {
      const facts = scriptFacts(source);
      const rejectWitness = () => { if (sources.has(source)) { failedSources.add(source); invalidate(); } return null; };
      if (!facts) return rejectWitness();
      const digest = scriptDigest(facts);
      if (sources.has(source) && sources.get(source) !== digest) { failedSources.add(source); invalidate(); return null; }
      const values = publicValueDigests(facts.body);
      if (!values) return rejectWitness();
      // Ordinary admitted chunks without a candidate are unrelated to the
      // witnessed value. Scanning them must not retire existing authority.
      if (!values.size) return null;
      if (sources.size >= MAX_PUBLIC_VALUES && !sources.has(source) ||
          new Set([...publicValues, ...values]).size > MAX_PUBLIC_VALUES) { invalidate(); return null; }
      if (!sources.has(source)) {
        sources.set(source, digest); for (const value of values) publicValues.add(value); version++;
      }
      return proof({ kind: "script", version });
    },
    proveRead(request: object): PublicClientReadHeaderProof | null {
      if (!currentSources()) return null;
      const actual = read(request);
      return actual ? proof({ kind: "read", revocationEpoch, request, signature: actual.signature }) : null;
    },
    provePreflight(request: object, source: object): PublicClientReadHeaderProof | null {
      if (!currentSources()) return null;
      const signature = preflight(request, source);
      return signature ? proof({ kind: "preflight", revocationEpoch, request, source, signature }) : null;
    },
    /** Call again inside queued dispatch, after acquiring the ordinary lease. */
    isCurrent(value: PublicClientReadHeaderProof): boolean {
      const state = proofs.get(value);
      const rejected = (reason: PublicClientReadHeaderFailureReason) => {
        if (token(value) && !proofFailures.has(value)) proofFailures.set(value, reason);
        return false;
      };
      // Adding a valid witness changes script captures, not queued read authority.
      // Destructive invalidation still permanently revokes every old proof; all
      // current sources and the exact private request are rechecked below.
      if (!state) return rejected("PROOF_NOT_ATTESTED");
      if (state.kind === "script" ? state.version !== version : state.revocationEpoch !== revocationEpoch)
        return rejected(state.kind === "script" ? "SCRIPT_VERSION_CHANGED" : "REVOCATION_EPOCH_CHANGED");
      if (!currentSources(rejected)) return false;
      if (state.kind === "script") return true;
      const signature = state.kind === "read" ? read(state.request)?.signature : preflight(state.request, state.source);
      if (signature !== state.signature) { failedRequests.add(state.request); return rejected("REQUEST_SIGNATURE_CHANGED"); }
      return true;
    },
    /** Observed first failure only. Reading diagnostics never revalidates a proof. */
    failureReason(value: PublicClientReadHeaderProof) { return proofFailures.get(value) ?? null; },
    /** Source failure retires every existing witness; no checkpoint restore. */
    invalidate,
    close() { closed = true; invalidate(); },
  });
}
