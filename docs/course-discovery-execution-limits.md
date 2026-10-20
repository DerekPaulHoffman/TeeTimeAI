# Learned course access: execution evidence and current limits

## Local browser transport

The discovery helper and recipe executor create a disposable, signed-out
Playwright browser context using `en-US` and the verified course timezone.
Discovery receives that timezone from its trusted job input. The trusted helper
obtains shared provider-request leases from the application; provider response
bytes remain on the local computer. Every immutable browser recipe records its
transport, and replay uses that saved choice:

- `PINNED_HTTP`, the compatibility default, fulfills intercepted requests using
  the local Node DNS-pinned HTTP transport. It preserves local egress but does
  not preserve Chrome's native TLS or ordinary anonymous cookie handling.
- `NATIVE_CHROME` continues guarded requests through Chrome and a local HTTPS
  CONNECT proxy. The proxy binds only to loopback, accepts DNS hosts on port 443,
  rejects private/reserved/mixed DNS answers, and pins its TCP connection to a
  checked public IP. Chrome retains end-to-end TLS and fresh anonymous cookies;
  the proxy does not decrypt TLS or inherit a signed-in browser profile.

Both paths enforce public URL and read-only request policies. Native CORS
preflights may name GET or POST; the actual POST independently requires a known
anonymous read shape. WebSockets and service workers are disabled. Request
leases last through `response.finished()` and body observation; native failure
cancels the affected host's tunnels before the lease is released. Deadlines, request
counts, response bytes, connections, and sockets are bounded. No fallback
silently changes the saved transport.

Neither transport is proof that sites readable by the installed Tee Time Spot
Local Reader will work in the new executor. The installed extension and its
existing provider parsers are unchanged. Active human-verification, login, and
queue screens remain access evidence; an informational mention of CAPTCHA in
booking instructions is not itself an access challenge.

## Deliberate interpreter limits

- Recipes contain bounded data and fixed operations, never JavaScript, shell
  commands, or an arbitrary evaluator. Public product selection is separate from
  selecting an appointment or tee time: only an exact Book/Select control within
  a duration-proven product card may use `selectProduct`.
- Discovery follows initial or observed public links. Up to five safe GET/HEAD
  redirects between the same hostname and its `www` variant are accepted. Other
  hostname changes and POST redirects are rejected. A visible provider link can
  be opened separately after it is observed. Replay still requires every URL
  and read method to match an exact permitted recipe route.
- Images, media, and fonts are not fetched. Evidence comes from DOM text and
  public structured data; image-only/canvas calendars are unsupported. Script,
  stylesheet, document, and data failures required by the availability surface
  still prevent complete proof. Known telemetry and the payment-only
  `js.stripe.com` client are aborted without counting as missing availability
  evidence; they receive no additional network authority.
- `EXISTING_ADAPTER` stores only typed identifiers for the existing ForeUP and
  Acuity public readers. Each replay rechecks public configuration and venue
  identity, then uses their fixed read-only routes, shared provider leases and
  normalized source IDs. A model cannot supply routes, code or extractors for
  this engine.
- `HTTP_JSON` request bodies currently support a flat object of scalar values
  and known parameter templates. They do not yet express arbitrary nested
  GraphQL query/variable documents, even though the network read policy can
  recognize some anonymous GraphQL queries.
- DOM field readers support explicit selectors, selected labels, limited
  attributes, integer conversion, and duration-unit conversion. `DATE_PARTS`
  combines a visible full month/year with a visibly selected numeric day;
  neither component comes from the requested date. `selectDate` navigates at
  most twelve months, verifying each adjacent displayed month before selecting
  the unique visible requested day. Independent final date proof still applies.
  Native selects and strictly labelled public player/duration comboboxes are
  supported. New markup may require a new supported interpreter operation;
  a model must not supply code to work around that limit. Ambiguous field
  selectors report `AMBIGUOUS_PROOF_FIELD`.
- An empty result needs explicit empty-state evidence. A visible generic
  container is insufficient. Incomplete or inaccessible pages do not become
  empty availability.
