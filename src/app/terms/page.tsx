import Link from "next/link";

import {
  EditorialNote,
  EditorialPage,
  EditorialSection
} from "@/components/editorial-page";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "Terms of Use";
const description =
  "Read the Tee Time Spot terms for its free, alert-only public golf course discovery and tee-time notification service.";
const path = "/terms";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  dateModified: "2026-07-13"
});

export default function TermsPage() {
  return (
    <EditorialPage
      eyebrow="Terms"
      title="Terms for an alert service—not a booking transaction."
      intro="These Terms of Use govern access to Tee Time Spot's website, public course discovery, saved alerts, emails, dashboard, feedback, and related features."
      summary="Tee Time Spot provides informational alerts and official links. It does not sell, hold, reserve, or book tee times and is not responsible for a transaction you make with a course or booking provider."
      updated="July 13, 2026"
      toc={[
        { id: "acceptance", label: "Acceptance" },
        { id: "service", label: "The service" },
        { id: "accounts", label: "Accounts and recipients" },
        { id: "acceptable-use", label: "Acceptable use" },
        { id: "third-parties", label: "Third-party services" },
        { id: "disclaimers", label: "Disclaimers" },
        { id: "liability", label: "Liability" },
        { id: "changes", label: "Changes and contact" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="acceptance" eyebrow="Effective July 13, 2026" title="Using Tee Time Spot means agreeing to these terms.">
        <p>
          If you do not agree, do not use the service. You must be able to form a binding agreement
          where you live. If you use Tee Time Spot for another person or organization, you represent
          that you have authority to accept these terms for them.
        </p>
      </EditorialSection>

      <EditorialSection id="service" eyebrow="Product scope" title="Tee Time Spot provides course discovery and alerts.">
        <p>
          You can search for likely-public golf courses, rank preferred courses, save a future date,
          time window, and group size, and receive an email when supported public availability appears
          to match. Links lead to an official course or booking-provider surface.
        </p>
        <EditorialNote label="No booking agency">
          <p>
            Tee Time Spot does not act as your agent, the course&apos;s agent, a marketplace, or a payment
            processor. It does not enter checkout, reserve inventory, guarantee a price, or complete
            a booking.
          </p>
        </EditorialNote>
        <p>
          The service may add, change, suspend, or remove features or course support. Monitoring may
          pause when a provider changes, access is restricted, policy prohibits retrieval, or a
          technical issue occurs.
        </p>
      </EditorialSection>

      <EditorialSection id="accounts" eyebrow="Your responsibility" title="Keep account access and recipients accurate.">
        <ul>
          <li>Provide accurate information and protect your account access.</li>
          <li>Use only email recipients you are authorized to add.</li>
          <li>Review and remove alerts or recipients that are no longer needed.</li>
          <li>Notify Tee Time Spot through the contact process if you suspect unauthorized use.</li>
          <li>Do not share verification codes, passwords, or private access links.</li>
        </ul>
        <p>
          You are responsible for activity under your account and for complying with the rules of any
          course or booking provider you choose to use.
        </p>
      </EditorialSection>

      <EditorialSection id="acceptable-use" eyebrow="Fair access" title="Do not misuse the service.">
        <p>You may not:</p>
        <ul>
          <li>Use Tee Time Spot for unlawful, fraudulent, abusive, or harassing activity.</li>
          <li>Interfere with the website, alerts, security controls, or another user&apos;s account.</li>
          <li>Probe, scrape, overload, or reverse engineer the service except where law expressly permits.</li>
          <li>Use automated access to create excessive alerts or reproduce Tee Time Spot data at scale.</li>
          <li>Submit malware, secrets, payment information, or content you have no right to provide.</li>
          <li>Misrepresent an affiliation with Tee Time Spot or a listed golf course.</li>
        </ul>
        <p>Access can be limited or terminated when reasonably necessary to protect the service or others.</p>
      </EditorialSection>

      <EditorialSection id="third-parties" eyebrow="Official destinations" title="Course and booking sites have their own terms.">
        <p>
          Tee Time Spot displays information and links related to third-party courses, maps, booking
          providers, account services, email providers, and communities. Their content, inventory,
          prices, fees, policies, accessibility, and security are outside Tee Time Spot&apos;s control.
        </p>
        <p>
          Before booking, confirm the course, date, time, player count, price, hole count, cart terms,
          cancellation policy, and any other restrictions on the official surface. A link or course
          listing does not imply sponsorship, partnership, or endorsement.
        </p>
      </EditorialSection>

      <EditorialSection id="disclaimers" eyebrow="No guarantees" title="Alerts are informational and time-sensitive.">
        <p>
          To the maximum extent permitted by law, Tee Time Spot is provided “as is” and “as
          available.” No warranty is made that the service will be uninterrupted, accurate, secure,
          or suitable for every purpose.
        </p>
        <ul>
          <li>An observed tee time may be booked by someone else before you act.</li>
          <li>A course may change inventory, price, rules, provider, or policy without notice.</li>
          <li>An alert may be delayed, duplicated, unavailable, or based on incomplete public data.</li>
          <li>No cancellation, replacement round, or specific golf outcome is guaranteed.</li>
        </ul>
      </EditorialSection>

      <EditorialSection id="liability" eyebrow="Risk allocation" title="Responsibility is limited where the law allows.">
        <p>
          To the maximum extent permitted by law, Tee Time Spot and those who operate it will not be
          liable for indirect, incidental, special, consequential, exemplary, or punitive damages;
          lost profits, data, goodwill, or opportunities; missed tee times; course fees; cancellation
          charges; or third-party conduct arising from use of the service.
        </p>
        <p>
          Where liability cannot be excluded, total liability for claims related to the service will
          not exceed the greater of the amount you paid Tee Time Spot in the 12 months before the
          claim or 100 U.S. dollars. Some jurisdictions do not allow certain exclusions, so portions
          of this section may not apply to you.
        </p>
      </EditorialSection>

      <EditorialSection id="changes" eyebrow="Administration" title="Terms may evolve with the product.">
        <p>
          Updated terms will be posted here with a revised reviewed date. Continued use after an
          effective update means accepting the revised terms. If a provision is unenforceable, the
          remaining provisions continue to apply. Failure to enforce a provision is not a waiver.
        </p>
        <p>
          The <Link href="/privacy">Privacy Notice</Link> explains information practices. Questions
          about these terms can be submitted through the <Link href="/contact">contact page</Link>.
        </p>
      </EditorialSection>
    </EditorialPage>
  );
}
