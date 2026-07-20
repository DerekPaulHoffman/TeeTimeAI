const MAX_CUSTOMER_BOOKING_URL_LENGTH = 2_048;
const MAX_NESTED_URL_DEPTH = 2;

/**
 * Returns a customer-safe public booking URL, or `undefined` when the value
 * points at local/private infrastructure, an access-controlled flow, or
 * carries credential/session state.
 *
 * This is intentionally stricter than generic URL parsing because these URLs
 * become clickable links in customer email. It mirrors the public URL safety
 * boundary used by monitoring discovery while still allowing provider SPA
 * routes such as ForeUp's `#/teetimes` and GolfBack's `#/course/<id>`.
 */
export function getSafeCustomerBookingUrl(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > MAX_CUSTOMER_BOOKING_URL_LENGTH ||
    !value.trim()
  ) {
    return undefined;
  }

  const normalized = value.trim();
  try {
    return isSafeCustomerBookingUrl(new URL(normalized), 0)
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function isSafeCustomerBookingUrl(url: URL, nestingDepth: number) {
  const hasInvalidPort = Boolean(
    url.port &&
      !(
        (url.protocol === "http:" && url.port === "80") ||
        (url.protocol === "https:" && url.port === "443")
      )
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    Boolean(url.username || url.password) ||
    hasInvalidPort ||
    url.hostname.endsWith(".") ||
    isPrivateHostname(url.hostname) ||
    isRestrictedSurfaceHostname(url.hostname)
  ) {
    return false;
  }

  return !hasSensitiveUrlState(url, nestingDepth);
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    !normalized.includes(".") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".corp") ||
    // Customer links should use a stable public hostname. Rejecting raw IPv6
    // literals also closes alternate spellings of mapped private IPv4 hosts.
    normalized.includes(":") ||
    /^\d+$|^0x[\da-f]+$/i.test(normalized)
  ) {
    return true;
  }

  const ipv4 = normalized.split(".").map(Number);
  if (
    ipv4.length !== 4 ||
    ipv4.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255
    )
  ) {
    return false;
  }
  const [first, second, third] = ipv4;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function hasSensitiveUrlState(url: URL, nestingDepth: number) {
  for (const [key, value] of url.searchParams) {
    const decodedKey = decodeUrlComponent(key);
    const decodedValue = decodeUrlComponent(value);
    if (
      !decodedKey ||
      decodedValue === null ||
      isSensitiveUrlKey(decodedKey) ||
      isContextualSensitiveParameter(decodedKey, decodedValue, url) ||
      isOpaqueCredentialValue(decodedValue) ||
      hasUnsafeNestedUrl(decodedValue, url, nestingDepth, decodedKey)
    ) {
      return true;
    }
  }

  const decodedPath = decodeUrlComponent(url.pathname);
  const decodedFragment = decodeUrlComponent(url.hash.slice(1));
  if (decodedPath === null || decodedFragment === null) {
    return true;
  }
  if (hasSensitiveFragmentState(decodedFragment, url, nestingDepth)) {
    return true;
  }

  return [decodedPath, decodedFragment].some((part) => {
    const segments = part
      .split(/[/;=?&]+/u)
      .map((segment) => segment.trim())
      .filter(Boolean);
    return (
      segments.some(isRestrictedPathSegment) ||
      hasRestrictedAdjacentPathSegments(segments) ||
      hasRestrictedBookingPathSegments(segments) ||
      segments.some(
        (segment, index) =>
          (isOpaqueCredentialValue(segment) ||
            isOpaqueRedirectPathSegment(segments, index)) &&
          !isAllowedProviderIdentifier(segments, index)
      )
    );
  });
}

