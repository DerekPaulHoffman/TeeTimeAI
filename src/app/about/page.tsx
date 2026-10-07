import Link from "next/link";
import "../editorial.css";

import {
  EditorialCheck,
  EditorialChecklist,
  EditorialCta,
  EditorialNote,
  EditorialPage,
  EditorialSection
} from "@/components/editorial-page";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "About Tee Time Spot";
const description =
  "Tee Time Spot helps golfers discover public courses and indoor simulator venues, with free opening alerts where supported and booking directly on official sites.";
const path = "/about";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "AboutPage",
  dateModified: "2026-10-07"
});

export default function AboutPage() {
  return (
    <EditorialPage
      eyebrow="About"
      title="Public golf openings should not require constant refreshing."
      intro="Tee Time Spot exists for the familiar moment when your preferred courses are full, your group still wants to play, and cancellations may appear later."
      summary="Tee Time Spot sends free email alerts for public tee times and one-hour simulator sessions where supported. It checks public booking pages, sends official links, and leaves every booking decision to the golfer."
      updated="October 7, 2026"
      toc={[
        { id: "purpose", label: "Why we exist" },
        { id: "principles", label: "Product principles" },
        { id: "learning", label: "How we improve" },
        { id: "independence", label: "Course relationships" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="purpose" eyebrow="The problem" title="A small tool for a frustrating golf problem.">
        <p>
          Popular public tee times often disappear soon after a booking window opens. Later,
          cancellations and schedule changes can return individual slots to the tee sheet, but
          finding them usually means checking several sites over and over.
        </p>
        <p>
          Tee Time Spot turns that repeated checking into a saved alert. A golfer ranks up to five
          courses, chooses a date, time range, and group size, then gets an email when a matching
          public tee time opens. The golfer follows the official link and books directly.
        </p>
      </EditorialSection>

      <EditorialSection id="principles" eyebrow="What guides the product" title="Useful, direct, and honest about the boundary.">
        <EditorialChecklist>
          <EditorialCheck>
            <strong>Choose how you play.</strong> Outdoor discovery prefers playable public
            golf courses and filters private clubs, simulators, stores, and non-course results.
            Separate <Link href="/golf-simulators">simulator discovery</Link> finds nearby indoor
            venues; rental access and alert coverage are evaluated independently.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Alert-only.</strong> Tee Time Spot finds and communicates public availability;
            it does not hold, reserve, pay, or enter checkout.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Official destination.</strong> Match emails point golfers toward the course&apos;s
            own booking page or official site.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Access-respecting.</strong> Accounts, captchas, queues, and other access controls
            are never bypassed.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Evidence-led.</strong> Course support and product changes are based on observed
            booking access, official course information, and golfer feedback.
          </EditorialCheck>
        </EditorialChecklist>
      </EditorialSection>

      <EditorialSection id="learning" eyebrow="Built in the open" title="Feedback is part of the product loop.">
        <p>
          Tee Time Spot is still learning which courses golfers want, which booking systems can be
          monitored responsibly, and which alerts are genuinely useful. The feedback control on
          every page records likes, dislikes, broken experiences, and optional reply information.
        </p>
        <p>
          Longer ideas and public-course tips can be shared in the golfer community. For details
          about how course evidence is evaluated, see the <Link href="/methodology">monitoring
          methodology</Link>.
        </p>
      </EditorialSection>

      <EditorialSection id="independence" eyebrow="Clear relationships" title="Course names remain the courses' own.">
        <p>
          Tee Time Spot is not a golf course, booking marketplace, or payment processor. Course
          names, marks, schedules, prices, rules, and booking inventory belong to their respective
          owners. A listing or link does not imply sponsorship, endorsement, or partnership.
        </p>
        <EditorialNote label="The source of truth">
          <p>
            The official course booking surface controls whether a tee time is still available,
            what it costs, and which cancellation or player policies apply.
          </p>
        </EditorialNote>
        <EditorialCta title="Spend less time refreshing tee sheets." />
      </EditorialSection>
    </EditorialPage>
  );
}
