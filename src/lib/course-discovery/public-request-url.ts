/** Canonicalize only known public read metadata before ordinary authorization.
 * The returned URL is also the wire URL; no other request field is changed. */
export function canonicalPublicReadUrl(value: string, method: string) {
  try {
    const url = new URL(value);
    if (method === "GET" && url.protocol === "https:" && url.hostname === "foreupsoftware.com" &&
        !url.username && !url.password && !url.port && url.pathname === "/index.php/api/booking/times") {
      url.searchParams.delete("api_key");
      return url.href;
    }
    // CPS appends its public build text without trimming the trailing newline.
    // Match the literal tenant route, not a decoded/normalized path or host.
    const cps = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cps\.golf\/onlineres\/onlineapi\/api\/v1\/onlinereservation\/GetAllOptions\/\1\?([^#]*)$/u.exec(value);
    if (method === "GET" && value.length <= 2048 && cps && cps[1] !== "sc" && !/[\u0000-\u001f\u007f]/u.test(value)) {
      const query = cps[2].split("&"), keys = query.map(part => /^(version|product|parentName)=/u.exec(part)?.[1] ?? "");
      const version = url.searchParams.get("version"), parent = url.searchParams.get("parentName");
      if ((query.length === 2 || query.length === 3) && new Set(keys).size === query.length &&
          keys.every(key => ["version", "product", "parentName"].includes(key)) &&
          url.searchParams.get("product") === "3" && version && version.length <= 128 &&
          /^[ \r\n]*[0-9]+(?:\.[0-9]+){2,7}[ \r\n]*$/u.test(version) &&
          (parent === null || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(parent))) {
        const trimmed = version.replace(/^[ \r\n]+|[ \r\n]+$/gu, "");
        if (trimmed !== version) {
          // Preserve the original order and all non-version query bytes.
          query[keys.indexOf("version")] = `version=${trimmed}`;
          return `${value.slice(0, value.indexOf("?") + 1)}${query.join("&")}`;
        }
      }
    }
  } catch { /* The ordinary request guard rejects invalid URLs. */ }
  return value;
}
