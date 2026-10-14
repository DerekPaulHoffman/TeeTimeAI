import { parse } from "acorn";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

/** Exact literal dependencies only; never evaluates code or resolves packages. */
export function literalPublicScriptImports(script: string, sourceUrl: string): string[] {
  if (Buffer.byteLength(script, "utf8") > 1_500_000) return [];
  let root: unknown;
  try { root = parse(script, { ecmaVersion: "latest", sourceType: "module" }); }
  catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  const pending: unknown[] = [root];
  const candidates = new Map<string, number>();
  for (let visited = 0; pending.length && visited < 50_000; visited += 1) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type))) {
      const source = node.source as { type?: string; value?: unknown } | undefined;
      if (source?.type === "Literal" && typeof source.value === "string" && /^(?:\.\.?\/|\/|https?:\/\/)/u.test(source.value)) {
        try {
          const safe = getSafeCustomerBookingUrl(new URL(source.value, sourceUrl).href);
          if (safe && !/captcha|challenge|turnstile|cdn-cgi/iu.test(`${new URL(safe).hostname}${new URL(safe).pathname}`)) {
            const position = typeof node.start === "number" ? node.start : 0;
            candidates.set(safe, Math.min(candidates.get(safe) ?? position, position));
          }
        } catch { /* An unsafe or invalid import gains no request authority. */ }
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (let index = Math.min(child.length, 50_000 - pending.length) - 1; index >= 0; index -= 1) pending.push(child[index]);
      } else if (child && typeof child === "object" && pending.length < 50_000) pending.push(child);
    }
  }
  return [...candidates].sort((left, right) => left[1] - right[1]).slice(0, 20).map(([url]) => url);
}
