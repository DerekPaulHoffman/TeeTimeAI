type CourseIdentity = {
  name: string;
  address: string;
  timeZone: string;
};

export type TeeItUpFacilityIdentity = CourseIdentity & {
  id: number;
};

export type TeeItUpFacilityIdentityResult =
  | { status: "MATCHED"; facility: TeeItUpFacilityIdentity }
  | { status: "UNRESOLVED"; reason: "INVALID_INPUT" | "NO_MATCH" | "AMBIGUOUS" };

/**
 * Reconciles identity within an independently corroborated public booking alias.
 * This does not establish source authority, monitoring support, or physical layout.
 * Callers must retain their source, ownership, and fresh provider-execution gates.
 */
export function resolveTeeItUpFacilityIdentity(
  course: CourseIdentity,
  directory: unknown,
): TeeItUpFacilityIdentityResult {
  if (!validIdentity(course) || !Array.isArray(directory) || directory.length > 100) {
    return { status: "UNRESOLVED", reason: "INVALID_INPUT" };
  }
  const facilities: TeeItUpFacilityIdentity[] = [];
  const ids = new Set<number>();
  for (const row of directory) {
    if (!validIdentity(row)) {
      return { status: "UNRESOLVED", reason: "INVALID_INPUT" };
    }
    const id = (row as CourseIdentity & { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647 || ids.has(id)) {
      return { status: "UNRESOLVED", reason: "INVALID_INPUT" };
    }
    ids.add(id);
    facilities.push({ id, name: row.name, address: row.address, timeZone: row.timeZone });
  }
  const expectedName = nameIdentity(course.name);
  const matches = facilities.filter((facility) => {
    const candidateName = nameIdentity(facility.name);
    return facility.timeZone === course.timeZone &&
      addressKey(facility.address) === addressKey(course.address) &&
      expectedName.core.length > 0 && expectedName.core === candidateName.core &&
      expectedName.holes.size <= 1 && candidateName.holes.size <= 1 &&
      (!expectedName.holes.size || !candidateName.holes.size ||
        [...expectedName.holes][0] === [...candidateName.holes][0]);
  });
  if (matches.length !== 1) {
    return { status: "UNRESOLVED", reason: matches.length ? "AMBIGUOUS" : "NO_MATCH" };
  }
  return { status: "MATCHED", facility: matches[0] };
}

function validIdentity(value: unknown): value is CourseIdentity {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!boundedText(row.name, 256) || !boundedText(row.address, 1024) ||
    !boundedText(row.timeZone, 100) || !addressKey(row.address)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: row.timeZone });
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function addressKey(value: string) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/\b(?:united states of america|united states|usa)\b/gu, "us")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function nameIdentity(value: string) {
  const holes = new Set<number>();
  const core = value.normalize("NFKC").toLowerCase()
    .replace(/\b(9|18|nine|eighteen)[ -]*holes?\b/gu, (_, qualifier: string) => {
      holes.add(qualifier === "9" || qualifier === "nine" ? 9 : 18);
      return " ";
    })
    .replace(/\bgc\b/gu, "golf course")
    .replace(/\b(?:golf|course|club)\b/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return { core, holes };
}
