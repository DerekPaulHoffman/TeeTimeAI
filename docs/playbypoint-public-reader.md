# Public simulator rentals through PlaybyPoint

This learned-recipe reader runs in local Chrome. It does not register a legacy
server-dispatch adapter or change that dispatcher's supported provider list.

The fixed reader supports the public 60-minute simulator rental. It derives a
booking subdomain from the current official site's links, checks the venue name
and complete address on that site's public booking homepage, and reads its
visible PlaybyPoint facility widget in a new anonymous local Chrome context.

The reviewed public client is index-DzGwOgJj.js, SHA-256
01d6ff63449aea7b0b82386704e91cc8817dbc6f8064642f8b935e67f0116f65.
Its public bootstrap header is checked by digest. Account queries, mutations,
checkout, court selection and other GraphQL operations are rejected. The
provider's two public metadata queries have exact query and input schemas.
This permission belongs to the fixed reader and leaves generic browser policy
unchanged.

Each execution verifies the selected date, canonical timezone, public Simulator
scope and complete bay catalog. For every permitted start within the alert
window, it requests the exact 60-minute interval and retains only the returned
eligible bays. Two separate half-hour rows cannot establish a continuous bay.
The public form clears a selected range when its selected start is clicked
again. The reader verifies that reset before requesting the next interval.

The Sports Haus reproduction returned 34 verified bay intervals for November
19, 2026, from 9 a.m. through 6 p.m. via the normal recipe executor. This local
reader check precedes independent production recipe replay, alert delivery and
restart acceptance.

The first released worker trial found a separate source-routing gap: Stagehand
selected an account link on the otherwise public official homepage, then its
retry exhausted the source budget without reaching this reader. Recovery now
requires a completed, current public root, a link denied before any action,
closed browser/model resources, and the original job clock. It starts only a
fresh typed-adapter investigation at that root. The denied link stays blocked;
its URL and facts confer no routing, inventory or activation authority. A guard
denial after navigation, an access response, another page, or incomplete cleanup
does not qualify. Regression cases cover the exact failure and those exclusions.
