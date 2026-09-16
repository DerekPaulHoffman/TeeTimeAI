# Operator texts for new customer alerts

Customer notifications remain email-only. The operator can opt into two private
Twilio texts for each newly saved customer alert:

1. Account email, ranked courses, requested date, course-local time window, and
   player count, plus the authenticated operator page.
2. A status update scheduled five minutes after Twilio accepts the first message.
   This is always sent, including healthy, paused, completed, cancelled, or removed
   alerts. Carrier delivery time is outside the app's control.

Exclude configured owner account emails (case-insensitive, including plus aliases),
TEST/AUTOMATION traffic, synthetic multi-cycle/window searches, reserved test email
domains, and the historical stress-test email aliases. Identity comes from the
authenticated account, independently of the alert's chosen delivery address.
There is no historical backfill when the feature is enabled.

## Setup and release

Create a Twilio account, complete the provider's phone/sender verification, and
obtain an SMS-capable sender approved to message the US destination. Trial accounts
require a verified recipient and may require sender verification. See the
[Twilio SMS quickstart](https://www.twilio.com/docs/messaging/quickstart).

Apply migration `20260916170000_add_operator_alert_texts` to an isolated database
first, then apply it to production before deploying the dependent code. Keep
`OPERATOR_SMS_ENABLED=false` during rollout. Set these **server-only production**
environment variables through the provider dashboard or an ignored environment file:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`.
- `OPERATOR_SMS_TO`: the operator's destination in E.164 format.
- `OPERATOR_SMS_EXCLUDED_EMAILS`: comma-separated owner account addresses.
- `NEXT_PUBLIC_SITE_URL`: canonical HTTPS origin, with no path or credentials.
- `OPERATOR_SMS_ENABLED=true` only when the sender and recipient are ready.

`VERCEL_ENV=production` is also required. Local and preview executions do not
enqueue or send texts, even if other values were copied there. Customer SMS is not
enabled. Keep credentials, the private destination, and personal exclusions out of Git.

## Delivery and recovery

The initial outbox row is written in the same database transaction as the saved
alert. The API starts an independent Workflow after responding; a failure to start
is recovered by the existing five-minute search recovery cron. No SMS provider call
runs in the customer save transaction or the search-check workflow.

Each `(sourceSearchId, kind)` is unique. A compare-and-set claim prevents concurrent
workers from sending the same row. Acceptance creates exactly one follow-up row
and the Workflow sleeps until its persisted due time. Definite rate-limit
rejections retry up to five attempts. Permanent rejections are recorded as FAILED.
Network timeouts, 5xx responses, or abandoned sending leases become UNCERTAIN and
are not blindly resent because Twilio may already have accepted the message.

Twilio sends signed status callbacks to `/api/webhooks/twilio/operator-sms` using
the per-attempt URL supplied by the app. The signature uses the configured public
origin, not untrusted proxy headers. A matching account, attempt token, and Message
SID reconcile uncertain acceptance and preserve delivered/failed receipts over
late nonterminal callbacks. No callbacks need to be configured manually in Twilio.
Provider acceptance and confirmed delivery remain separate facts.

The status check reads a consistent database snapshot, using each selected
course's newest probe for the current alert generation, current scheduling state,
and pending/failed customer email deliveries. No matches and booking-window waits
are normal. Missing current evidence, unsupported courses, expired check leases,
failed or overdue schedules, and pending delivery retries require review. Unknown
health never becomes an optimistic success. This check does not change alerts or
invoke course providers.

Deleting an alert clears the foreign key but keeps the outbox snapshot so an
already-announced alert can receive its promised removal update. These rows contain
personal information; access them only through operator/database access. Do not
log bodies, account emails, destination numbers, or Twilio error messages. Stored
provider errors are bounded codes. No public endpoint exposes these records.

## Verification before activation

Run focused outbox/content/webhook tests and the repository gates. Validate the
additive migration on an isolated database. Once the account and production release
are ready, perform an explicitly authorized live operator test and verify both
Twilio receipts and the five-minute follow-up. Test searches remain excluded from
automatic customer-triggered texts; do not remove the exclusion for a smoke test.

Inspect `OperatorSmsDelivery.status`, `providerStatus`, `lastError`, `acceptedAt`,
and `nextAttemptAt` for failures. FAILED or UNCERTAIN rows need review before any
manual replay. Disable `OPERATOR_SMS_ENABLED` to stop sends; pending rows remain
durable and can resume when enabled. No retroactive rows are created.
