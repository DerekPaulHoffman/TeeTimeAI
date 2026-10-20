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
  On Windows this path uses a visible managed Chrome window: the inspected
  public legacy calendar returned403 to headless Chrome and exposed inventory
  in a fresh visible window. Discovery and replay use the same presentation.
  The installed user profile and Local Reader are not reused or modified.

Both paths enforce public URL and read-only request policies. Native CORS
preflights may name GET or POST; the actual POST independently requires a known
anonymous read shape. WebSockets and service workers are disabled. Request
leases last through `response.finished()` and body observation; native failure
cancels the affected host's tunnels before the lease is released. Deadlines, request
counts, response bytes, connections, and sockets are bounded. No fallback
silently changes the saved transport.

Native redirects are intercepted through a separate Chromium Fetch session
before dispatch. Initial and redirected requests use the same policy, provider
lease, request budget, and response-evidence handler. Response completion and
body bytes come from the current browser's Network events, so a redirect cannot
silently skip either the guard or the final availability evidence. The current
qualified native path is the main frame only. Subframe requests, including
cross-process iframe requests, are rejected before dispatch and reported as
unsupported capabilities without terminating an otherwise usable main page.
Their contents and mere frame presence grant no source or navigation authority;
a late interceptor attach has not proved safe for their first redirect. Foreign
popup requests are also rejected. This does not change the installed Local
Reader's supported providers.

The pinned browser path rejects redirects instead of releasing a Location into
an unpinned browser request. A provider requiring that transition needs a
qualified native main-frame path or another supported reader. Such a failure
cannot become empty availability or an inferred authentication requirement.

Decoded responses are capped at 16 MB per script, 6 MB per stylesheet, and
2 MB per document or data response, with 48 MB total per disposable browser
session. The native CONNECT proxy separately caps encrypted wire traffic at
24 MB; request and connection caps are unchanged. These are different byte
measurements: the observed public calendar bootstrap was 2.76 MB compressed
and 14.50 MB decoded. Its official-site-to-calendar path exceeded the previous
24 MB decoded session limit. A rejected body is not included in the worker's
accepted-response byte total, so that metric alone understates rejected traffic.

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
- Discovery follows initial or observed public links. The qualified native path
  accepts up to five safe GET/HEAD redirects between the same hostname and its
  `www` variant. Other
  hostname changes and POST redirects are rejected. A visible provider link can
  be opened separately after it is observed. Replay still requires every URL
  and read method to match an exact permitted recipe route.
- Images, media, and fonts are not fetched. Evidence comes from DOM text and
  public structured data; image-only/canvas calendars are unsupported. Script,
  stylesheet, document, and data failures required by the availability surface
  still prevent complete proof. Known telemetry and the payment-only
  `js.stripe.com` client are aborted without counting as missing availability
  evidence; they receive no additional network authority.
- `EXISTING_ADAPTER` stores only typed identifiers for the existing ForeUP,
  Acuity and TeeItUp public readers. TeeItUp identifiers come from the observed
  official booking URL and public directory; name, street address, timezone and
  the exact facility set must agree. Each replay rechecks public configuration and venue
  identity, then uses their fixed read-only routes, shared provider leases and
  normalized source IDs. A model cannot supply routes, code or extractors for
  this engine.
- A TeeItUp alternate street address requires a controller-observed official
  page with a complete venue name, exact booking link and full public address.
  Its locality, state and ZIP must match the stored address, and exactly one
  non-simulator directory facility must match the official address, full name
  and timezone. Only a terminal `Golf Club`/`Golf Course` name difference is
  normalized; partial names and ambiguous facilities are rejected. The stored
  course address is retained. Discovery corroborates rendered visibility;
  each independent replay and warm execution re-fetches the official HTML and
  compares the same semantic text and markup witness. This is public-source
  evidence, not a geographical proximity claim or a fresh computed-CSS check.
  Hidden markup, changed witnesses, changed identity and ambiguous addresses
  fail closed. The model cannot supply this attestation.
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
- `APPLY_DATE` can confirm a selected day only inside the same visible public
  calendar, with its full month/year and selected day verified. It retires the
  previous response proof. A generic Apply button or dialog is insufficient.
- Outdoor availability rendered entirely in the dated main-document response
  can use `availabilityResponse.kind: SERVER_DOCUMENT` together with
  `proof.complete: {serverDocument: true}`. This requires a complete HTTP 200
  HTML document, bounded static selectors, and matching venue, date, capacity
  and every extracted row in both the inert source and two settled DOM reads.
  Pagination, script-only inventory, partial documents, later data reads and
  missing player-capacity evidence fail closed. It does not infer remaining
  places from a course's general group-size or pricing policy.
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

## Public action and date-picker limits

Mindbody's public service page uses Next server actions even for reads. Four
independently inspected action IDs are permitted for displayed-service prices,
next-available labels, service-ID decoding and public service-routing flags.
Each has an exact argument schema, requires the official HTTPS host and public
services route, and binds Origin and Referer to the same widget. Unknown actions,
extra fields, private staff filters, credentials and transaction fields are
rejected. The public Next-Action header is forwarded only after this validation;
a GraphQL-looking body cannot authorize an unknown server action.

