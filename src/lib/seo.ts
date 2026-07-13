import type { Metadata } from "next";

export const siteName = "Tee Time Spot";
export const siteDescription =
  "Tee Time Spot is a free, alert-only service that watches ranked public golf courses and emails the official booking link when a matching tee time opens.";
export const siteDefinition =
  "Rank up to five public golf courses, choose when you can play, and receive an email with the official booking link when a matching tee time opens. Tee Time Spot never books or pays for you.";

export const siteUrl = getSiteUrl();

export function absoluteUrl(path = "/") {
  return new URL(path, siteUrl).toString();
}

export function buildPageMetadata(input: {
  title: string;
  description: string;
  path: string;
  type?: "article" | "website";
}): Metadata {
  const title = `${input.title} | ${siteName}`;

  return {
    title: input.title,
    description: input.description,
    alternates: {
      canonical: input.path
    },
    openGraph: {
      title,
      description: input.description,
      url: absoluteUrl(input.path),
      siteName,
      images: [
        {
          url: absoluteUrl("/opengraph-image"),
          width: 1200,
          height: 630,
          alt: `${siteName} public golf tee time alerts`
        }
      ],
      locale: "en_US",
      type: input.type ?? "website"
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: input.description,
      images: [absoluteUrl("/opengraph-image")]
    }
  };
}

export function buildPageStructuredData(input: {
  name: string;
  description: string;
  path: string;
  breadcrumbs?: Array<{ name: string; path: string }>;
  datePublished?: string;
  dateModified?: string;
  type?: "AboutPage" | "Article" | "CollectionPage" | "ContactPage" | "WebPage";
}) {
  const pageId = `${absoluteUrl(input.path)}#webpage`;
  const breadcrumbs = input.breadcrumbs ?? [
    { name: "Home", path: "/" },
    { name: input.name, path: input.path }
  ];

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": input.type ?? "WebPage",
        "@id": pageId,
        url: absoluteUrl(input.path),
        name: input.name,
        description: input.description,
        isPartOf: {
          "@id": `${absoluteUrl("/")}#website`
        },
        about: {
          "@id": `${absoluteUrl("/")}#organization`
        },
        publisher: {
          "@id": `${absoluteUrl("/")}#organization`
        },
        breadcrumb: {
          "@id": `${absoluteUrl(input.path)}#breadcrumbs`
        },
        inLanguage: "en-US",
        ...(input.type === "Article"
          ? {
              headline: input.name,
              mainEntityOfPage: {
                "@id": pageId
              },
              author: {
                "@id": `${absoluteUrl("/")}#organization`
              }
            }
          : {}),
        ...(input.datePublished ? { datePublished: input.datePublished } : {}),
        ...(input.dateModified ? { dateModified: input.dateModified } : {})
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${absoluteUrl(input.path)}#breadcrumbs`,
        itemListElement: breadcrumbs.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          item: absoluteUrl(item.path)
        }))
      }
    ]
  };
}

export function getSiteVerification(): Metadata["verification"] {
  const google = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  const bing = process.env.BING_SITE_VERIFICATION?.trim();

  if (!google && !bing) {
    return undefined;
  }

  return {
    ...(google ? { google } : {}),
    ...(bing
      ? {
          other: {
            "msvalidate.01": bing
          }
        }
      : {})
  };
}

function getSiteUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://teetimespot.com";
  return new URL(configuredUrl.endsWith("/") ? configuredUrl : `${configuredUrl}/`);
}
