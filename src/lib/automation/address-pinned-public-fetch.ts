import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

type ResolvedPublicAddress = {
  address: string;
  family: 4 | 6;
};

type PinnedPublicRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  method: "GET" | "HEAD";
  headers: Headers;
  signal?: AbortSignal;
};

type NodeRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest;

export type AddressPinnedPublicFetchDependencies = {
  resolveAddresses?: (hostname: string) => Promise<ResolvedPublicAddress[]>;
  requestPinned?: (input: PinnedPublicRequest) => Promise<Response>;
  requestNode?: NodeRequest;
  timeoutMs?: number;
};

type AddressPinnedPublicFetchPolicy = {
  parseUrl: (value: string) => URL;
  maxResponseBytes: number;
  redirectLimit?: number;
  timeoutMs: number;
};

const nonPublicNetworkBlockLists = buildNonPublicNetworkBlockLists();

export function createAddressPinnedPublicFetchTransport(
  policy: AddressPinnedPublicFetchPolicy,
  dependencies: AddressPinnedPublicFetchDependencies = {}
): typeof fetch {
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const requestPinned =
    dependencies.requestPinned ??
    ((input: PinnedPublicRequest) =>
      requestPinnedPublicUrl(input, policy.maxResponseBytes, dependencies.requestNode));
  const timeoutMs = Math.max(1, dependencies.timeoutMs ?? policy.timeoutMs);
  const redirectLimit = policy.redirectLimit ?? 4;

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const requestInput = input instanceof Request ? input : null;
    const method = (init?.method ?? requestInput?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("Official-site discovery supports only safe read requests");
    }
    if (init?.body || requestInput?.body) {
      throw new Error("Official-site discovery requests cannot include a body");
    }
    const headers = new Headers(requestInput?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (
      headers.has("authorization") ||
      headers.has("proxy-authorization") ||
      headers.has("cookie")
    ) {
      throw new Error("Official-site discovery requests cannot include credentials");
    }
    headers.delete("host");
    headers.set("accept-encoding", "identity");
    const redirectMode = init?.redirect ?? requestInput?.redirect ?? "follow";
    const callerSignal = init?.signal ?? requestInput?.signal ?? undefined;
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineSignal])
      : deadlineSignal;
    let currentUrl = policy.parseUrl(
      requestInput?.url ?? (input instanceof URL ? input.toString() : String(input))
    );

    for (let redirectCount = 0; redirectCount <= redirectLimit; redirectCount += 1) {
      const addresses = await resolveAddressesWithSignal(
        currentUrl.hostname,
        resolveAddresses,
        signal
      );
      const target = selectPinnedPublicAddress(addresses);
      const response = await waitForSignal(
        requestPinned({
          url: currentUrl,
          address: target.address,
          family: target.family,
          method,
          headers,
          signal
        }),
        signal
      );
      setResponseUrl(response, currentUrl.toString(), redirectCount > 0);

      if (response.status < 300 || response.status >= 400) {
        return response;
      }
      if (redirectMode === "manual") {
        return response;
      }
      if (redirectMode === "error") {
        throw new Error("Official site returned a redirect");
      }
      const location = response.headers.get("location");
      if (!location || redirectCount === redirectLimit) {
        throw new Error("Official site returned an incomplete redirect");
      }
      currentUrl = policy.parseUrl(new URL(location, currentUrl).toString());
    }

    throw new Error("Official site exceeded the redirect limit");
  }) as typeof fetch;
}

async function resolvePublicAddresses(hostname: string) {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family as 4 | 6
  }));
}

function resolveAddressesWithSignal(
  hostname: string,
  resolveAddresses: (hostname: string) => Promise<ResolvedPublicAddress[]>,
  signal?: AbortSignal
) {
  const resolution = resolveAddresses(hostname);
  return signal ? waitForSignal(resolution, signal) : resolution;
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(getAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function getAbortReason(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("Official-site discovery timed out", "AbortError")
  );
}

function selectPinnedPublicAddress(addresses: ResolvedPublicAddress[]) {
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family ||
        address.includes("%") ||
        (family === 4
          ? nonPublicNetworkBlockLists.ipv4.check(address, "ipv4")
          : nonPublicNetworkBlockLists.ipv6.check(address, "ipv6"))
    )
  ) {
    throw new Error("Official site resolved to a non-public network address");
  }
  return [...addresses].sort(
    (left, right) =>
      left.family - right.family || left.address.localeCompare(right.address)
  )[0];
}

function buildNonPublicNetworkBlockLists() {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const) {
    ipv4.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ] as const) {
    ipv6.addSubnet(network, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function requestPinnedPublicUrl(
  input: PinnedPublicRequest,
  maxResponseBytes: number,
  requestNode?: NodeRequest
) {
  const request =
    requestNode ??
    ((input.url.protocol === "https:" ? httpsRequest : httpRequest) as NodeRequest);
  const lookup = createPinnedLookup(input.address, input.family);
  const headers = Object.fromEntries(input.headers.entries());

  return new Promise<Response>((resolve, reject) => {
    const clientRequest = request(
      input.url,
      {
        method: input.method,
        headers,
        lookup,
        family: input.family,
        agent: false,
        signal: input.signal,
        ...(input.url.protocol === "https:" && isIP(input.url.hostname) === 0
          ? { servername: input.url.hostname }
          : {})
      },
      (incoming) => {
        const contentLength = Number(incoming.headers["content-length"] ?? 0);
        if (contentLength > maxResponseBytes) {
          incoming.destroy();
          reject(new Error("Official site page is too large to inspect safely"));
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > maxResponseBytes) {
            incoming.destroy(
              new Error("Official site page is too large to inspect safely")
            );
            return;
          }
          chunks.push(buffer);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const status = incoming.statusCode;
          if (typeof status !== "number" || status < 200 || status > 599) {
            reject(new Error("Official site returned an invalid HTTP status"));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => responseHeaders.append(key, item));
            } else if (value !== undefined) {
              responseHeaders.set(key, String(value));
            }
          }
          try {
            resolve(
              new Response(
                input.method === "HEAD" || [204, 205, 304].includes(status)
                  ? null
                  : Buffer.concat(chunks),
                {
                  status,
                  statusText: incoming.statusMessage,
                  headers: responseHeaders
                }
              )
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    clientRequest.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Official site attempted an unsupported protocol upgrade"));
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean } | number,
    callback: (...args: unknown[]) => void
  ) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;
}

function setResponseUrl(response: Response, url: string, redirected: boolean) {
  try {
    Object.defineProperties(response, {
      url: { configurable: true, value: url },
      redirected: { configurable: true, value: redirected }
    });
  } catch {
    // Response metadata is advisory; callers retain the validated request URL.
  }
}