function hasRestrictedBookingPathSegments(segments: string[]) {
  const normalized = segments.map((segment) =>
    segment
      .replace(/\.(?:aspx?|php\d?|s?html?|xhtml|jspx?|cfm|cgi|do|action)$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
  );
  return normalized.some((segment, index) => {
    if (
      !/^(?:admins?|staff|members?|customers?|users?|clients?|partners?|employees?|secure|accounts?|myaccount|portal)(?:v?\d+)?$/.test(
        segment
      )
    ) {
      return false;
    }
    const tailSegments = normalized.slice(index + 1);
    return (
      tailSegments.join("").includes("teetime") ||
      tailSegments.some((tailSegment) =>
        /^(?:book|booking|reserve|reservation|schedule|checkout|cart|portal|dashboard|account)$/.test(
          tailSegment
        )
      )
    );
  });
}

function hasSensitiveFragmentState(
  value: string,
  parentUrl: URL,
  nestingDepth: number
) {
  if (hasUnsafeNestedUrl(value, parentUrl, nestingDepth)) {
    return true;
  }
  const fragment = value.replace(/^\/+/, "");
  const queryLike = fragment.includes("?")
    ? fragment.slice(fragment.indexOf("?") + 1)
    : fragment;
  if (!queryLike.includes("=")) {
    return false;
  }

  return queryLike.split("&").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) {
      return false;
    }
    const key = decodeUrlComponent(part.slice(0, separator));
    const nestedValue = decodeUrlComponent(part.slice(separator + 1));
    return (
      !key ||
      nestedValue === null ||
      isSensitiveUrlKey(key) ||
      isContextualSensitiveParameter(key, nestedValue, parentUrl) ||
      isOpaqueCredentialValue(nestedValue) ||
      hasUnsafeNestedUrl(nestedValue, parentUrl, nestingDepth, key)
    );
  });
}

function hasUnsafeNestedUrl(
  value: string,
  parentUrl: URL,
  nestingDepth: number,
  parameterKey?: string
) {
  const trimmed = value.trim();
  const isUrlLike = Boolean(
    /^(?:https?:\/\/|\/\/|\/|\.\.?(?:\/|$))/i.test(trimmed) ||
      /^(?:https?:)?[\\/]{2}/i.test(trimmed) ||
      /^[^?#\s]+\/[^\s]*$/.test(trimmed) ||
      (parameterKey && isNavigationUrlKey(parameterKey))
  );
  if (!isUrlLike) {
    return false;
  }
  if (nestingDepth >= MAX_NESTED_URL_DEPTH) {
    return true;
  }

  try {
    const nested = new URL(trimmed, parentUrl);
    return (
      nested.origin !== parentUrl.origin ||
      !isSafeCustomerBookingUrl(nested, nestingDepth + 1)
    );
  } catch {
    return true;
  }
}

function hasRestrictedAdjacentPathSegments(segments: string[]) {
  return segments.some((segment, index) => {
    if (index === 0) {
      return false;
    }
    return isRestrictedCompactRoute(
      `${segments[index - 1] ?? ""}${segment}`
        .normalize("NFKC")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
    );
  });
}

function isRestrictedPathSegment(value: string) {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const tokens = getSecurityTokens(value);
  const hasRestrictedToken = tokens.some((token) =>
    /^(?:accounts?|myaccount|useraccount|member|members|memberaccount|customeraccount|login|signin|signup|logout|register|registration|session|jsessionid|signed|signature|token|auth\d*|authentication|authorize|authorization|oauth\d*|openid|oidc|sso\d*|saml|assertion|relaystate|ticket|credential|password|passwordless|secret|consent|mfa|2fa|webauthn|captcha|recaptcha|turnstile|queue|queueit|waitingroom|verify|verification|magiclink|invite|invitation|checkout)$/i.test(
      token
    )
  );
  const hasSensitiveFlowPair =
    tokens.some((token) =>
      /^(?:payment|pay|cart|purchase|order|challenge)$/i.test(token)
    ) &&
    tokens.some((token) =>
      /^(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|acs|connect|provider|gateway|settings|reset|recover|recovery|forgot|checkout|booking|reservation)$/i.test(
        token
      )
    );
  const hasAccountSurfacePair =
    tokens.some((token) =>
      /^(?:admin|staff|member|customer|user)$/i.test(token)
    ) &&
    tokens.some((token) =>
      /^(?:account|dashboard|portal|profile|settings|login|signin)$/i.test(token)
    );
  const hasIdentityRecoveryPair =
    tokens.some((token) =>
      /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)$/i.test(
        token
      )
    ) &&
    tokens.some((token) => /^(?:username|email|password|account)$/i.test(token));

  return (
    hasRestrictedToken ||
    hasSensitiveFlowPair ||
    hasAccountSurfacePair ||
    hasIdentityRecoveryPair ||
    isRestrictedCompactRoute(normalized) ||
    /^(?:checkout|securecheckout|payment|pay|cart|shoppingcart|purchase|order|myaccount|useraccount|memberaccount|customeraccount|account|accountlogin|accountsignin|accountsignup|accountportal|memberportal|customerportal|login|userlogin|memberlogin|customerlogin|loginredirect|signin|signup|logout|register|registration|createaccount|session|jsessionid|signed|signature|token|auth|authentication|authcallback|auth0|oauth\d*|oauthcallback|authorize|authorization|openid|oidc|sso|ssologin|saml|assertion|relaystate|ticket|credential|password|passwordless|resetpassword|passwordreset|secret|consent|mfa|2fa|webauthn|captcha|recaptcha|captchachallenge|turnstile|queue|queueit|waitingroom|challenge|challengeplatform|verify|verification|verifyemail|emailverification|magiclink|invite|invitation)$/.test(
      normalized
    ) ||
    /^(?:(?:forgot|reset|recover|recovery)(?:my)?(?:password|account)(?:confirm|confirmation)?|(?:password|account)(?:forgot|reset|recover|recovery|settings)(?:confirm|confirmation)?|(?:login|signin|auth|oauth\d*|oidc|sso)(?:callback|redirect|oidc|sso|oauth\d*)|(?:callback|redirect)(?:login|signin|auth|oauth\d*|oidc|sso)|(?:checkout|payment|captcha|recaptcha|queue|challenge)(?:session|flow|status|page|wait|waiting|redirect|response|confirm|confirmation|verify|verification|v\d+))$/.test(
      normalized
    )
  );
}

