import { z } from "zod";

import { getLocalReaderCourse, type LocalReaderCourseKey } from "./course-key";

export const localReaderCapabilitySchema = z
  .object({
    key: z.enum([
      "CPS_RENDERED",
      "CHRONOGOLF_RENDERED",
      "TENFORE_RENDERED",
      "PROPHET_FREAR_RENDERED"
    ]),
    parserVersion: z.number().int().min(1).max(1000)
  })
  .strict();

export const localReaderCapabilitiesSchema = z.array(localReaderCapabilitySchema).min(1).max(20);

export type LocalReaderCapability = z.infer<typeof localReaderCapabilitySchema>;

export type LocalReaderAgentHandshake = {
  deviceId: string;
  readerVersion: string;
  buildId: string;
  capabilities: LocalReaderCapability[];
};

export const LEGACY_READER_1_6_CAPABILITIES: LocalReaderCapability[] = [
  { key: "CPS_RENDERED", parserVersion: 1 },
  { key: "CHRONOGOLF_RENDERED", parserVersion: 1 },
  { key: "TENFORE_RENDERED", parserVersion: 1 },
  { key: "PROPHET_FREAR_RENDERED", parserVersion: 1 }
];

export function getRequiredLocalReaderCapability(
  courseKey: LocalReaderCourseKey,
  courseName?: string
): LocalReaderCapability {
  const course = getLocalReaderCourse(courseKey, courseName);
  if (!course) {
    throw new Error("The local reader course no longer has a parser capability");
  }
  switch (course.provider) {
    case "CPS":
      return { key: "CPS_RENDERED", parserVersion: 1 };
    case "CHRONOGOLF":
      return { key: "CHRONOGOLF_RENDERED", parserVersion: 1 };
    case "TENFORE":
      return { key: "TENFORE_RENDERED", parserVersion: 1 };
    case "PROPHET":
      return {
        key: "PROPHET_FREAR_RENDERED",
        parserVersion: 4
      };
  }
}

export function readerSupportsCapability(
  capabilities: LocalReaderCapability[],
  requiredKey: string | null,
  requiredParserVersion: number | null
) {
  if (!requiredKey || !requiredParserVersion) return true;
  return capabilities.some(
    (capability) =>
      capability.key === requiredKey && capability.parserVersion >= requiredParserVersion
  );
}

export function serializeLocalReaderCapabilities(capabilities: LocalReaderCapability[]) {
  return localReaderCapabilitiesSchema
    .parse(capabilities)
    .map((capability) => `${capability.key}:${capability.parserVersion}`)
    .join(",");
}

export function parseLocalReaderCapabilities(value: string | null | undefined) {
  if (!value?.trim()) return LEGACY_READER_1_6_CAPABILITIES;
  const parsed = value.split(",").map((entry) => {
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error("Invalid local reader capability");
    }
    return {
      key: entry.slice(0, separator),
      parserVersion: Number(entry.slice(separator + 1))
    };
  });
  return localReaderCapabilitiesSchema.parse(parsed);
}