The schedule's separate multipart availability action remains unsupported.
It carries an opaque bound argument, so accepting its body shape alone would
not establish source provenance. Observing the service cards is not proof that
date-specific monitoring works for this provider.

`APPLY_DATE` handles public pickers that commit the selected date separately.
It accepts only Apply/Apply dates inside an observed visible month/year and
numeric-day grid, outside sensitive/contact and checkout contexts. Replay also
requires the previously selected requested day in that same picker. Applying
the filter invalidates prior response evidence: the subsequent successful
date-bound response and complete source-date proof are still required.

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

The fixed `LIGHTSPEED` simulator reader uses only exact, anonymous HTTPS GETs.
Each run verifies the canonical official title/address and its sole company
booking link, then reads the complete public service catalog. Literal
`self.__next_f.push` JSON is decoded as data; no script or React reference is
executed. The observed client lists `availableDurations` and matches the
duration variation even when that child variation's `bookable` field is false;
the public parent service and its online-booking flag remain required.

Every eligible requested-duration service is read independently. The current
contract supports one explicit location per service and no employee assignment;
ambiguous variations and multi-location products fail closed. Each returned
document must echo its exact request path/query and match company, service,
variation, duration, location and timezone. Explicit slot starts must fall on
the requested venue-local date. End times follow the inspected public client's
start-plus-duration behavior. Unknown golfer capacity remains null. A failure
on any required product discards the whole result; one bay cannot establish
venue-wide completeness or an empty result. Empty lists require the provider's
explicit no-available-times text on every required product. Source redirects
are rejected, reads retain provider/global leases through body completion,
and no session or customer fields are persisted.

Generic browser recipes also support duration/price product buttons, exact
public navigation anchors and full-date button grids. These controls retain
transaction, selected-time, visibility and ambiguity guards. They do not relax
the separate venue/date/completeness or full-resource evidence requirements.

The fixed `WHOOSH` simulator reader uses two fixed anonymous GraphQL queries.
It verifies the observed club/facility identity, provider timezone, simulator
and golf type, public flags, complete course/bucket connections, and one complete
requested-date agenda. Both minimum and maximum duration equal the request;
one group is requested independently of saved player context. The public
client's `availableTimes` and `seriesLength * 15` contract proves the available
duration. Display blocks are not interpreted as free intervals or subtracted
again. GraphQL errors, partial connections, unknown resources, contradictory
dates, insufficient duration and blocking restrictions fail closed.

Whoosh resource identity is the provider's pooled course bucket, not an inferred
physical bay. Provider scheduling capacity is not recorded as a golfer limit;
`capacity` remains null. The alert link retains the observed official agenda
URL, which can contain `today` or the discovery date. Users may need to select
the date shown in the alert after following that link; execution still reads
and verifies the requested date independently.

The fixed `USCHEDULE` existing-adapter recipe binds one observed public simulator
rental by tenant, service ID and exact service name. It rechecks that the tenant
matches the canonical venue name (punctuation, spaces and `&`/`and` only), the
actual document tenant, the selected rental, one-bay quantity, unrestricted
resource selector and requested duration on every returned page. A literal
provider `chosenDate` declaration is parsed without execution and must match
the requested date. The reader follows only the exact observed continuation
cursor and requires a later-day witness before declaring the requested day
complete. A partial first page cannot establish empty or complete availability.

That reader creates a fresh, execution-only `ASP.NET_SessionId` from the exact
public booking GET. It injects only that anonymous cookie into the same pinned
HTTPS origin and tenant route, keeps it in memory, and discards it when the read
ends. Recipe inputs, environment credentials and previous browser sessions
cannot supply the cookie. Only observed public rental/date/duration filters and
the fixed pagination operation are permitted; time, payment, cart, contact,
membership and checkout operations remain excluded. The public filter browser
policy has the same bounded operation semantics, but complete USchedule date
results use the fixed adapter rather than generic DOM presence as proof.

Cold discovery snapshots the available model catalog before claiming work and
reuses that immutable snapshot for its workers. A temporarily incomplete local
catalog must not consume a database attempt. Warm recipe execution does not
require a model catalog. Local validation permits at most five seconds of
workstation/database clock difference; database lease and deadline expiry checks
remain strict, and retries retain the first pickup's original deadline.

Postgres serialization conflicts retry the complete transaction at most five
times with bounded backoff. This includes commit-time conflicts surfaced
directly by the Prisma PostgreSQL adapter. Each retry rechecks current ownership
and database time; it does not consume a discovery attempt or extend a lease or
deadline. Authentication and unrelated database failures are not retried here.

The focused recipe, executor, browser-session, and runtime-window tests include
isolated Chrome fixtures with an in-memory transport, malformed and missing
proofs, product selection, unknown simulator capacity, explicit empty states,
date/timezone boundaries, stale controls, and blocked navigation. These fixtures
make no provider requests and do not prove Production deployment, live provider
coverage, or delivery of the final three matching alerts. Those require separate
current end-to-end receipts.