function isRestrictedCompactRoute(normalized: string) {
  return (
    normalized.includes("login") ||
    /^(?:(?:admin|staff|member|customer|user|client|partner|employee|regional|secure)?(?:signon|logon))[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:saml|openid|oidc|oauth\d*|adfs|identity|idp|mfa|2fa|webauthn|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|queue|queueit|waitingroom|checkout|authorize|authorization|authentication|signin|signup|logout|register|registration|password|session|token|magiclink|invite|invitation|verify|verification|wresult)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^auth\d*(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|challenge|login|signin|provider|gateway|server|service|proxy)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^auth(?:n|z|enticate|entication|orize|orization)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount|clientaccount|partneraccount|employeeaccount|regionalaccount)(?:(?:login|signin|signup|portal|dashboard|profile|settings|callback|redirect|recovery|recover|reset|management|manage)[a-z0-9]*)?$/.test(
      normalized
    ) ||
    /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount)(?:book|booking|reservations?|teetimes?)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:login\d*|(?:admin|staff|member|customer|user|secure|portal|prod|tenant)login\d*)(?:callback|redirect|flow|session|step|start|portal|dashboard|secure|provider|gateway|us|eu|prod|dev|stage|staging|\d*)?$/.test(
      normalized
    ) ||
    /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:members?|admin|staff|customer|user|client|partner|employee|regional|secure)(?:center|centre|booking|portal|dashboard|profile|settings|account)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^members?(?:booking|reservations?|teetimes?)[a-z0-9]*$/.test(normalized) ||
    /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)(?:username|email|password|account)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:email|username)(?:verify|verification|confirm|confirmation|reset|recovery)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^billing(?:portal|account|history|settings|payment|invoices?|details?)?$/.test(
      normalized
    ) ||
    /^payment[a-z0-9]*$/.test(normalized) ||
    /^(?:credentials?|signature|signed(?:url)?|assertion|relaystate|consent|jsessionid|authcode|nonce|jwt|bearer)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:token|secret|ticket)[a-z0-9]*$/.test(normalized) ||
    /^(?:access|refresh|id|api|client|service|login|auth)(?:token|key|secret|ticket)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:pay(?:portal|account|method|ment)?|basket|shoppingbag|placeorder|completepurchase|orderhistory|purchasehistory|transactionhistory)$/.test(
      normalized
    ) ||
    /^(?:order|cart)(?:review|summary|confirm|confirmation|checkout|payment|billing)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:booking|reservation|cart)(?:payment|checkout)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:payment|pay|cart|purchase|order|challenge)(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|checkout)[a-z0-9]*$/.test(
      normalized
    )
  );
}

function isRestrictedSurfaceHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, "");
  const hasRestrictedLabel = normalized.split(".").some((label) => {
    const compact = label
      .normalize("NFKC")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    const tokens = getSecurityTokens(label);
    return (
      isRestrictedCompactRoute(compact) ||
      /^(?:(?:secure|portal|customer|member|user|prod|tenant)?(?:accounts?|myaccount|login|signin|auth\d*|authentication|authorize|sso\d*|oauth\d*|oidc|idp|identity|checkout|queue|captcha|challenge|verify|register|registration)(?:secure|portal|gateway|provider|login)?|(?:accounts?|myaccount|login|signin|auth\d*|authentication|authorize|sso\d*|oauth\d*|oidc|idp|identity|checkout|queue|captcha|challenge|verify|register|registration)(?:secure|portal|gateway|provider))$/.test(
        compact
      ) ||
      tokens.some((token) =>
        /^(?:accounts?|myaccount|login\d*|signin|auth\d*|authentication|authorization|authorize|sso\d*|oauth\d*|openid|oidc|saml|adfs|idp|identity|identityserver|checkout|queue|queueit|waitingroom|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|mfa|2fa|webauthn|verify|verification|register|registration)$/i.test(
          token
        )
      ) ||
      /^(?:(?:admin|staff|member|customer|user|secure|portal|prod|tenant)?(?:login\d*|accounts?|myaccount|auth\d*|authentication|authorization|authorize|sso\d*|oauth\d*|openid|oidc|saml|adfs|idp|identity(?:server|provider)?|checkout|queue|queueit|waitingroom|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|challenge|mfa|2fa|webauthn|verify|verification|register|registration)(?:us|eu|prod|dev|stage|staging|secure|portal|gateway|provider|server|callback|redirect|flow|session|step|start|connect|progress|challenge|platform|dashboard|settings|acs|authnrequest|request|response|confirm|confirmation|verification|verify|\d*)?)$/.test(
        compact
      ) ||
      /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/.test(
        compact
      ) ||
      /^(?:arkose|arkoselabs|okta|onelogin|cloudflareaccess)$/.test(compact)
    );
  });

  return (
    hasRestrictedLabel ||
    normalized === "queue-it.net" ||
    normalized.endsWith(".queue-it.net") ||
    normalized === "challenges.cloudflare.com" ||
    normalized === "hcaptcha.com" ||
    normalized.endsWith(".hcaptcha.com") ||
    normalized === "funcaptcha.com" ||
    normalized.endsWith(".funcaptcha.com") ||
    normalized === "arkoselabs.com" ||
    normalized.endsWith(".arkoselabs.com") ||
    normalized === "auth0.com" ||
    normalized.endsWith(".auth0.com") ||
    normalized === "okta.com" ||
    normalized.endsWith(".okta.com") ||
    normalized === "onelogin.com" ||
    normalized.endsWith(".onelogin.com") ||
    normalized === "cloudflareaccess.com" ||
    normalized.endsWith(".cloudflareaccess.com")
  );
}

function isNavigationUrlKey(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return /^(?:url|uri|(?:next|continue|destination|dest|goto|return|redirect|success|cancel|callback|forward|target|relay)(?:to|url|uri|path|location|destination)?)$/.test(
    normalized
  );
}

