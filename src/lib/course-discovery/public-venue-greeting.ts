type StrictVenueMatcher = (canonical: string, observed: unknown) => boolean;

// Sentence punctuation cannot be swallowed into a name and then erased by
// the caller's ordinary name normalization.
const validName = (name: string) => name.length >= 2 && name.length <= 200 && !/[.!?]/u.test(name);

/** Interpret only a complete, explicit public greeting claim. This never
 * searches prose for a venue or changes the caller's strict name matcher. */
export function matchesPublicVenueGreeting(canonical: string, value: unknown, strictMatch: StrictVenueMatcher): boolean {
  if (typeof value !== "string" || value.length > 500) return false;
  const text = value.replace(/\s+/gu, " ").trim();
  const possessive = /^Welcome to (.+)['’]s online tee time engine\.(?: You are guaranteed to receive the best online rates for (.+) when you book direct with us\. We look forward to seeing (?:you )?on the golf course\.)?$/iu.exec(text);
  const standalone = possessive ? undefined : /^Welcome to (.+)\.$/iu.exec(text);
  const claim = possessive ?? standalone;
  if (!claim) return false;
  const names = [claim[1], ...(possessive?.[2] === undefined ? [] : [possessive[2]])];
  if (!names.every(validName)) return false;
  return names.every(name => strictMatch(canonical, name) || /^the /iu.test(name) && strictMatch(canonical, name.slice(4)));
}
