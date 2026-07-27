type HeaderReader = {
  get(name: string): string | null;
};

export function assertSameOriginOperatorMutation(headers: HeaderReader) {
  const originValue = headers.get("origin")?.trim();
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  const forwardedProtocol = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (!originValue || !host) {
    throw new Error("Operator mutation origin could not be verified.");
  }
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("Operator mutation origin is malformed.");
  }
  if (!["https:", "http:"].includes(origin.protocol)) {
    throw new Error("Operator mutation origin is not allowed.");
  }
  if (origin.host.toLowerCase() !== host.toLowerCase()) {
    throw new Error("Operator mutation origin does not match this site.");
  }
  if (
    forwardedProtocol &&
    `${forwardedProtocol.toLowerCase()}:` !== origin.protocol.toLowerCase()
  ) {
    throw new Error("Operator mutation protocol does not match this site.");
  }
}
