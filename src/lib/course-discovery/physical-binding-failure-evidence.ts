import { z } from "zod";

const direction = z.enum(["", "n", "s", "e", "w", "ne", "nw", "se", "sw"]);
const street = z.object({ before: direction, street: z.string().min(1).max(200).regex(/^[a-z0-9'-]+(?: [a-z0-9'-]+)*$/u),
  type: z.enum(["rd", "st", "dr", "ave", "blvd", "ln", "ct", "pkwy", "hwy", "way", "cir", "trl", "ter"]), after: direction }).strict();
/** Private failure input only. No house number, locality, phone, URL, provider IDs,
 * response body or credential fields; never a recipe or identity permission. */
export const physicalBindingFailureEvidenceSchema = z.object({ schemaVersion: z.literal(1), observedAt: z.string().datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  canonicalStreet: street, providerStreet: street }).strict().refine(value =>
  (["before", "street", "type", "after"] as const).some(key => value.canonicalStreet[key] !== value.providerStreet[key]));
export type PhysicalBindingFailureEvidence = z.infer<typeof physicalBindingFailureEvidenceSchema>;
