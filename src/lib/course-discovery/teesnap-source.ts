import { createHash } from "node:crypto";
import { parse as parseJavaScript, type Node as JavaScriptNode } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { fullCourseName } from "./teeitup-official-identity";
import { parsePublicUSBusinessAddress } from "./public-us-business-address";

const positiveId = z.number().int().min(1).max(2_147_483_647);
const tenant = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
  .refine(
    (value) => !["www", "api", "admin", "account", "login"].includes(value),
  );
const canonicalTimeZone = (value: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};
const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => canonicalTimeZone(value) === value);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code = "ADAPTER_CONFIGURATION_UNVERIFIED"): never {
  throw new Error(code);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Only the ordinary tenant root is source authority. Selected dates, customer
 * profiles, member routes, nested hosts and credential-bearing URLs are not. */
export function parseTeesnapRecipeSource(
  value: string,
): { tenant: string; bookingUrl: string } | null {
  try {
    const url = new URL(value),
      match = /^([a-z0-9-]+)\.teesnap\.net$/u.exec(url.hostname);
    if (
      !match ||
      !tenant.safeParse(match[1]).success ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      ![url.href, url.href.slice(0, -1)].includes(value)
    )
      return null;
    return { tenant: match[1], bookingUrl: url.href };
  } catch {
    return null;
  }
}

export const teesnapMetadataSchema = z
  .object({
    family: z.literal("TEESNAP"),
    tenant,
    courseId: positiveId,
    defaultHoles: z.literal(18),
    defaultAddons: z.literal("off"),
    timeZone,
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type TeesnapRecipeMetadata = z.infer<typeof teesnapMetadataSchema>;
export type TeesnapIdentitySource = {
  officialUrl: string;
  bookingUrl: string;
  venueName: string;
  venueAddress: string;
  timeZone: string;
};
/** The caller owns DNS/IP/TLS, provider leases, deadline, response limits and
 * credentialless GET scope. This module never creates an unrestricted fetch. */
export type TeesnapConfigurationRead = (url: string) => Promise<Response>;
export type TeesnapVenueMatches = (expected: string, actual: string) => boolean;

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ScriptNode = JavaScriptNode & Record<string, unknown>;
const element = (value: Node): value is Element => "tagName" in value;
const attr = (value: Element, key: string) =>
  value.attrs.find((entry) => entry.name === key)?.value;
const excluded = (value: Element) =>
  ["script", "style", "template", "noscript", "iframe", "form"].includes(
    value.tagName,
  ) ||
  value.attrs.some((entry) => ["hidden", "inert"].includes(entry.name)) ||
  attr(value, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(
    attr(value, "style") ?? "",
  ) ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/u.test(
    attr(value, "class") ?? "",
  ) ||
  /\b(?:account|members?|profile|customer|checkout|payment|billing|mailing|corporate|headquarters|login|sign-in)\b/iu.test(
    ["id", "class", "title", "aria-label"]
      .map((key) => attr(value, key) ?? "")
      .join(" "),
  );
const clean = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim();
function text(node: Node): string {
  if (node.nodeName === "#text")
    return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return ", ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function documentNodes(html: string) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 2_000_000)
    fail("ADAPTER_RESPONSE_LIMIT");
  const all: Element[] = [],
    visible: Element[] = [];
  let count = 0;
  const walk = (node: Node, depth: number, hidden: boolean) => {
    if (++count > 20_000 || depth > 64) fail("ADAPTER_DOCUMENT_LIMIT");
    if (element(node)) {
      all.push(node);
      hidden ||= excluded(node);
      if (!hidden) visible.push(node);
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) walk(child, depth + 1, hidden);
  };
  walk(parse(html), 0, false);
  return { all, visible };
}

// Same public window.courses JSON foundation as browser-discovery's Teesnap
// resolver. Unlike the legacy discovery hint, saved authority rejects duplicate
// assignments/keys/IDs and dynamic expressions instead of deduplicating them.
function configuration(entries: Element[]) {
  const values = new Map<string, unknown>();
  let scriptBytes = 0,
    nodes = 0;
  const relevant = new Set([
    "courses",
    "property",
    "customer",
    "user",
    "currentUser",
    "currentCustomer",
    "authenticated",
    "isLoggedIn",
    "is_authenticated",
    "logged_in",
    "is_logged_in",
  ]);
  const uniqueJsonKeys = (node: ScriptNode, depth: number) => {
    if (++nodes > 30_000 || depth > 80) fail();
    if (node.type === "ObjectExpression") {
      const keys = new Set<string>();
      for (const value of node.properties as ScriptNode[]) {
        const key = value.key as ScriptNode,
          name = key?.type === "Literal" ? key.value : key?.name;
        if (
          value.type !== "Property" ||
          value.computed ||
          value.method ||
          value.kind !== "init" ||
          typeof name !== "string" ||
          keys.has(name)
        )
          fail();
        keys.add(name);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        for (const child of value) {
          if (object(child) && typeof child.type === "string")
            uniqueJsonKeys(child as ScriptNode, depth + 1);
        }
      else if (object(value) && typeof value.type === "string")
        uniqueJsonKeys(value as ScriptNode, depth + 1);
    }
  };
  const walk = (
    node: ScriptNode,
    parent: ScriptNode | undefined,
    statements: Set<unknown>,
    code: string,
    depth: number,
  ) => {
    if (++nodes > 30_000 || depth > 80) fail();
    if (
      node.type === "AssignmentExpression" &&
      (node.left as ScriptNode)?.type === "Identifier" &&
      relevant.has(String((node.left as ScriptNode).name))
    )
      fail();
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      const callee = node.callee as ScriptNode,
        args = node.arguments as ScriptNode[];
      const owner = callee?.object as ScriptNode,
        operation = callee?.property as ScriptNode;
      if (
        (callee?.type === "Identifier" &&
          ["eval", "Function"].includes(String(callee.name))) ||
        (callee?.type === "MemberExpression" &&
          owner?.type === "Identifier" &&
          ["Object", "Reflect"].includes(String(owner.name)) &&
          [
            "assign",
            "defineProperty",
            "defineProperties",
            "set",
            "deleteProperty",
          ].includes(String(operation?.name ?? operation?.value)) &&
          args[0]?.type === "Identifier" &&
          ["window", "globalThis", "self"].includes(String(args[0].name)))
      )
        fail();
    }
    if (node.type === "MemberExpression") {
      const base = node.object as ScriptNode,
        key = node.property as ScriptNode;
      const name = node.computed === true ? key.value : key.name;
      if (
        base?.type === "Identifier" &&
        ["window", "globalThis", "self"].includes(String(base.name)) &&
        typeof name === "string" &&
        relevant.has(name)
      ) {
        if (
          base.name !== "window" ||
          node.computed ||
          parent?.type !== "AssignmentExpression" ||
          parent.left !== node ||
          parent.operator !== "=" ||
          !statements.has(parent) ||
          values.has(name)
        )
          fail();
        const right = parent.right as ScriptNode;
        let parsed: unknown;
        try {
          parsed = JSON.parse(code.slice(right.start, right.end));
        } catch {
          fail();
        }
        uniqueJsonKeys(right, 0);
        values.set(name, parsed);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        for (const child of value) {
          if (object(child) && typeof child.type === "string")
            walk(child as ScriptNode, node, statements, code, depth + 1);
        }
      else if (object(value) && typeof value.type === "string")
        walk(value as ScriptNode, node, statements, code, depth + 1);
    }
  };
  for (const script of entries.filter(
    (value) => value.tagName === "script" && !attr(value, "src"),
  )) {
    const code = script.childNodes
      .filter((value) => value.nodeName === "#text")
      .map((value) => (value as DefaultTreeAdapterMap["textNode"]).value)
      .join("");
    const type = attr(script, "type")?.trim().toLowerCase();
    if (type && !["text/javascript", "application/javascript"].includes(type))
      continue;
    scriptBytes += Buffer.byteLength(code);
    if (scriptBytes > 512_000) fail();
    let program: ScriptNode;
    try {
      program = parseJavaScript(code, {
        ecmaVersion: "latest",
        sourceType: "script",
      }) as unknown as ScriptNode;
    } catch {
      fail();
    }
    const statements = new Set(
      (program.body as ScriptNode[])
        .filter((value) => value.type === "ExpressionStatement")
        .map((value) => value.expression),
    );
    walk(program, undefined, statements, code, 0);
  }
  for (const [key, value] of values)
    if (
      !["courses", "property"].includes(key) &&
      value !== null &&
      value !== false
    )
      fail();
  if (!Array.isArray(values.get("courses")) || !object(values.get("property")))
    fail();
  return {
    courses: values.get("courses") as unknown[],
    property: values.get("property") as Record<string, unknown>,
  };
}

function publicFlags(value: Record<string, unknown>) {
  for (const key of ["enabled", "customer_enabled"])
    if (Object.hasOwn(value, key) && value[key] !== true) fail();
  for (const key of [
    "private",
    "is_private",
    "members_only",
    "member_only",
    "requires_login",
    "login_required",
    "authenticated",
    "is_logged_in",
    "isLoggedIn",
  ])
    if (Object.hasOwn(value, key) && value[key] !== false) fail();
  for (const key of ["access", "access_type", "visibility"])
    if (Object.hasOwn(value, key) && value[key] !== "public") fail();
}
function sourceBinding(source: TeesnapIdentitySource) {
  const booking = parseTeesnapRecipeSource(source.bookingUrl),
    official = parseTeesnapRecipeSource(source.officialUrl);
  if (!booking || !official || booking.bookingUrl !== official.bookingUrl)
    fail("UNSUPPORTED_ADAPTER_SOURCE");
  const address = parsePublicUSBusinessAddress(source.venueAddress);
  if (
    !address ||
    typeof source.venueName !== "string" ||
    source.venueName.length > 200 ||
    fullCourseName(source.venueName).length < 8 ||
    !timeZone.safeParse(source.timeZone).success
  )
    fail("ADAPTER_IDENTITY_MISMATCH");
  return { ...booking, address };
}

/** Pure bounded parser for the fetched public root; no JavaScript is executed. */
export function parseTeesnapConfiguration(
  source: TeesnapIdentitySource,
  html: string,
  venueMatches: TeesnapVenueMatches = (expected, actual) =>
    fullCourseName(expected) === fullCourseName(actual),
): TeesnapRecipeMetadata {
  const binding = sourceBinding(source),
    { all, visible } = documentNodes(html),
    config = configuration(all);
  publicFlags(config.property);
  const namesMatch = (actual: unknown) =>
    typeof actual === "string" &&
    fullCourseName(actual) === fullCourseName(source.venueName) &&
    venueMatches(source.venueName, actual);
  if (
    visible.some(
      (value) =>
        value.tagName === "a" &&
        (/^\/(?:logout|sign[-_]?out)(?:[/?#]|$)/iu.test(
          attr(value, "href") ?? "",
        ) ||
          /^(?:log\s*out|sign\s*out)$/iu.test(clean(text(value)))),
    )
  )
    fail();
  const titles = visible.filter((value) => value.tagName === "title");
  if (
    titles.length !== 1 ||
    !namesMatch(clean(text(titles[0])).split(/[|–—]/u)[0]) ||
    !visible.some(
      (value) => value.tagName !== "title" && namesMatch(clean(text(value))),
    ) ||
    (Object.hasOwn(config.property, "name") &&
      !namesMatch(config.property.name))
  )
    fail("ADAPTER_IDENTITY_MISMATCH");
  const addresses = new Map<string, unknown>();
  for (const value of visible) {
    if (
      !["address", "div", "p", "span", "li", "td", "footer"].includes(
        value.tagName,
      )
    )
      continue;
    const actual = clean(text(value)).replace(
      /,\s*([A-Z]{2}),\s*(\d{5}(?:-\d{4})?)(?=,|$)/gu,
      ", $1 $2",
    );
    if (actual.length > 600) continue;
    const address = parsePublicUSBusinessAddress(actual);
    if (address) addresses.set(JSON.stringify(address), address);
  }
  if (addresses.size !== 1 || !addresses.has(JSON.stringify(binding.address)))
    fail("ADAPTER_IDENTITY_MISMATCH");
  for (const key of ["timeZone", "timezone", "time_zone"])
    if (
      Object.hasOwn(config.property, key) &&
      (typeof config.property[key] !== "string" ||
        canonicalTimeZone(config.property[key]) !== source.timeZone)
    )
      fail("ADAPTER_IDENTITY_MISMATCH");
  if (config.courses.length < 1 || config.courses.length > 40) fail();
  const ids = new Set<number>();
  const catalog = config.courses
    .map((value) => {
      if (
        !object(value) ||
        !positiveId.safeParse(value.id).success ||
        ids.has(value.id as number) ||
        typeof value.name !== "string" ||
        value.name.length < 3 ||
        value.name.length > 200
      )
        fail();
      const id = value.id as number;
      ids.add(id);
      for (const key of [
        "enabled",
        "customer_enabled",
        "private",
        "is_private",
        "members_only",
        "member_only",
        "requires_login",
        "login_required",
      ])
        if (Object.hasOwn(value, key) && typeof value[key] !== "boolean")
          fail();
      if (
        Object.hasOwn(value, "course_type") &&
        typeof value.course_type !== "string"
      )
        fail();
      if (
        Object.hasOwn(value, "property_id") &&
        value.property_id !== config.property.id
      )
        fail();
      return {
        id,
        name: fullCourseName(value.name),
        courseType: value.course_type ?? null,
        enabled: value.enabled ?? null,
        customerEnabled: value.customer_enabled ?? null,
        private: value.private ?? null,
        isPrivate: value.is_private ?? null,
        membersOnly: value.members_only ?? null,
        memberOnly: value.member_only ?? null,
        requiresLogin: value.requires_login ?? null,
        loginRequired: value.login_required ?? null,
        holes: value.holes_default ?? null,
        addons: value.addons_default ?? null,
      };
    })
    .sort((a, b) => a.id - b.id);
  const matches = config.courses.filter(
    (value) => object(value) && namesMatch(value.name),
  ) as Record<string, unknown>[];
  if (matches.length !== 1) fail("ADAPTER_IDENTITY_MISMATCH");
  const selected = matches[0];
  publicFlags(selected);
  for (const key of ["timeZone", "timezone", "time_zone"])
    if (
      Object.hasOwn(selected, key) &&
      (typeof selected[key] !== "string" ||
        canonicalTimeZone(selected[key]) !== source.timeZone)
    )
      fail("ADAPTER_IDENTITY_MISMATCH");
  if (
    selected.holes_default !== 18 ||
    selected.addons_default !== "off" ||
    /\b(?:activit(?:y|ies)|driving[\s_-]+range|events?|gift[\s_-]+cards?|leagues?|lessons?|mini[\s_-]+golf|putting|simulators?|top[\s_-]*tracer|disc[\s_-]*golf)\b/iu.test(
      `${selected.name} ${selected.course_type ?? ""}`,
    )
  )
    fail();
  return teesnapMetadataSchema.parse({
    family: "TEESNAP",
    tenant: binding.tenant,
    courseId: selected.id,
    defaultHoles: 18,
    defaultAddons: "off",
    timeZone: source.timeZone,
    catalogHash: hash({
      tenant: binding.tenant,
      name: fullCourseName(source.venueName),
      address: binding.address,
      timeZone: source.timeZone,
      catalog,
    }),
  });
}

export async function inspectTeesnapConfiguration(
  source: TeesnapIdentitySource,
  read: TeesnapConfigurationRead,
  venueMatches?: TeesnapVenueMatches,
): Promise<TeesnapRecipeMetadata> {
  const binding = sourceBinding(source),
    response = await read(binding.bookingUrl);
  if (!response.ok || response.status !== 200) fail("ADAPTER_TRANSPORT_FAILED");
  if (
    response.redirected ||
    (response.url && response.url !== binding.bookingUrl) ||
    !/^text\/html(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
  )
    fail();
  return parseTeesnapConfiguration(source, await response.text(), venueMatches);
}

export async function revalidateTeesnapConfiguration(
  source: TeesnapIdentitySource,
  saved: unknown,
  read: TeesnapConfigurationRead,
  venueMatches?: TeesnapVenueMatches,
): Promise<TeesnapRecipeMetadata> {
  const parsed = teesnapMetadataSchema.safeParse(saved),
    binding = sourceBinding(source);
  if (
    !parsed.success ||
    parsed.data.tenant !== binding.tenant ||
    parsed.data.timeZone !== source.timeZone
  )
    fail("ADAPTER_CONFIGURATION_CHANGED");
  const current = await inspectTeesnapConfiguration(source, read, venueMatches);
  if (JSON.stringify(parsed.data) !== JSON.stringify(current))
    fail("ADAPTER_CONFIGURATION_CHANGED");
  return current;
}
