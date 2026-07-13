import Link from "next/link";

import {
  EditorialNote,
  EditorialPage,
  EditorialSection
} from "@/components/editorial-page";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "Privacy Notice";
const description =
  "Read the Tee Time Spot privacy notice, including the account, tee-time alert, feedback, and aggregate usage data the service handles.";
const path = "/privacy";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  dateModified: "2026-07-13"
});

export default function PrivacyPage() {
  return (
    <EditorialPage
      eyebrow="Privacy"
      title="A plain-language privacy notice for Tee Time Spot."
      intro="This notice explains what information Tee Time Spot handles, why it is used, which service providers help operate the product, and the choices available to you."
      summary="Tee Time Spot uses account and alert details to operate saved searches and send emails. Usage measurement is aggregate and intentionally avoids persistent visitor or session identifiers."
      updated="July 13, 2026"
      toc={[
        { id: "scope", label: "Scope" },
        { id: "collect", label: "Information handled" },
        { id: "use", label: "How information is used" },
        { id: "providers", label: "Service providers" },
        { id: "retention", label: "Retention and security" },
        { id: "choices", label: "Your choices" },
        { id: "children", label: "Children and changes" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="scope" eyebrow="Effective July 13, 2026" title="This notice covers the Tee Time Spot website and alert service.">
        <p>
          Tee Time Spot provides public golf course discovery, saved tee-time alerts, alert emails,
          search management, and product feedback. This notice does not govern a golf course,
          booking provider, Discord, or another third-party site that you open from Tee Time Spot.
          Those services have their own privacy practices.
        </p>
      </EditorialSection>

      <EditorialSection id="collect" eyebrow="Information categories" title="What Tee Time Spot handles.">
        <h3>Account and contact information</h3>
        <p>
          When account access is enabled, Tee Time Spot receives an account identifier and email
          address from the account provider. If you add playing partners to an alert, their email
          addresses are stored as additional recipients. Feedback can include an optional reply
          email.
        </p>
        <h3>Alert preferences and activity</h3>
        <p>
          Saved alerts include selected and ranked courses, future date, time window, player count,
          requested hole count when used, time-zone context, alert status, and delivery recipients.
          Operational records include checks, observed matches, delivery status, and the official
          booking links used in alerts.
        </p>
        <h3>Location and course discovery</h3>
        <p>
          A typed city, ZIP code, address, or browser-provided coordinates may be used to find nearby
          courses. Browser location requires your permission. Saved alerts retain selected course
          records rather than a history of every location query.
        </p>
        <h3>Feedback and aggregate usage</h3>
        <p>
          Tee Time Spot stores feedback type, message, page path, optional contact email, and a
          traffic classification that separates public, test, and automated activity. Product events
          can record a page path, action label, coarse discovery source, and limited workflow counts.
        </p>
        <EditorialNote label="Privacy by design">
          <p>
            Analytics remove query strings and URL fragments because they can contain private
            values. Discovery attribution stores only a fixed label such as AI referral, search
            engine, direct, internal, or other referral. Tee Time Spot does not create a persistent
            visitor or session identifier for this measurement.
          </p>
        </EditorialNote>
      </EditorialSection>

      <EditorialSection id="use" eyebrow="Purposes" title="Why the information is used.">
        <ul>
          <li>Find likely-public courses near the location you request.</li>
          <li>Create, run, pause, resume, edit, and stop your saved alerts.</li>
          <li>Match public tee-time observations to your date, time, player, and course preferences.</li>
          <li>Send alert and status emails to you and the recipients you choose.</li>
          <li>Protect account access and keep each dashboard scoped to its owner.</li>
          <li>Investigate broken experiences, missing courses, provider changes, and abuse.</li>
          <li>Understand aggregate product usage and improve the service.</li>
          <li>Comply with legal obligations and enforce the <Link href="/terms">Terms of Use</Link>.</li>
        </ul>
        <p>Tee Time Spot does not sell personal information.</p>
      </EditorialSection>

      <EditorialSection id="providers" eyebrow="Operations" title="Services that help run Tee Time Spot.">
        <p>
          Tee Time Spot uses specialized providers to operate the product. Depending on which
          feature you use, information may be processed by:
        </p>
        <ul>
          <li>Clerk for account authentication.</li>
          <li>Vercel for website hosting, performance, security, and aggregate analytics.</li>
          <li>Neon for the hosted Postgres database.</li>
          <li>Resend for email delivery.</li>
          <li>Google Places and Maps for location and public course discovery.</li>
          <li>Discord when you independently choose to join the public community.</li>
        </ul>
        <p>
          These providers process information under their own terms and privacy notices. Information
          may also be disclosed when required by law, to protect the service or its users, or as part
          of a business reorganization subject to appropriate safeguards.
        </p>
      </EditorialSection>

      <EditorialSection id="retention" eyebrow="Lifecycle" title="Retention and security.">
        <p>
          Information is retained for as long as reasonably needed to operate alerts, maintain
          account history, investigate incidents, measure the product, resolve disputes, and meet
          legal obligations. Retention periods can vary by record type. Data may remain in backups
          for a limited period after deletion from active systems.
        </p>
        <p>
          Tee Time Spot uses access controls, encrypted connections, restricted provider credentials,
          and other reasonable safeguards. No online system can guarantee absolute security. Do not
          send passwords, verification codes, payment information, or provider credentials through
          feedback.
        </p>
      </EditorialSection>

      <EditorialSection id="choices" eyebrow="Control" title="Your choices and requests.">
        <ul>
          <li>Decline browser location and use a typed city, ZIP code, or address.</li>
          <li>Pause, edit, or remove saved alerts from the dashboard when account mode is available.</li>
          <li>Remove optional extra email recipients from an alert.</li>
          <li>Use email action links to stop an alert where provided.</li>
          <li>Ask to access, correct, or delete account information, subject to verification and applicable law.</li>
        </ul>
        <p>
          Submit a request through the <Link href="/contact">contact page</Link> and start the message
          with “Privacy request.” Include the account email only in the private form, not in Discord.
        </p>
      </EditorialSection>

      <EditorialSection id="children" eyebrow="Additional terms" title="Children, geography, and notice changes.">
        <p>
          Tee Time Spot is a general golf utility and is not directed to children under 13. If you
          believe a child submitted personal information, use the contact process so it can be
          reviewed.
        </p>
        <p>
          Providers may process information in the United States and other locations where they
          operate. This notice may change as the service develops. Material changes will be reflected
          by updating the reviewed date and, when appropriate, providing additional notice.
        </p>
      </EditorialSection>
    </EditorialPage>
  );
}
