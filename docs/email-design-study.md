# Tee Time Spot email design study — revision 4

Twenty offline directions revised October 27, 2026 after the user rejected the first
set. Production templates, transport, recipients, outbox and customer demand are unchanged.

## User-approved direction

Preserve the original photo course headers and the green, orange and cream visual system
used by the search page, dashboard and current emails. Clearly distinguish newly found
openings from existing openings, and mock the distinct states a course or simulator can
be in. The first set removed too much of that recognizable visual design. The user then selected the first new/existing card in the state playground as the reference and asked to remove priorities and align all other states to it.

## Design contract

- Visual thesis: familiar Tee Time Spot photo cards, dark-green mastheads, orange emphasis,
  rounded white surfaces on cream and strong, readable availability.
- No priority/rank badges in any current preview. Venue order is only fixture display order; production search sorting and persistence are unchanged.
- All non-availability states use the same rounded card panel, brand colors, status icon, readable heading, What happens next row and action styling. No state is presented as NEW unless it has new verified matches.
- Content plan: brand and mode, email purpose, requested date/window, photo headers,
  newly found matches, previously shared/reconfirmed matches, venue-specific states and
  next actions, then alert management.
- Interaction thesis: the gallery has restrained navigation feedback, a brief title
  entrance and live state/size switching. Actual email concepts contain no JavaScript.
- Palette from src/app/globals.css: #14231d ink, #1f7a4d fairway, #e28a2f orange,
  #f4efe5 paper, #5c6c64 muted and #d9e3dc borders. No alternate simulator brand palette.
- Photo headers use existing public/email/course-card-1.png for courses and
  public/images/indoor-golf-simulator-hero.webp for indoor sessions. These are shared
  brand illustrations, not exact venue photographs. The gallery states that limitation.
- Orange NEW marks newly found matching openings. Existing openings are explicitly
  previously shared and reconfirmed at the current observation. No new observation is
  treated as proof of a newly released or cancelled slot.
- New, existing, stale and gone are distinct. Stale times are not shown as available;
  gone times are greyed and crossed out. Out-of-window times cannot trigger an alert.
- Setup/morning email purpose and per-venue availability are independent. A morning
  report can have real matches. Selecting a non-new scenario switches the instant
  email preview to a visible morning/status report; no unsupported instant send is implied.
- Simulator examples use a complete 60-minute interval for one bay. Never display holes,
  green fees, golfer capacity claims or outdoor availability as simulator rental evidence.
- Unconfirmed and private/invalid states never claim public rental/access or show active
  matching times. Retry, adding support and team review never collapse into no matches.
- Links are inert placeholders; received-email bearer links and recipient details are excluded.
- Course status is distinct from alert lifecycle, delivery retry state and provider acceptance.

## Evidence and scope

Revision 1 inspected the linked Gmail simulator thread plus four received simulator
match/setup/morning and outdoor setup messages. Current renderer/status sources:
src/lib/email/customer-email.ts, search-status.ts, simulator-email.ts and
src/lib/customer-monitoring-status.ts. The current public /search appearance was also
visually inspected on October 27; dashboard cards were read from source.

The source checkout base is 61ab2bd766b04bb245148792ed2aefe257693e3e.
Changes are uncommitted on feature/improve-alert-email-designs. No runtime application
paths changed. The old generator and verification are preserved outside the repository
as revision-1-source.mjs and verification-v1.json.

## State fixtures

The interactive selector and states.html contain 18 scenarios for each mode:

1. Mixed: new + existing matches, no match, booking not open, retrying, official site only.
2. New matches only.
3. Previously shared matches still available.
4. Successful check with no matching openings.
5. First check in progress.
6. Booking not open (explicit sample release time).
7. Temporary check failure with retry.
8. Adding alert support.
9. Our team needs to check the booking setup.
10. Official site only.
11. Phone/contact only.
12. Provider account required.
13. Provider verification/waiting-room required.
14. Private, invalid or no verified public rental.
15. Checking restored with currently confirmed existing matches.
16. Older availability not reconfirmed.
17. Previously shared openings no longer available.
18. Availability outside the requested window.

These are synthetic render fixtures, not claims about the named real venues.
Support/review/account/verification states use honest current capability and next-action
copy, without exposing implementation terminology or promising a support timeline.
Course bookable round length, physical layout and player count stay distinct; simulator
player count is not a bay capacity or availability predicate.

## Generate and verify

```powershell
node scripts/design/email-design-lab.mjs <output-directory>
node scripts/design/verify-email-designs.mjs <output-directory> <existing-dependency-root>
node scripts/design/serve-email-designs.mjs <output-directory> 4387
```

The verifier uses existing @playwright/test and sharp dependencies plus an isolated
headless Chrome. It blocks HTTP(S) and checks all 20 directions × both modes × all
18 states at 320, 375 and 680 px, plus long-name/dense-list stress cases. The reference
direction gets 414/768/1024 px and setup/morning/instant combinations. Checks include
photo loading, mode semantics, exact new/existing counts and colors, current vs stale/gone
claims, overflow, clipping, minimum link height and browser errors. Gallery interaction,
exact iframe widths, every state selection and state-board filters are also exercised.
Images-off samples retain venue identity, availability text, status and actions.

It writes 40 layout screenshots, 36 individual state-card screenshots, an overview
image and verification.json outside the repository. Read the receipt for the current
result rather than reusing revision 1's pass count.

This is a reviewable browser-rendered prototype. Native Gmail/Outlook/Apple Mail and
automatic dark-mode conversion remain unverified. A selected direction still needs
integration with the existing shared renderer and actual delivery payload checks before
release. No email is sent and no comprehensive runtime suite is claimed by this study.

## Customer wording contract

- Trust comes from specific facts, named ownership and a clear next step.
- Healthy completed checks say we are watching; no matches is different from an incomplete check.
- Use No action needed for automatic follow-up that is actually scheduled/owned. Existing matches may still need the golfer to book; No action needed refers to keeping the alert running.
- Retry copy acknowledges an incomplete attempt without presenting it as no availability.
- Working on it is reserved for active research/setup work. Waiting-for-review copy never implies an assigned person or active retry.
- Manual, phone, account, verification and invalid-venue examples use Your next step. They do not promise automatic checks or claim nothing is needed.
- State descriptions contain the known fact. A single next-step row owns the future action; do not repeat it in the description.
- Use Updated for the report timestamp. Do not imply that every venue completed a successful check.
- State-specific booking release times need actual evidence; no other retry or support ETA is invented.
- Production integration must map active-work claims to current durable work ownership and automatic follow-up claims to scheduler state. These remain mock fixtures.
- Copy edits do not authorize live email sends or changes to customer demand.

