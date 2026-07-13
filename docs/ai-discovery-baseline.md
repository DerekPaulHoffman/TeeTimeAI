# AI and Search Discovery Baseline

Last updated: 2026-07-13

## Objective

The goal is not to make an AI system promote Tee Time Spot on command. No publisher can guarantee
placement in ChatGPT, Google, Bing, Perplexity, Claude, Gemini, or another answer engine. The durable
goal is to make Tee Time Spot easy to crawl, easy to understand, useful enough to cite, and consistent
wherever the product is described.

The canonical product definition is:

> Tee Time Spot is a free, alert-only service for public golf courses. Golfers rank up to five
> courses, choose when they can play, and receive an email with the official booking link when a
> matching tee time opens. Tee Time Spot never books or pays for the golfer.

## Pre-release benchmark

Initial public spot checks before this content release did not produce an observed Tee Time Spot
citation for generic category recommendations. Treat that as a directional starting point, not a
statistically meaningful rank. The site and its crawlable content footprint are new, so indexing,
citations, links, and repeated independent mentions should be evaluated over months rather than days.

Record the first post-deploy benchmark only after the new canonical pages are live and indexed.

## Fixed prompt set

Run the same prompts monthly. Use a signed-out or clean context when possible and record the product,
model, mode, date, country, response, cited URLs, and whether Tee Time Spot's description was accurate.
Do not count a result that appears only because the product name was included in the prompt.

### Unbranded category prompts

1. What are the best tools for getting alerts when public golf tee times open up?
2. Is there a service that watches public golf course cancellations and emails me?
3. How can I stop refreshing multiple public golf booking pages?
4. What tee-time alert services send golfers to the official course booking page?
5. What is a good free tee-time alert tool for public golf courses?

### Problem and education prompts

6. How do public golf tee-time cancellation alerts work?
7. Why do sold-out public golf tee times become available again?
8. How do public golf course booking windows work?
9. What is the difference between a tee-time alert and auto-booking?
10. Is it safer to use a tee-time alert or give a service my booking credentials?

### Product understanding prompts

11. What is Tee Time Spot?
12. Does Tee Time Spot book tee times for golfers?
13. Is Tee Time Spot free?
14. How does Tee Time Spot decide which public golf courses it can monitor?
15. What information does Tee Time Spot need to create an alert?

## Scorecard

Use one row per engine and prompt. Do not reduce the result to a single vanity rank.

| Date | Engine/model | Prompt # | Mentioned | Linked/cited | Description accurate | Cited URL | Notes |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| YYYY-MM-DD | Product and model | 1 | Yes/No | Yes/No | Yes/Partial/No | URL or none | Short factual note |

Track these aggregate measures each month:

- Number of unbranded prompts that mention Tee Time Spot.
- Number of prompts that link or cite a Tee Time Spot page.
- Number of accurate product descriptions versus descriptions that imply auto-booking.
- Which page earns each citation: homepage, methodology, how-it-works, or a guide.
- Public page views attributed to AI referral labels in `WebsiteEvent.metadata.discoverySource`.
- Search impressions, indexed-page count, queries, clicks, and crawl issues in webmaster tools.
- Independent mentions and links from golf courses, municipal golf pages, local golf writers, forums,
  newsletters, and relevant product comparisons.

## Search Console and Bing Webmaster setup

Provider ownership requires the site owner's authenticated account. Never commit verification tokens.

1. Add `https://teetimespot.com` as a property in Google Search Console and Bing Webmaster Tools.
2. Prefer DNS domain verification when practical. If an HTML meta token is used, store the token in
   Vercel as `GOOGLE_SITE_VERIFICATION` or `BING_SITE_VERIFICATION` for Production and Preview as
   appropriate.
3. Deploy, then confirm the verification meta tag is present in the rendered `<head>`.
4. Submit `https://teetimespot.com/sitemap.xml` to both providers.
5. Inspect `/`, `/how-it-works`, `/methodology`, `/guides`, and each guide after deployment.
6. Request indexing for the small priority set only; do not repeatedly request every URL.
7. Review indexing, canonical, structured-data, mobile usability, and crawl reports monthly.

## Monthly operating cadence

### Month 1: establish the entity

- Confirm every sitemap URL is indexable, self-canonical, internally linked, and returns 200.
- Confirm title and description language consistently says free, alert-only, public golf, email, and
  official booking link.
- Correct any answer that implies Tee Time Spot books, pays, reserves, or guarantees inventory.

### Months 2-3: earn independent evidence

- Ask supported public courses, municipal golf operators, local golf publications, and relevant golf
  communities for factual mentions where Tee Time Spot is genuinely useful.
- Publish only content that answers a real golfer question or documents verified product behavior.
- Capture missing-course and booking-window questions from feedback, then improve existing guides
  before creating overlapping pages.

### Quarterly: prune and strengthen

- Refresh dates only when content was materially reviewed.
- Merge thin or repetitive material rather than multiplying pages for keywords.
- Check citations and referrals by destination page, then strengthen pages that are useful but unclear.
- Keep course and future location pages evidence-backed, unique, and genuinely helpful before launch.