- Browser replay requires a quiet period with no pending provider reads before
  each of two identical DOM observations. A delayed read cannot leave stale
  slots certified merely because the requested date control already changed.
- Every browser recipe requires `availabilityResponse`: an exact URL and method,
  with a query or JSON-body date path equal to the requested day. A successful
  matching request must begin after the final date/filter mutation and finish
  before render synchronization and two matching DOM observations. Filters
  normally retire the preceding response proof. One fixed exception covers the
  inspected PassFactory `/ftbb` client: its date change resets duration, while
  its duration selector only recomputes local displayed availability. Replay
  verifies the actually loaded component and local availability utility scripts'
  SHA-256 values against the inspected versions, exact widget/hall identity and successful date-bound `hall-widget`
  response before allowing DATE then DURATION. It carries that response only
  if no new provider availability read starts; a later read immediately retires
  it and must complete with fresh matching proof. Final displayed duration,
  date, scoped resource and quiet/stable DOM checks still apply. An unknown or
  changed client fails closed with `UNVERIFIED_CLIENT_DURATION`. This capability
  is fixed in the executor, not a model-controlled bypass.
  Mere body/container presence is no longer completion proof; use explicit
  ready state or `proof.complete: {availabilityResponse: true}`. Response-only
  completion also requires an application-level JSON success guard, such as
  `availabilityResponse.success: {path: "code", equals: 200}`; an HTTP 200 error
  envelope cannot certify old visible slots. Existing browser
  recipes missing this fence are invalid and must be relearned; no automatic
  upgrade claims equivalent proof. The response fence proves freshness, not
  that opening-hour intervals alone are free inventory.
- Provider HTTP 429 responses remain `PROVIDER_THROTTLED` retry results; they
  do not prove account requirements or invalidate a previously working recipe.

## Matching contracts

Outdoor tee-time capacity is an availability predicate. Simulator player count
is saved customer context, not an availability predicate: one verified full
resource rental produces `availableSpots: 1`, with separate nullable capacity
metadata. Unknown capacity does not block a simulator match. A simulator recipe
cannot bind the saved player count into its availability request. An explicit
party/player field operation may only request the literal one-bay value `1`.

Simulator sessions must preserve one continuous resource and the entire
requested duration. End times can be derived only by the fixed
`ADD_REQUESTED_DURATION` operation after duration proof. `24:00` means the next
venue-local midnight. Both executor filtering and server acceptance compare
absolute start and end instants, so a session crossing the requested endpoint is
rejected even when its displayed hour appears earlier.

Every simulator DOM recipe also declares `slots.scope`: a resource-card selector,
a label reader relative to each card, and the exact observed public rental label.
Replay selects the unique matching visible card and extracts slots only inside
it; explicit empty-state evidence is also read only within that card.
The label must be a direct child of its card, which cannot contain nested cards
matching the same resource selector. A broad wrapper with a nested Golf heading
cannot combine that heading with adjacent sports' slots.
Rows must share one immediate container belonging to that card, and competing
resource headings are rejected even if the nested panels use different tags or
classes. The label must identify a simulator, rental, bay or room, rather than
the venue or page title.
Reordering adjacent sports/resources cannot change the chosen product;
missing, renamed or duplicate matching labels fail closed. Page roots and
clearly unrelated lesson/member-only products cannot serve as resource scopes.
When no provider resource ID is exposed, a `dom-label:` hash of the observed
matching label supplies an internal resource identity; it is not a provider ID.

Switching from a previous reader to a generic learned recipe preserves an
existing match source ID only for an unambiguous one-to-one opening with the
same search, course, offering, start/end, resource, product and holes. This
keeps an already-sent opening sent. Ambiguous identities stay separate.

## Evidence level

The focused recipe, executor, browser-session, and runtime-window tests include
isolated Chrome fixtures with an in-memory transport, malformed and missing
proofs, product selection, unknown simulator capacity, explicit empty states,
date/timezone boundaries, stale controls, and blocked navigation. These fixtures
make no provider requests and do not prove Production deployment, live provider
coverage, or delivery of the final three matching alerts. Those require separate
current end-to-end receipts.
