export const eastonPublicPage: "https://www.eastoncountryclub.com/teetimes";
export const farmNeckPublicPage: "https://www.farmneck.net/public-tee-times";
export function outdoorPublicRoot(value: unknown): {
  family: "TEEQUEST" | "CLUBESSENTIAL";
  bookingUrl: string;
  publicRequests: number;
} | null;
