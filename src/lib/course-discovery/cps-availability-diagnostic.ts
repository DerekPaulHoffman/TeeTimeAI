import { z } from "zod";
import { captureCpsAvailabilityStructure, type CpsAvailabilityStructure } from "./cps-availability-structure";

const count = z.union([z.number().int().min(0).max(500), z.literal("OVER_LIMIT")]);
const round = z.enum(["MISSING", "NULL", "ZERO", "NINE", "EIGHTEEN", "OTHER"]);
export const cpsAvailabilityDiagnosticSchema = z.object({
  schemaVersion: z.literal(1),
  stage: z.enum(["TRANSACTION_ID", "SCHEMA", "DUPLICATE_ID", "COURSE_ID", "DATE", "ROUND_LENGTH"]),
  envelopeObject: z.boolean(), successTrue: z.boolean(), transactionMatches: z.boolean(), transactionMatchesIgnoringCase: z.boolean(),
  rowCount: z.union([count, z.literal("NOT_ARRAY")]),
  issues: z.array(z.object({
    field: z.enum(["ENVELOPE", "ROW", "IS_SUCCESS", "TRANSACTION_ID", "CONTENT", "TEE_SHEET_ID", "COURSE_ID", "START_TIME", "PARTICIPANTS", "MIN_PLAYER", "HOLES", "DEFAULT_HOLES", "OTHER"]),
    kind: z.enum(["INVALID_TYPE", "INVALID_VALUE", "UNRECOGNIZED_KEYS", "TOO_BIG", "TOO_SMALL", "INVALID_FORMAT", "CUSTOM", "OTHER"]),
    valueType: z.enum(["MISSING", "NULL", "ARRAY", "OBJECT", "STRING", "NUMBER", "BOOLEAN", "OTHER"]),
    safePositiveInteger: z.boolean().optional(), extraKeyCount: count.optional(),
  }).strict().refine(issue => (issue.safePositiveInteger === undefined || issue.valueType === "NUMBER") &&
    (issue.extraKeyCount === undefined || issue.kind === "UNRECOGNIZED_KEYS"))).max(12),
  issuesOmitted: z.boolean(),
  roundLength: z.object({ holes: round, defaultHoles: round }).strict().optional(),
}).strict().refine(value => (value.stage === "ROUND_LENGTH") === (value.roundLength !== undefined) &&
  (value.stage === "SCHEMA" ? value.issues.length > 0 : value.issues.length === 0 && !value.issuesOmitted));
type Diagnostic = z.infer<typeof cpsAvailabilityDiagnosticSchema>;
type Issue = { code: string; path: readonly PropertyKey[]; keys?: readonly string[] };
const failures = new WeakMap<object, Diagnostic>();
const structures = new WeakMap<object, CpsAvailabilityStructure>();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const boundedCount = (value: number) => value > 500 ? "OVER_LIMIT" as const : value;
const valueType = (value: unknown) => value === undefined ? "MISSING" : value === null ? "NULL" : Array.isArray(value) ? "ARRAY" :
  typeof value === "object" ? "OBJECT" : typeof value === "string" ? "STRING" : typeof value === "number" ? "NUMBER" : typeof value === "boolean" ? "BOOLEAN" : "OTHER";
const category = (value: unknown) => value === undefined ? "MISSING" as const : value === null ? "NULL" as const :
  value === 0 ? "ZERO" as const : value === 9 ? "NINE" as const : value === 18 ? "EIGHTEEN" as const : "OTHER" as const;
const fields: Record<string, Diagnostic["issues"][number]["field"]> = { isSuccess: "IS_SUCCESS", transactionId: "TRANSACTION_ID", content: "CONTENT",
  teeSheetId: "TEE_SHEET_ID", courseId: "COURSE_ID", startTime: "START_TIME", availableParticipantNo: "PARTICIPANTS",
  minPlayer: "MIN_PLAYER", holes: "HOLES", defaultHoles: "DEFAULT_HOLES" };
const kinds = ["INVALID_TYPE", "INVALID_VALUE", "UNRECOGNIZED_KEYS", "TOO_BIG", "TOO_SMALL", "INVALID_FORMAT", "CUSTOM"];

/** Closed parser facts only. Never retain response values, field names outside
 * the fixed vocabulary, IDs, dates, URLs, bodies or credentials. */
export function failCpsAvailability(stage: Diagnostic["stage"], value: unknown, transactionId: string, row?: unknown, issues: readonly Issue[] = []): never {
  const error = Error("CPS_AVAILABILITY_INCOMPLETE");
  try {
    const envelope = object(value), rows = envelope.content;
    const diagnostic = { schemaVersion: 1, stage, envelopeObject: value !== null && typeof value === "object" && !Array.isArray(value),
      successTrue: envelope.isSuccess === true, transactionMatches: envelope.transactionId === transactionId,
      transactionMatchesIgnoringCase: typeof envelope.transactionId === "string" && envelope.transactionId.toLowerCase() === transactionId.toLowerCase(),
      rowCount: Array.isArray(rows) ? boundedCount(rows.length) : "NOT_ARRAY", issuesOmitted: issues.length > 12,
      issues: issues.slice(0, 12).map(issue => {
        const lastField = issue.path.filter(part => typeof part === "string").at(-1);
        const field = issue.path.length === 0 ? "ENVELOPE" : issue.path.length === 2 && issue.path[0] === "content" && typeof issue.path[1] === "number"
          ? "ROW" : Object.hasOwn(fields, String(lastField)) ? fields[String(lastField)] : "OTHER";
        let item: unknown = value;
        for (const part of issue.path) item = typeof part === "number" && Array.isArray(item) ? item[part] :
          typeof part === "string" && Object.hasOwn(fields, part) ? object(item)[part] : undefined;
        const kind = issue.code.toUpperCase();
        return { field, kind: kinds.includes(kind) ? kind : "OTHER", valueType: valueType(item),
          ...(typeof item === "number" ? { safePositiveInteger: Number.isSafeInteger(item) && item > 0 } : {}),
          ...(issue.code === "unrecognized_keys" && Array.isArray(issue.keys) ? { extraKeyCount: boundedCount(issue.keys.length) } : {}) };
      }), ...(stage === "ROUND_LENGTH" ? { roundLength: { holes: category(object(row).holes), defaultHoles: category(object(row).defaultHoles) } } : {}) };
    const parsed = cpsAvailabilityDiagnosticSchema.safeParse(diagnostic);
    if (parsed.success) failures.set(error, parsed.data);
    if (stage === "SCHEMA" && parsed.success && parsed.data.issues.some(issue => issue.field === "CONTENT" && issue.valueType === "OBJECT")) {
      const structure = captureCpsAvailabilityStructure(rows);
      if (structure) structures.set(error, structure);
    }
  } catch { /* Optional diagnostics cannot replace the parser's rejection. */ }
  throw error;
}
export function getCpsAvailabilityDiagnostic(error: unknown) {
  const value = error && typeof error === "object" ? failures.get(error) : undefined;
  return value ? structuredClone(value) : undefined;
}
export function getPrivateCpsAvailabilityStructure(error: unknown) {
  const value = error && typeof error === "object" ? structures.get(error) : undefined;
  return value ? structuredClone(value) : undefined;
}
