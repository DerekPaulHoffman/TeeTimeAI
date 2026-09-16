# Private operator phone notifications

These are Web Push notifications for the configured operator's Android Chrome device. No email, SMS, Telegram account, or paid messaging plan is used for this channel. Ordinary customer tee-time emails keep their existing behavior. Hosting and database usage remain on the application's existing plan.

## Behavior

- A newly persisted real customer alert creates one private notification with the authenticated account email, ranked courses, date, course-local time window, and player count.
- Always queue a second notification five minutes after the push service accepts the first. Vercel Workflow sleeps until that time; the website and phone browser do not need to stay open. Device connectivity and OS settings can delay actual display.
- The follow-up reads current alert details and each selected course's newest evidence. It distinguishes healthy monitoring, booking-window waits, missing or failed coverage, stalled scheduling, current email delivery failures, and an ended or removed alert. It never labels old provider evidence as a successful current check.
- Exclude the configured operator and aliases, additional configured excluded emails, TEST/AUTOMATION traffic, synthetic searches, and known test-account patterns. Anonymous browsing is not an alert-creation event.
- One phone subscription per configured operator. Replacing or removing a subscription suppresses pending deliveries addressed to the old device. Already accepted pushes cannot be recalled. Nothing is backfilled when a phone opts in.

## Production configuration

Apply `20260916170000_add_operator_alert_notifications` to the direct database connection before deploying the code. Configuration is inert unless both `VERCEL_ENV=production` and `OPERATOR_NOTIFICATIONS_ENABLED=true`.

Required server environment variables:

```text
OPERATOR_NOTIFICATIONS_ENABLED=true
OPERATOR_NOTIFICATIONS_OWNER_EMAIL=derekpaulhoffman@gmail.com
OPERATOR_NOTIFICATIONS_EXCLUDED_EMAILS=derekpaulhoffman@gmail.com
OPERATOR_PUSH_VAPID_PUBLIC_KEY=<generated public key>
OPERATOR_PUSH_VAPID_PRIVATE_KEY=<generated private key>
NEXT_PUBLIC_SITE_URL=https://teetimespot.com
```

The owner must also be an existing verified Clerk operator in `OPERATOR_DASHBOARD_EMAILS`. Generate the VAPID pair once using `web-push.generateVAPIDKeys()`, write directly to an ignored `.env.operator-notifications.local` or the provider's secret environment configuration, and do not print or commit the private key. Keep the same pair across releases. The VAPID contact is the HTTPS site origin, not an email transport.

After the approved release, open `https://teetimespot.com/operator` in Chrome on the Android phone, sign in as the configured owner, tap **Enable on this phone**, and allow notifications. Tap **Send test notification** and confirm it appears. Then close the website. The push-only service worker displays notifications in the background; tapping one opens the authenticated operator overview. No installation or permanently open tab is required. Chrome and site notification permission must remain enabled, and Android force-stop or battery restrictions can interrupt delivery.

The notification preview contains customer details requested by the operator. Android's lock-screen notification settings control whether that preview is visible while locked.

## Security and recovery

- The setup endpoint requires the designated verified Clerk operator and same-origin mutations. Browser subscription URLs and encryption keys are private server data; the status endpoint returns only the public VAPID key and a device fingerprint.
- Only HTTPS Chrome FCM push endpoints are accepted. Client-provided arbitrary network destinations, credentials, ports, invalid keys, and oversized bodies are rejected. Send failures log only bounded codes.
- The unique `(sourceSearchId, kind)` outbox key and compare-and-set send claim prevent duplicate work. Definite rate limits retry with bounded attempts. Timeouts, missing receipts and abandoned claims become `UNCERTAIN` instead of blind resends.
- `ACCEPTED` means the push service accepted the encrypted message. It does not prove phone display. There is no SMS or email fallback. A missing phone notification must not be represented as delivered.
- Expired subscriptions (404/410) are removed. Re-enable on the phone. The explicit test button is rate limited to one send per 30 seconds.
- The existing authenticated five-minute recovery cron restarts due outbox deliveries when Workflow launch fails; normal five-minute follow-ups use durable Workflow sleep. No Codex poller is introduced.
- Set `OPERATOR_NOTIFICATIONS_ENABLED=false` to stop new sends. The phone's **Stop on this device** button removes its subscription. To inspect failure counts, query `OperatorNotificationDelivery` without dumping customer summaries, endpoints, or keys.

## Verification

Focused tests cover owner/test exclusions, latest-evidence health, private setup authorization, origin checks, SSRF fences, phone replacement, expired subscriptions, encrypted transport options, retry/uncertainty, and service-worker display without an open page. Durable delivery integration tests require `OPERATOR_NOTIFICATIONS_TEST_DATABASE_URL` to point to an isolated loopback database named `operator_notifications_test`; they never use production.

Final live proof still requires the approved deployment, explicit phone permission, an observed test push, and an observed initial/five-minute pair. A local test or provider acceptance alone is not phone-delivery proof.
