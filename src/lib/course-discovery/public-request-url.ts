/** ForeUP's public tee sheet accepts this read without its optional api_key.
 * Drop that field rather than admitting a credential-shaped query value. */
export function canonicalPublicReadUrl(value: string, method: string) {
  try {
    const url = new URL(value);
    if (method === "GET" && url.protocol === "https:" && url.hostname === "foreupsoftware.com" &&
        !url.username && !url.password && !url.port && url.pathname === "/index.php/api/booking/times") {
      url.searchParams.delete("api_key");
      return url.href;
    }
  } catch { /* The ordinary request guard rejects invalid URLs. */ }
  return value;
}
