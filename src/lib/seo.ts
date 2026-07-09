export const siteName = "Tee Time Spot";
export const siteDescription =
  "Tee Time Spot watches your ranked public golf courses and emails you when matching tee times open up.";

export const siteUrl = getSiteUrl();

export function absoluteUrl(path = "/") {
  return new URL(path, siteUrl).toString();
}

function getSiteUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://teetimespot.com";
  return new URL(configuredUrl.endsWith("/") ? configuredUrl : `${configuredUrl}/`);
}
