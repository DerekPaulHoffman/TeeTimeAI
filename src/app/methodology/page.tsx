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

const title = "Course Discovery and Monitoring Methodology";
const description =
  "See how Tee Time Spot identifies likely-public golf courses, evaluates booking access, monitors supported tee sheets, and handles limitations.";
const path = "/methodology";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  dateModified: "2026-07-13"
});

export default function MethodologyPage() {
  return (
    <EditorialPage
      eyebrow="Methodology"
      title="How Tee Time Spot decides what it can responsibly watch."
      intro="Reliable alerts begin before a tee sheet is checked. We first need a credible course identity, an official public booking surface, and a policy-safe way to observe availability."
      summary="Course discovery and active monitoring are separate. A course can appear in discovery without being monitorable. Tee Time Spot labels unsupported or blocked access instead of presenting it as active coverage."
      updated="July 13, 2026"
      toc={[
        { id: "discovery", label: "Course discovery" },
        { id: "identity", label: "Identity checks" },
        { id: "eligibility", label: "Monitoring eligibility" },
        { id: "matching", label: "Match handling" },
        { id: "quality", label: "Quality and corrections" },
        { id: "limits", label: "Known limitations" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="discovery" eyebrow="Stage one" title="Find likely-public golf courses near the golfer.">
        <p>
          Discovery starts with a bounded geographic search around a typed location or browser
          location. The default radius is 15 miles, with choices from 5 to 30 miles. Results are
          evaluated for golf-course type, operating status, name, official website evidence, and
          conflicting signals.
        </p>
        <EditorialChecklist>
          <EditorialCheck>Prefer places classified as golf courses and currently operational.</EditorialCheck>
          <EditorialCheck>Exclude explicit private or member-only club signals.</EditorialCheck>
          <EditorialCheck>Exclude simulators, golf stores, fitting studios, associations, and non-course sports facilities.</EditorialCheck>
          <EditorialCheck>Collapse duplicate place records that represent the same course at the same venue.</EditorialCheck>
          <EditorialCheck>Preserve distinct courses when a facility legitimately has more than one layout.</EditorialCheck>
        </EditorialChecklist>
        <p>
          Automated place data can be noisy. A discovery result is therefore a likely-public course,
          not a claim that Tee Time Spot can already monitor its tee sheet.
        </p>
      </EditorialSection>

      <EditorialSection id="identity" eyebrow="Stage two" title="Resolve the official course and booking surface.">
        <p>
          A course name alone is not enough. Tee Time Spot compares stable place identifiers,
          addresses, coordinates, official websites, booking links, and venue relationships. This
          helps prevent a similarly named private club, pro shop, or third-party directory from being
          treated as the course itself.
        </p>
        <p>
          Booking links are expected to originate from the course&apos;s official site or a booking
          provider that the official site uses. Search results and aggregators may help locate a
          surface, but they are not sufficient evidence by themselves.
        </p>
      </EditorialSection>

      <EditorialSection id="eligibility" eyebrow="Stage three" title="Classify access before retrieving a tee sheet.">
        <p>
          Each course is evaluated for booking method, provider, public access, and policy. A public
          online tee sheet may still be unsupported technically; an understandable provider does not
          automatically mean retrieval is allowed.
        </p>
        <EditorialChecklist>
          <EditorialCheck>
            <strong>Allowed and supported:</strong> a public surface can be observed without entering
            checkout, using an account, or bypassing a control.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Needs support:</strong> the course has public online booking, but Tee Time Spot
            does not yet have a verified adapter for the provider or configuration.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Manual or phone booking:</strong> there is no suitable public tee sheet to monitor.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Blocked:</strong> published policy prohibits automation or the surface requires an
            account, captcha, verification code, queue, or other restricted flow.
          </EditorialCheck>
        </EditorialChecklist>
        <EditorialNote label="No bypass policy">
          <p>
            Tee Time Spot does not bypass captchas, queues, access controls, account requirements, or
            rate limits. It does not use golfer-specific course sessions in the current product.
          </p>
        </EditorialNote>
      </EditorialSection>

      <EditorialSection id="matching" eyebrow="Stage four" title="Compare observed openings with the saved alert.">
        <p>
          Supported observations are normalized into a course, start time, available spot count,
          official booking link, and any available price or hole information. The start time is
          interpreted in the selected course&apos;s local time zone.
        </p>
        <p>
          A match must fall on the requested date, within the requested time window, and provide
          enough spots for the selected group. Stable source information helps avoid duplicate
          alerts. Courses are processed independently so one failure does not suppress another
          course&apos;s valid result.
        </p>
      </EditorialSection>

      <EditorialSection id="quality" eyebrow="Ongoing review" title="Correct the real shape, not just the visible symptom.">
        <p>
          Course data, booking systems, and policies change. Tee Time Spot records evidence about
          observed outcomes and uses focused tests when a false course, duplicate, unsupported
          provider, or broken booking link is reported. Corrections aim for stable identity evidence
          rather than broad name rules that could hide legitimate courses.
        </p>
        <p>
          Golfers can report a missing course or broken experience from the search and feedback
          controls. See <Link href="/contact">contact options</Link> for the best channel.
        </p>
      </EditorialSection>

      <EditorialSection id="limits" eyebrow="Interpretation" title="What an alert can and cannot prove.">
        <ul>
          <li>An alert proves that a matching opening was observed, not that it remains available.</li>
          <li>A course appearing in discovery does not prove that its booking page is supported.</li>
          <li>Prices, fees, hole counts, cart rules, and cancellation terms remain controlled by the course.</li>
          <li>Temporary provider failures can delay or prevent observations.</li>
          <li>No alert can guarantee that a cancellation will happen or that another golfer will not book first.</li>
        </ul>
        <EditorialCta copy="Choose the public courses that matter to you. Tee Time Spot will show what can be watched and send an official link when a supported opening matches." />
      </EditorialSection>
    </EditorialPage>
  );
}
