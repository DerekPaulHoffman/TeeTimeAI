export const eastonPublicPage = "https://www.eastoncountryclub.com/teetimes";
export const farmNeckPublicPage = "https://www.farmneck.net/public-tee-times";

export function outdoorPublicRoot(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const host = url.hostname.replace(/^www\./u, "");
    const path = url.pathname.toLowerCase().replace(/\/$/u, "");
    if (host === "eastoncountryclub.com" && ["", "/teetimes"].includes(path))
      return { family: "TEEQUEST", bookingUrl: eastonPublicPage, publicRequests: 2 };
    if (host === "farmneck.net" && ["", "/public-tee-times", "/default.aspx"].includes(path))
      return { family: "CLUBESSENTIAL", bookingUrl: farmNeckPublicPage, publicRequests: 1 };
  } catch { /* An invalid source cannot select a fixed reader. */ }
  return null;
}
