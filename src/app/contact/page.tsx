import { ArrowUpRight } from "lucide-react";

import {
  EditorialNote,
  EditorialPage,
  EditorialSection
} from "@/components/editorial-page";
import { OpenFeedbackButton } from "@/components/open-feedback-button";
import { discordInviteUrl } from "@/lib/community";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "Contact Tee Time Spot";
const description =
  "Contact Tee Time Spot about product questions, missing public golf courses, broken alerts, privacy requests, or product suggestions.";
const path = "/contact";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "ContactPage",
  dateModified: "2026-07-13"
});

export default function ContactPage() {
  return (
    <EditorialPage
      eyebrow="Contact"
      title="Questions, corrections, and course tips are welcome."
      intro="Use the private feedback form for account-specific questions, broken experiences, missing courses, or privacy requests. Use the community for public product ideas and golf discussion."
      summary="The feedback form can include an optional reply email. Do not post account details, email addresses, or other personal information in the public Discord community."
      updated="July 13, 2026"
      toc={[
        { id: "feedback", label: "Private feedback" },
        { id: "community", label: "Community discussion" },
        { id: "helpful-details", label: "Helpful details" },
        { id: "privacy-requests", label: "Privacy requests" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="feedback" eyebrow="Best for support" title="Send a private feedback report.">
        <p>
          The feedback form is available from every Tee Time Spot page. Select whether you liked
          something, disliked it, or found a broken experience. Add the page, course, and expected
          behavior in the message. Include an email only if you want a reply.
        </p>
        <OpenFeedbackButton />
      </EditorialSection>

      <EditorialSection id="community" eyebrow="Best for ideas" title="Join the golfer community.">
        <p>
          The Tee Time Spot Discord is useful for feature suggestions, public-course tips, and
          longer discussions with other golfers. It is a public community, not a private support
          channel.
        </p>
        <p>
          <a href={discordInviteUrl} rel="noreferrer" target="_blank">
            Join the Tee Time Spot Discord <ArrowUpRight aria-hidden="true" size={15} />
          </a>
        </p>
        <EditorialNote label="Keep private details private">
          <p>
            Do not share account information, alert recipient addresses, private booking details, or
            privacy requests in Discord. Use the feedback form instead.
          </p>
        </EditorialNote>
      </EditorialSection>

      <EditorialSection id="helpful-details" eyebrow="Faster investigation" title="What to include in a useful report.">
        <ul>
          <li>The public course name and city or ZIP code.</li>
          <li>The page where you noticed the problem.</li>
          <li>What you expected to happen and what happened instead.</li>
          <li>Whether the issue was on a phone, tablet, or desktop browser.</li>
          <li>The official course or booking-page link, when relevant.</li>
        </ul>
        <p>Please never include a password, verification code, API key, or payment information.</p>
      </EditorialSection>

      <EditorialSection id="privacy-requests" eyebrow="Your data" title="Ask about access, correction, or deletion.">
        <p>
          Submit privacy requests through the feedback form, choose the closest feedback type, write
          “Privacy request” at the start of the details, and include the email associated with your
          Tee Time Spot account. Verification may be required before account data is disclosed,
          corrected, or deleted.
        </p>
      </EditorialSection>
    </EditorialPage>
  );
}
