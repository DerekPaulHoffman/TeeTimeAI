import { createHash } from "node:crypto";
import { parse, tokenizer, type Token } from "acorn";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

const MAX_SOURCE_BYTES = 16_000_000;
const MAX_AST_SOURCE_BYTES = 1_500_000;
const MAX_NODES = 50_000;
const MAX_CONTEXT = 4_000;
const MAX_CONTEXTS = 4;
const MAX_TOTAL_CONTEXT = 10_000;
const topic = /availab(?:ility|le)|calendar|slots/iu;
const sensitiveName = /auth|password|secret|token|cookie|session|credential|email|phone|mobile|customer|client|user|address|contact|api[_-]?key|access[_-]?key|private[_-]?key|signature|nonce|csrf/iu;
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const publicLiterals = new Set(["get", "head", "post", "put", "patch", "delete", "options", "json", "application/json", "text/html",
  "read", "list", "search", "query", "availability", "reserve", "hold", "book", "purchase", "checkout", "pay", "cancel", "create", "update", "write", "release",
  "success", "error", "ok", "failed", "active", "inactive", "public", "private", "available", "unavailable", "open", "closed",
  "yyyy-mm-dd", "dd/mm/yyyy", "yyyy-mm-ddthh:mm:ss"]);
type JsNode = { type: string; start: number; end: number; [key: string]: unknown };
type Warning = "SOURCE_SIZE" | "AST_BUDGET" | "SCAN_BUDGET" | "CONTEXT_SIZE" | "SYNTAX_UNSUPPORTED";
type Fragment = { sourceKind: "INLINE_SCRIPT" | "EXTERNAL_SCRIPT"; sourceUrl: string; sourceSha256: string;
  basis: "API_PATH" | "FUNCTION_NAME"; projection?: "TOKEN_WINDOW";
  range: { start: number; end: number }; literalRedactions: number; code: string };