function isSensitiveUrlKey(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  const tokens = getSecurityTokens(value);
  const hasEmbeddedSensitiveToken = tokens.some(
    (token, index) =>
      /^(?:token|session|secret|nonce|jwt|ticket|credential|password|signature|authorization|assertion|relaystate|code)$/i.test(
        token
      ) ||
      (token.toLowerCase() === "key" && (tokens.length > 1 || index > 0))
  );
  const isSessionIdentifierFamily =
    /^(?:sid|cfid|cftoken|oscsid|connectsid|j(?:ava)?sessionid[a-z0-9]*|php(?:sess|session)id[a-z0-9]*|asp(?:net)?sessionid[a-z0-9]*|sessionid[a-z0-9]*)$/.test(
      normalized
    );
  return (
    isSessionIdentifierFamily ||
    hasEmbeddedSensitiveToken ||
    /^(?:booking|reservation|checkout|account|member|customer|user|teetime|course)(?:token|session|key|secret|nonce|ticket|credential|signature|authorization|code)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:token|secret|nonce|jwt|ticket|loginticket|serviceticket|authorization|signature|signed|sig|credential|password|expires?|expiry|expiration|assertion|relaystate|saml(?:response|art)?|oauth(?:token|code|state|verifier)?|authcode|verificationcode|session(?:id|token|key|state)?|clientid|responsetype|redirecturi|granttype|scope|codechallenge|codeverifier|(?:access|auth|id|api|client)(?:token|key|secret))$/.test(
      normalized
    ) ||
    /^(?:saml|oauth|openid|oidc|auth|authentication|login)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:sigalg|openidmode|openidreturnto|openidclaimedid|openididentity|openidrealm|openidassochandle|openidresponse(?:nonce)?|samlrequest|oauthnonce|oauthcallback)$/.test(
      normalized
    ) ||
    /^(?:prompt|codechallengemethod|responsemode|wresult|wctx|wreply|wtrealm|wa)$/.test(
      normalized
    ) ||
    /^(?:csrf|csrftoken|xcsrftoken|csrfmiddlewaretoken|xsrf|xsrftoken|formkey|requestverificationtoken|antiforgerytoken|authenticitytoken|verificationtoken|checkoutsessionid|paymentintent|orderid|transactionid|invoiceid|cartid)$/.test(
      normalized
    ) ||
    /(?:password|credential|signature|authorization|assertion|relaystate)/.test(
      normalized
    )
  );
}

function isContextualSensitiveParameter(key: string, value: string, url: URL) {
  const normalizedKey = key
    .normalize("NFKC")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  if (!/^(?:code|state|key)$/.test(normalizedKey)) {
    return false;
  }

  const hasAuthenticationContext = `${url.hostname}/${url.pathname}`
    .split(/[./_-]+/u)
    .map((segment) => segment.replace(/[^a-z0-9]/gi, "").toLowerCase())
    .some((segment) =>
      /^(?:callback(?:v?\d+)?|(?:auth(?:entication|orization|enticate|orize|n|z)?|oauth\d*|oidc|openid|saml|sso|signin|login)(?:callback(?:v?\d+)?)?)$/.test(
        segment
      )
    );
  const hasSensitiveCompanion = [...url.searchParams.keys()].some(
    (candidate) =>
      normalizeUrlKey(candidate) !== normalizedKey && isSensitiveUrlKey(candidate)
  );
  const hasSecretShapedValue =
    /(?:^|[^a-z0-9])(?:private|secret|token|credential|signature|session|nonce|ticket|auth)(?:[^a-z0-9]|$)/i.test(
      value
    );
  return hasAuthenticationContext || hasSensitiveCompanion || hasSecretShapedValue;
}

function normalizeUrlKey(value: string) {
  return value.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function decodeUrlComponent(value: string) {
  let decoded = value;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return decoded;
      }
      decoded = next;
    }
    return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function getSecurityTokens(value: string) {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isOpaqueCredentialValue(value: string) {
  return (
    /^(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]{12,}$/i.test(value) ||
    /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value) ||
    /^[A-Za-z0-9+/_-]{16,}={1,2}$/.test(value) ||
    (/^[A-Za-z0-9]{19,}$/.test(value) &&
      /[A-Za-z]/.test(value) &&
      /\d/.test(value)) ||
    (/^[A-Za-z]{19,}$/.test(value) &&
      /[a-z]/.test(value) &&
      /[A-Z]/.test(value))
  );
}

function isAllowedProviderIdentifier(segments: string[], index: number) {
  return (
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      segments[index] ?? ""
    ) && /^(?:programs?|courses?)$/i.test(segments[index - 1] ?? "")
  );
}

function isOpaqueRedirectPathSegment(segments: string[], index: number) {
  return (
    /^(?:go|r|redirect|link|magic|invite|token)$/i.test(
      segments[index - 1] ?? ""
    ) && /^[A-Za-z0-9_-]{16,}$/.test(segments[index] ?? "")
  );
}
