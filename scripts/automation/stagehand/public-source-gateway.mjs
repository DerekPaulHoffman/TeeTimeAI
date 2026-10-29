/** Routing only. This public club entry redirects inside the provider app;
 * it is not an executable facility/date source or availability evidence. */
export function isWhooshClubGateway(value) {
  try {
    const url = new URL(value);
    const match = /^\/patron\/club\/([^/]+)\/?$/u.exec(url.pathname);
    const club = match && decodeURIComponent(match[1]);
    return url.href === value && url.protocol === 'https:' && url.hostname === 'app.whoosh.io' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      typeof club === 'string' && /^[a-z0-9](?:[a-z0-9_'\-]{0,126}[a-z0-9])?$/u.test(club);
  } catch { return false; }
}