export type SimulatorClientCodeEvidence = {
  version: 1; authority: "EVIDENCE_ONLY"; fragments: Fragment[]; warnings: Warning[]; truncated: boolean;
};
function asNode(value: unknown): JsNode | undefined {
  return value && typeof value === "object" && "type" in value && "start" in value && "end" in value ? value as JsNode : undefined;
}
function symbol(value: unknown): string {
  const node = asNode(value);
  if (node?.type === "Identifier") return String(node.name);
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return "";
}
function bindingName(node: JsNode, parent?: JsNode) {
  if (symbol(node.id)) return symbol(node.id);
  if (parent?.type === "VariableDeclarator") return symbol(parent.id);
  if (parent?.type === "Property" || parent?.type === "MethodDefinition") return symbol(parent.key);
  const left = asNode(parent?.left);
  return left?.type === "MemberExpression" ? symbol(left.property) : symbol(left);
}
function httpCall(node: JsNode) {
  const callee = asNode(node.callee);
  const name = callee?.type === "MemberExpression" ? symbol(callee.property) : symbol(callee);
  return /^(?:fetch|ajax|get|post|put|patch|delete|request|open|send)$/iu.test(name);
}
/** A literal reference is data, never a new request destination. No query is stripped. */
function publicRoute(value: string) {
  if (value.length > 240 || !value.includes("/") || /[\u0000-\u0020\u007f?#\\@]/u.test(value)) return false;
  if (!/^(?:https:\/\/|\.?\.?\/|[a-z][a-z0-9_-]*\/)/iu.test(value)) return false;
  try {
    const url = new URL(value, "https://reference.example.test/");
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(url.hostname) && !/\.(?:local|internal)$/iu.test(url.hostname) &&
      url.pathname.split("/").every(part => /^[a-z0-9_.-]{0,80}$/iu.test(part)) &&
      !url.pathname.split("/").some(part => /^\d{4,}$/u.test(part) || /^[a-f0-9-]{8,}$/iu.test(part));
  } catch { return false; }
}
function sourceAllowed(sourceUrl: string, sourceKind: Fragment["sourceKind"]) {
  const safe = getSafeCustomerBookingUrl(sourceUrl);
  if (!safe || new URL(safe).href !== new URL(sourceUrl).href) return false;
  const url = new URL(safe);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(url.hostname) || /\.(?:local|internal)$/iu.test(url.hostname) ||
      url.port || url.hash || url.username || url.password) return false;
  if ([...new URL(safe).searchParams].some(([key, value]) =>
    /^(?:token|secret|password|auth|session|email|phone|customer|user|client|signature|api[_-]?key|access[_-]?key|code)$/iu.test(key) ||
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu.test(value))) return false;
  if (sourceKind === "INLINE_SCRIPT") return true;
  return [...new URL(safe).searchParams].every(([key, value]) => ["v", "ver", "version"].includes(key) &&
    /^[a-z0-9._-]{1,80}$/iu.test(value));
}

/** Inert vendor-client structure only. Data literals and comments are redacted;
 * names and routes alone cannot authorize a POST, booking, or eligibility. */
export function inspectSimulatorClientCode(source: string, sourceUrl: string, sourceKind: Fragment["sourceKind"]): SimulatorClientCodeEvidence | undefined {
  if (!sourceAllowed(sourceUrl, sourceKind)) return;
  const empty = (warning: Warning): SimulatorClientCodeEvidence => ({ version: 1, authority: "EVIDENCE_ONLY", fragments: [],
    warnings: [warning], truncated: warning !== "SYNTAX_UNSUPPORTED" });
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return empty("SOURCE_SIZE");
  if (!topic.test(source)) return;
  if (Buffer.byteLength(source, "utf8") > MAX_AST_SOURCE_BYTES) return clientCodeTokenWindows(source, sourceUrl, sourceKind);
  const replacements: Array<{ start: number; end: number; text: string; literal: boolean }> = [];
  let root: unknown;
  try { root = parse(source, { ecmaVersion: "latest", sourceType: "module",
    onComment: (_block, _text, start, end) => replacements.push({ start, end, text: " ", literal: false }) }); }
  catch (error) { if (error instanceof SyntaxError) return empty("SYNTAX_UNSUPPORTED"); throw error; }
  const scopes = new Map<JsNode, { basis?: Fragment["basis"]; http: boolean }>();
  const pending: Array<{ value: unknown; parent?: JsNode; scope?: JsNode }> = [{ value: root }];
  let visited = 0, traversalTruncated = false;
  while (pending.length && visited++ < MAX_NODES) {
    const item = pending.pop()!, node = asNode(item.value);
    if (!node) continue;
    let scope = item.scope;
    if (functionTypes.has(node.type)) {
      scope = node;
      scopes.set(scope, { basis: topic.test(bindingName(node, item.parent)) ? "FUNCTION_NAME" : undefined, http: false });
    } else if (!scope && node.type === "CallExpression" && httpCall(node)) {
      scope = node; scopes.set(scope, { http: true });
    }
    if (node.type === "CallExpression" && scope && httpCall(node)) scopes.get(scope)!.http = true;
    if (node.type === "Literal") {
      const value = node.value;
      const key = item.parent && ((["Property", "MethodDefinition"].includes(item.parent.type) && item.parent.key === node) ||
        item.parent.type === "MemberExpression" && item.parent.property === node);
      const sensitiveValue = item.parent?.type === "Property" && item.parent.value === node &&
        sensitiveName.test(symbol(item.parent.key));
      const selector = typeof value === "string" && (/^[#.][a-z_][a-z0-9_-]{0,79}$/iu.test(value) ||
        /^(?:input|select|meta)\[name=['"]?[a-z_][a-z0-9_-]{0,79}['"]?\]$/iu.test(value));
      const keep = !sensitiveValue && typeof value === "string" && (key && /^[a-z_$][a-z0-9_$]{0,79}$/iu.test(value) ||
        publicLiterals.has(value.toLowerCase()) || selector || publicRoute(value));
      if (typeof value === "string" && publicRoute(value) && topic.test(value) && scope) scopes.get(scope)!.basis = "API_PATH";
      if (!keep && typeof value === "string") replacements.push({ start: node.start, end: node.end, text: '"[REDACTED_LITERAL]"', literal: true });
      else if (sensitiveValue && value !== null || typeof value === "number" && (value !== 0 && value !== 1 ||
        item.parent?.type === "Property" && item.parent.value === node) || typeof value === "bigint" || node.regex) {
        replacements.push({ start: node.start, end: node.end, text: "null/*REDACTED_LITERAL*/", literal: true });
      }
    } else if (node.type === "TemplateElement") {
      const value = node.value as { cooked?: string | null; raw?: string } | undefined;
      const text = value?.cooked ?? value?.raw ?? "";
      if (publicRoute(text) && topic.test(text) && scope) scopes.get(scope)!.basis = "API_PATH";
      if (text && !publicRoute(text)) replacements.push({ start: node.start, end: node.end, text: "[REDACTED_LITERAL]", literal: true });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        if (child.length > MAX_NODES - pending.length) traversalTruncated = true;
        for (let index = Math.min(child.length, MAX_NODES - pending.length) - 1; index >= 0; index--) pending.push({ value: child[index], parent: node, scope });
      } else if (child && typeof child === "object") {
        if (pending.length < MAX_NODES) pending.push({ value: child, parent: node, scope });
        else traversalTruncated = true;
      }
    }
  }
  // No excerpt may escape a traversal that did not inspect all its literals.
  if (pending.length || traversalTruncated) return clientCodeTokenWindows(source, sourceUrl, sourceKind, "AST_BUDGET");
  const sourceSha256 = createHash("sha256").update(source).digest("hex"), fragments: Fragment[] = [];
  let oversized = false;
  for (const [scope, detail] of scopes) {
    if (!detail.basis || !detail.http) continue;
    if (scope.end - scope.start > MAX_CONTEXT) { oversized = true; continue; }
    const edits = replacements.filter(edit => edit.start >= scope.start && edit.end <= scope.end).sort((left, right) => right.start - left.start);
    let code = source.slice(scope.start, scope.end);
    for (const edit of edits) code = code.slice(0, edit.start - scope.start) + edit.text + code.slice(edit.end - scope.start);
    if (code.length > MAX_CONTEXT) { oversized = true; continue; }
    fragments.push({ sourceKind, sourceUrl, sourceSha256, basis: detail.basis, range: { start: scope.start, end: scope.end },
      literalRedactions: edits.filter(edit => edit.literal).length, code });
  }
  if (!fragments.length && !oversized) return;
  return mergeSimulatorClientCodeEvidence({ version: 1, authority: "EVIDENCE_ONLY", fragments,
    warnings: oversized ? ["CONTEXT_SIZE"] : [], truncated: oversized });
}

/** Large bundles are scanned without building a complete AST. Every returned
 * token is independently redacted, so unvisited code can never leak through a
 * partially inspected function. A window is explicitly incomplete evidence. */
function clientCodeTokenWindows(source: string, sourceUrl: string, sourceKind: Fragment["sourceKind"], reason?: Warning): SimulatorClientCodeEvidence {
  type LexicalToken = Token & { value?: unknown };
  type SafeToken = { start: number; end: number; code: string; redactions: number; http: boolean };
  type Window = { basis: Fragment["basis"]; tokens: SafeToken[]; remaining: number };
  const ring: SafeToken[] = [], pending: Window[] = [], candidates: Window[] = [];
  const warnings = new Set<Warning>(reason ? [reason] : []);
  const started = performance.now(), stream = tokenizer(source, { ecmaVersion: "latest", sourceType: "module" });
  let previous: LexicalToken | undefined, beforePrevious: LexicalToken | undefined, lastAnchor = -1000, visited = 0;
  const value = (token: LexicalToken | undefined) => typeof token?.value === "string" ? token.value : token?.type.label ?? "";
  const finish = (window: Window) => {
    if (!window.tokens.some(token => token.http)) return;
    candidates.push(window);
    candidates.sort((left, right) => Number(right.basis === "API_PATH") - Number(left.basis === "API_PATH") || left.tokens[0].start - right.tokens[0].start);
    if (candidates.length > 32) candidates.length = 32;
  };
  try {
    let token: LexicalToken = stream.getToken();
    while (token.type.label !== "eof") {
      if (++visited > 2_000_000 || visited % 1024 === 0 && performance.now() - started > 2_000) { warnings.add("SCAN_BUDGET"); break; }
      const next: LexicalToken = stream.getToken(), label = token.type.label, string = typeof token.value === "string" ? token.value : "";
      const sensitive = [":", "="].includes(previous?.type.label ?? "") &&
        sensitiveName.test(value(beforePrevious));
      const key = label === "string" && next.type.label === ":" && /^[a-z_$][a-z0-9_$]{0,79}$/iu.test(string);
      const route = label === "string" && publicRoute(string);
      const selector = label === "string" && (/^[#.][a-z_][a-z0-9_-]{0,79}$/iu.test(string) ||
        /^(?:input|select|meta)\[name=['"]?[a-z_][a-z0-9_-]{0,79}['"]?\]$/iu.test(string));
      let code: string, redactions = 0;
      if (label === "string") {
        const keep = !sensitive && (key || route || selector || publicLiterals.has(string.toLowerCase()));
        code = keep ? JSON.stringify(string) : '"[REDACTED_LITERAL]"'; redactions = Number(!keep);
      } else if (["template", "invalidTemplate"].includes(label)) {
        code = "[REDACTED_LITERAL]"; redactions = 1;
      } else if (["num", "bigint", "regexp"].includes(label) || sensitive && ["true", "false"].includes(label)) {
        code = "null/*REDACTED_LITERAL*/"; redactions = 1;
      } else if (token.end - token.start > 100) {
        code = "REDACTED_IDENTIFIER"; redactions = 1;
      } else code = source.slice(token.start, token.end);
      const safe: SafeToken = { start: token.start, end: token.end, code, redactions,
        http: label === "name" && /^(?:fetch|ajax|get|post|put|patch|delete|request|open|send)$/iu.test(string) && next.type.label === "(" };
      for (let index = pending.length - 1; index >= 0; index--) {
        const window = pending[index]; window.tokens.push(safe);
        if (--window.remaining <= 0) { finish(window); pending.splice(index, 1); }
      }
      const basis = route && topic.test(string) ? "API_PATH" : label === "name" && topic.test(string) && next.type.label === "(" ? "FUNCTION_NAME" : undefined;
      if (basis && (visited - lastAnchor >= 16 || basis === "API_PATH") && pending.length < 8) {
        pending.push({ basis, tokens: [...ring.slice(-64), safe], remaining: 128 }); lastAnchor = visited;
      }
      ring.push(safe); if (ring.length > 64) ring.shift();
      beforePrevious = previous; previous = token; token = next;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { version: 1, authority: "EVIDENCE_ONLY", fragments: [], warnings: ["SYNTAX_UNSUPPORTED"], truncated: true };
  }
  pending.forEach(finish);
  const sourceSha256 = createHash("sha256").update(source).digest("hex"), fragments: Fragment[] = [];
  for (const window of candidates) {
    const start = window.tokens[0].start, end = window.tokens.at(-1)!.end;
    if (fragments.some(fragment => start < fragment.range.end && end > fragment.range.start)) continue;
    const code = window.tokens.map(token => token.code).join(" ");
    if (code.length > MAX_CONTEXT) { warnings.add("CONTEXT_SIZE"); continue; }
    fragments.push({ sourceKind, sourceUrl, sourceSha256, basis: window.basis, projection: "TOKEN_WINDOW",
      range: { start, end }, literalRedactions: window.tokens.reduce((sum, token) => sum + token.redactions, 0), code });
    if (fragments.length === MAX_CONTEXTS) break;
  }
  return mergeSimulatorClientCodeEvidence({ version: 1, authority: "EVIDENCE_ONLY", fragments, warnings: [...warnings], truncated: true })!;
}

export function mergeSimulatorClientCodeEvidence(...inputs: Array<SimulatorClientCodeEvidence | undefined>): SimulatorClientCodeEvidence | undefined {
  const present = inputs.filter((value): value is SimulatorClientCodeEvidence => Boolean(value));
  if (!present.length) return;
  const unique = new Map<string, Fragment>();
  for (const value of present.flatMap(value => value.fragments)) unique.set(`${value.sourceKind}:${value.sourceUrl}:${value.sourceSha256}:${value.range.start}:${value.range.end}`, value);
  const ordered = [...unique.values()].sort((left, right) => Number(right.basis === "API_PATH") - Number(left.basis === "API_PATH") ||
    left.sourceUrl.localeCompare(right.sourceUrl) || left.sourceSha256.localeCompare(right.sourceSha256) ||
    left.sourceKind.localeCompare(right.sourceKind) || left.range.start - right.range.start || left.range.end - right.range.end);
  let chars = 0;
  const fragments = ordered.filter(fragment => {
    if (chars + fragment.code.length > MAX_TOTAL_CONTEXT) return false;
    chars += fragment.code.length; return true;
  }).slice(0, MAX_CONTEXTS);
  return { version: 1, authority: "EVIDENCE_ONLY", fragments,
    warnings: [...new Set(present.flatMap(value => value.warnings))],
    truncated: present.some(value => value.truncated) || fragments.length !== ordered.length };
}
