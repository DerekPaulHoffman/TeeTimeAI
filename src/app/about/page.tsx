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

const title = "About Tee Time Spot";
const description =
  "Tee Time Spot is a free, alert-only public golf service built to help golfers find openings at the courses they actually want to play.";
const path = "/about";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "AboutPage",
  dateModified: "2026-07-13"
});

export default function AboutPage() {
  return (
    <EditorialPage
      eyebrow="About"
      title="Public golf openings should not require constant refreshing."
      intro="Tee Time Spot exists for the familiar moment when your preferred courses are full, your group still wants to play, and cancellations may appear later."
      summary="Tee Time Spot is a free, email-based alert service for public golf. It watches supported availability, sends official booking links, and leaves every booking decision to the golfer."
      updated="July 13, 2026"
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
          courses, chooses a date, time range, and group size, then gets an email when supported
          public availability matches. The golfer follows the official link and books directly.
        </p>
      </EditorialSection>

      <EditorialSection id="principles" eyebrow="What guides the product" title="Useful, direct, and honest about the boundary.">
        <EditorialChecklist>
          <EditorialCheck>
            <strong>Public-course first.</strong> Discovery is designed to prefer playable public
            golf courses and filter private clubs, simulators, stores, and non-course results.
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
            <strong>Policy-aware.</strong> A blocked or prohibited surface is skipped rather than
            bypassed.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Evidence-led.</strong> Course support and product changes are based on observed
            behavior, published policy, and golfer feedback.
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
