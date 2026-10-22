import { z } from "zod";
import { isUSchedulePublicRentalLabel } from "@/lib/automation/uschedule-public-read-policy";
import { whooshSimulatorMetadataSchema } from "./whoosh-simulator-source";
import { teeItUpOfficialIdentityProofSchema } from "./teeitup-official-identity";
import { lightspeedMetadataSchema } from "./lightspeed-source";
import { ameliaMetadataSchema } from "./amelia-source";
import { chronogolfMetadataSchema } from "./chronogolf-source";
import { golfVxMetadataSchema } from "./golfvx-source";
import { ezlinksMetadataSchema } from "./ezlinks-source";
import { isUScheduleNonMemberRental, uschedulePublicLocationProofSchema } from "@/lib/simulators/providers/uschedule-location-source";

const numericId = z.number().int().min(1).max(2_147_483_647);
const publicId = z.string().regex(/^[1-9]\d{0,9}$/u);

/** Identifiers from a supported public configuration, never executable code. */
export const existingAdapterMetadataSchema = z.discriminatedUnion("family", [
  z.object({ family: z.literal("FOREUP"), facilityId: numericId, scheduleId: numericId,
    bookingClassId: numericId }).strict(),
  z.object({ family: z.literal("ACUITY"), ownerKey: z.string().regex(/^[a-zA-Z0-9]{4,40}$/u),
    businessId: publicId, rentalProductIds: z.array(publicId).min(1).max(20)
      .refine(ids => new Set(ids).size === ids.length) }).strict(),
  z.object({ family: z.literal("TEEITUP"), alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
    facilityIds: z.array(numericId).min(1).max(20).refine(ids => new Set(ids).size === ids.length),
    offeringKind: z.literal("SIMULATOR").optional(),
    officialIdentityProof: teeItUpOfficialIdentityProofSchema.optional() }).strict(),
  z.object({ family: z.literal("USCHEDULE"), tenant: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
    serviceId: publicId, serviceName: z.string().trim().min(3).max(200), publicLocationProof: uschedulePublicLocationProofSchema.optional() }).strict()
    .refine(value => value.publicLocationProof ? isUScheduleNonMemberRental(value.serviceName) : isUSchedulePublicRentalLabel(value.serviceName),
      "A public location rental needs its independently verified location contract"),
  whooshSimulatorMetadataSchema,
  lightspeedMetadataSchema,
  ameliaMetadataSchema,
  chronogolfMetadataSchema,
  golfVxMetadataSchema,
  ezlinksMetadataSchema,
]);

export type ExistingAdapterMetadata = z.infer<typeof existingAdapterMetadataSchema>;

export type ExistingAdapterRecipe = {
  schemaVersion: 1;
  engine: "EXISTING_ADAPTER";
  target: { courseId: string; offeringId?: string; kind: "OUTDOOR" | "SIMULATOR" };
  source: { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; providerFamily: string; timeZone: string };
  adapter: ExistingAdapterMetadata;
};
