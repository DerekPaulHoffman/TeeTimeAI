import Link from "next/link";

import {
  EditorialCheck,
  EditorialChecklist,
  EditorialCta,
  EditorialNote,
  EditorialPage,
  EditorialSection
} from "@/components/editorial-page";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "How Tee Time Spot Works";
const description =
  "Learn how Tee Time Spot watches ranked public golf courses, matches your playing window, and emails official booking links without booking for you.";
const path = "/how-it-works";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  dateModified: "2026-07-13"
});

export default function HowItWorksPage() {
  return (
    <EditorialPage
      eyebrow="How it works"
      title="A tee-time alert, not another booking marketplace."
      intro="Tell us which public courses you prefer and when your group can play. Tee Time Spot watches supported public availability and emails you when a matching opening appears."
      summary="You set the preferences once. We send an alert when there is a match. The link opens the course's official booking surface, where you review and complete the booking yourself."
      updated="July 13, 2026"
      toc={[
        { id: "setup", label: "Set up an alert" },
        { id: "monitoring", label: "What we monitor" },
        { id: "email", label: "What the email contains" },
        { id: "boundaries", label: "What we never do" },
        { id: "questions", label: "Common questions" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="setup" eyebrow="Step one" title="Choose the round you actually want.">
        <p>
          Start with a city, ZIP code, address, or your current location. Tee Time Spot returns
          nearby likely-public golf courses. Choose between one and five courses, then rank them
          so your favorite is first.
        </p>
        <EditorialChecklist>
          <EditorialCheck>
            <strong>Rank one to five courses.</strong> Your order preserves which courses matter
            most to you.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Pick a future date and time window.</strong> A 9:00 AM to noon alert will not
            notify you about an evening opening.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Choose one to four players.</strong> The alert looks for enough public spots for
            your group.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Use your account email.</strong> You can add up to three playing partners as
            extra email recipients.
          </EditorialCheck>
        </EditorialChecklist>
        <p>
          Creating or managing an alert requires an account so your saved searches and controls
          stay attached to you. Course discovery remains available before sign-in.
        </p>
      </EditorialSection>

      <EditorialSection id="monitoring" eyebrow="Step two" title="We watch only where access is appropriate.">
        <p>
          Tee Time Spot checks supported public tee-sheet availability on the schedule attached to
          your active alert. We evaluate each course separately, so one unsupported or temporarily
          unavailable source does not erase useful results from another course.
        </p>
        <p>
          Monitoring depends on the course&apos;s public booking setup. If a course requires a private
          account, blocks automated retrieval, uses a captcha or queue, or prohibits automation in
          its published terms, Tee Time Spot does not bypass that control. Unsupported courses can
          remain in your ranked list while support is investigated, but they are not represented as
          actively monitored when they are not.
        </p>
        <EditorialNote label="Availability changes quickly">
          <p>
            An alert records what was publicly visible at the time of a check. Another golfer may
            book the opening before you reach the official site, and the course always controls the
            final inventory.
          </p>
        </EditorialNote>
      </EditorialSection>

      <EditorialSection id="email" eyebrow="Step three" title="A matching opening triggers a useful email.">
        <p>
          When the number of spots, date, and time fit your alert, Tee Time Spot normalizes the
          opening and avoids sending the same match repeatedly. The email identifies the course,
          tee time, player count, and any available details such as price or hole count.
        </p>
        <p>
          The primary action is a direct link to the official course booking page. Open it, confirm
          that the tee time still fits, review the course&apos;s price and cancellation rules, then book
          directly with the course. Tee Time Spot is not part of that transaction.
        </p>
      </EditorialSection>

      <EditorialSection id="boundaries" eyebrow="The product boundary" title="We find the opening. You make the booking.">
        <EditorialChecklist>
          <EditorialCheck>Tee Time Spot does not hold or reserve inventory.</EditorialCheck>
          <EditorialCheck>Tee Time Spot does not enter checkout or submit payment.</EditorialCheck>
          <EditorialCheck>Tee Time Spot does not create course-specific booking accounts for you.</EditorialCheck>
          <EditorialCheck>Tee Time Spot does not bypass captchas, queues, rate limits, or access controls.</EditorialCheck>
          <EditorialCheck>Tee Time Spot does not guarantee that an opening will remain available.</EditorialCheck>
        </EditorialChecklist>
        <p>
          This alert-only design keeps the golfer in control and preserves the direct relationship
          between the golfer and the public golf course.
        </p>
      </EditorialSection>

      <EditorialSection id="questions" eyebrow="Common questions" title="What golfers usually ask first.">
        <h3>Is Tee Time Spot free?</h3>
        <p>Yes. Tee Time Spot is currently free to use, with email as the notification channel.</p>
        <h3>Does Tee Time Spot book tee times?</h3>
        <p>
          No. The alert links to the official booking surface. You confirm availability and finish
          the booking directly with the course.
        </p>
        <h3>Can I watch every course?</h3>
        <p>
          You can rank nearby likely-public courses, but active monitoring depends on each course&apos;s
          booking technology and access policy. Read the <Link href="/methodology">methodology</Link>
          {" "}for the classification process.
        </p>
        <h3>What if I already booked a backup?</h3>
        <p>
          Review the backup course&apos;s cancellation policy before changing plans. Tee Time Spot does
          not cancel bookings and cannot determine whether a cancellation fee applies.
        </p>
        <EditorialCta />
      </EditorialSection>
    </EditorialPage>
  );
}
