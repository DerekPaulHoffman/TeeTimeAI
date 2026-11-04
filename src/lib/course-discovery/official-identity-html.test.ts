import { describe, expect, it } from "vitest";
import { officialIdentityHtml } from "./official-identity-html";

describe("native official identity document projection", () => {
  it("preserves existing small document witnesses exactly", () => {
    const html = '<!DOCTYPE html><h1 class="name">Public Golf</h1><script nonce="a">var n=1</script>';
    expect(officialIdentityHtml(Buffer.from(html))).toBe(html);
  });
  it("retains full identity, booking, hidden and form semantics after removing large inert site payloads", () => {
    const html = `<title>Public Golf</title><script>${"x".repeat(700000)}</script><style>body{color:black}</style>` +
      '<script type="application/ld+json">{"name":"Public Golf"}</script><h1>Public Golf</h1>' +
      '<footer><address>12 Main St, Example, CT 06001</address><a href="tel:+12035550123">203-555-0123</a>' +
      '<a href="https://public.cps.golf/">Tee Times</a></footer><p hidden>Hidden facts</p><form action="/checkout"><button>Book</button></form>';
    const compact = officialIdentityHtml(Buffer.from(html));
    expect(compact).toContain('<script type="application/ld+json">{"name":"Public Golf"}</script>');
    expect(compact).toContain('<address>12 Main St, Example, CT 06001</address>');
    expect(compact).toContain('href="https://public.cps.golf/"');
    expect(compact).toContain('<p hidden="">Hidden facts</p>');
    expect(compact).toContain('<form action="/checkout"><button>Book</button></form>');
    expect(compact).not.toContain("x".repeat(100));
  });
  it("rejects oversized retained content and never manufactures a partial identity document", () => {
    expect(officialIdentityHtml(Buffer.from(`<p>${"x".repeat(600001)}</p>`))).toBeUndefined();
    expect(officialIdentityHtml(Buffer.from(`<p>${"é".repeat(300001)}</p>`))).toBeUndefined();
    expect(officialIdentityHtml(Buffer.from(`<script>${"x".repeat(2000001)}</script>`))).toBeUndefined();
  });
  it("bounds tree work even when the transport body would fit", () => {
    expect(officialIdentityHtml(Buffer.from('<script>'+"x".repeat(600001)+'</script>'+'<div>'.repeat(150)+'public'+'</div>'.repeat(150)))).toBeUndefined();
  });
});
