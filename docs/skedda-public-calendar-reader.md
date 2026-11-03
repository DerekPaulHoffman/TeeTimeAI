# Public simulator calendar reader

The `SKEDDA` saved method reads public simulator rentals through an anonymous,
isolated local Chrome session. It uses the existing browser launcher, public
address proxy, provider-family leases, recipe verification and delivery pipeline.
It does not use a course account, select a time, or submit a booking.

Discovery requires the ordinary official-site booking link. Inspection then
verifies the provider tenant, venue name, full canonical building address,
official-site backlink, current timezone agreement and actually rendered
simulator resources. An explicitly published provider unit may refine a
canonical building address; an existing canonical unit cannot be discarded.
Other rooms are excluded. The saved immutable method contains identifiers and a
hash of the normalized public identity and rules. Replay independently rereads
that configuration and fails when it changes.

Chrome's anonymous verification header remains inside its fresh profile. Only
the publisher's own same-origin GETs to `/webs` and `/bookingslists` may carry it.
Credentials and full provider payloads are never serialized into the recipe.
The reader projects only identity, rental rules, resource metadata and occupied
intervals. It rejects POSTs, request bodies, authentication headers, payment
frames, foreign data endpoints and arbitrary navigation. Two exact public Stripe
libraries needed for rendering may load; payment APIs and frames remain denied.
The existing one-family/two-global request leases remain authoritative.

Availability requires a completed successful calendar response whose explicit
range covers the entire requested local date. List IDs, booking rows and that
date's index must agree. The reader evaluates ordinary anonymous access,
published hours, supported duration/tag conditions, lead time and booking
horizon. It subtracts occupied intervals separately for each simulator and emits
only complete requested sessions inside the saved window. Published party
capacity remains metadata; it does not turn several bays into one opening.

The initial rule grammar supports the publisher's duration, relative start/end
and anonymous tag predicates; inclusive tag-scoped booking windows; and quotas
restricted to named tags. Recurrences, free-calendar event overrides, approval
rules, buffers, public quotas, unrecognized predicates and ambiguous hour
precedence require additional support. They return incomplete evidence, never
an empty successful check. A recipe failure follows the existing repair path.

Each browser read is bounded by 75 seconds and the original job deadline. It
uses at most 250 intercepted requests, 250 proxy connections and 32 MB of tunnel
traffic. The provider rules were checked against its public shipped client and
[booking-condition documentation](https://support.skedda.com/en/articles/112700-booking-conditions).
Public schedule access is described in its
[access documentation](https://support.skedda.com/en/articles/105728-access-and-visibility).

Focused tests cover identity conflicts, tenant binding, changing source-object
key order, public hours, complete session overlap, resource separation,
booking-window limits, incomplete response joins, unsupported rules, transport
rejection and credential redaction. Live receipts belong outside the repository.
