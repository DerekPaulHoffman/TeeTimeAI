/** The existing public golf-rental label predicate, shared without schema or
 * executor imports. Trimming and length remain the caller schema's contract. */
export function isPublicRentalLabel(value: string): boolean {
  return /(?:^|\W)(?:simulators?|rentals?|bays?|rooms?)(?:\W|\d|$)/iu.test(value) &&
    !/\b(?:members?[-\s]+only|lessons?|fittings?|leagues?|classes?|coaching)\b/iu.test(value) &&
    (!/\b(?:multi[-\s]?sport|baseball|soccer|hockey|tennis)\b/iu.test(value) || /\bgolf\b/iu.test(value));
}
