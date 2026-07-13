const PAGE_PATH_MAX_LENGTH = 500;
const PATH_PARSE_ORIGIN = "https://teetimespot.invalid";

/**
 * Reduces a relative or absolute page value to its pathname. Query strings and
 * fragments can contain email addresses, coordinates, or signed action tokens
 * and must never reach engagement persistence.
 */
export function sanitizePagePath(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed, PATH_PARSE_ORIGIN);
    const pathname = parsed.pathname || "/";
    return pathname.slice(0, PAGE_PATH_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

export function deriveSameOriginPagePath(request: Request) {
  const referer = request.headers.get("referer");
  if (!referer) {
    return undefined;
  }

  try {
    const requestUrl = new URL(request.url);
    const refererUrl = new URL(referer);
    if (requestUrl.origin !== refererUrl.origin) {
      return undefined;
    }

    return sanitizePagePath(refererUrl.pathname);
  } catch {
    return undefined;
  }
}
