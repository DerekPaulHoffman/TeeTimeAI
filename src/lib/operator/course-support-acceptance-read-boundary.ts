import type { Prisma } from "@prisma/client";
import { AcceptanceBytePreflightFence, createAcceptanceBytePreflight } from "./course-support-acceptance-read-size-boundary";
import { ACCEPTANCE_READ_BOUNDARIES, type AcceptanceReadBoundary } from "./course-support-acceptance-read-fence";
import { classifyAcceptanceReadQuery, parseAcceptanceReadCost, type AcceptanceReadCost } from "./course-support-acceptance-read-cost";

export const ACCEPTANCE_READ_LIMITS = {
  incidentRows: 1_024,
  courseRows: 4_096,
  batchRows: 2_048,
  evidenceRows: 16_384,
  evidenceBytes: 16 * 1_024 * 1_024,
  outputBytes: 64 * 1_024,
  // Prisma/preflight operations, not physical SQL statements. A full 112-course
  // campaign needs up to 14 operations per exact-cycle reload plus 11 for reader
  // admission. 4096 covers 112*32 plus 256 shared-operation headroom; all other
  // row/history/identity/byte and transaction-time fences remain independent.
  queryCount: 4_096,
} as const;

export class AcceptanceReadFence extends Error {
  readonly boundary: AcceptanceReadBoundary | null;
  readonly readCost: AcceptanceReadCost | null;
  constructor(public readonly reason: "EVIDENCE_BOUND_EXCEEDED" | "READ_FAILED", boundary: AcceptanceReadBoundary | null = null,
    readCost: AcceptanceReadCost | null = null) {
    super(reason);
    this.boundary = (ACCEPTANCE_READ_BOUNDARIES as readonly unknown[]).includes(boundary) ? boundary : null;
    this.readCost = reason === "EVIDENCE_BOUND_EXCEEDED" && this.boundary === "SELECTED_EVIDENCE_BYTES"
      ? parseAcceptanceReadCost(readCost) : null;
  }
}

type ReadDelegate = Record<string, (args?: unknown) => Promise<unknown>>;
type Query = { where?: Record<string, unknown>; take?: number; select?: Record<string, unknown>; include?: Record<string, unknown> };

const MODELS = new Set([
  "automationRun", "course", "courseSupportIncident", "courseSupportBatch",
  "courseSupportBatchIncident", "courseMonitoringEvent", "courseProbe",
  "coursePreference", "localReaderAgent", "localReaderJob", "teeSearch", "courseSupportVerificationRequest",
]);
const METHODS = new Set(["count", "findMany", "findFirst", "findUnique", "groupBy"]);

/** Counts precede native reads; no selector is truncated or rewritten. */
export function createBoundedAcceptanceReadClient(database: Prisma.TransactionClient) {
  let queryCount = 0;
  let transferredArrayItems = 0;
  let transferredBytes = 0;
  let firstFence: AcceptanceReadFence | null = null;
  const delegates = new Map<string, ReadDelegate>();

  function throwFence(error: AcceptanceReadFence): never {
    firstFence ??= error;
    throw firstFence;
  }
  function assertOpen() {
    if (firstFence) throw firstFence;
  }
  function tick() {
    assertOpen();
    if (++queryCount > ACCEPTANCE_READ_LIMITS.queryCount) throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "QUERY_OPERATIONS"));
  }
  const preflightBytes = createAcceptanceBytePreflight(database, {
    tick, maxBytes: ACCEPTANCE_READ_LIMITS.evidenceBytes,
    maxIdentityItems: ACCEPTANCE_READ_LIMITS.evidenceRows,
  });
  function delegate(name: string): ReadDelegate {
    return Reflect.get(database, name) as ReadDelegate;
  }
  function rowLimit(name: string) {
    if (name === "courseSupportIncident") return ACCEPTANCE_READ_LIMITS.incidentRows;
    if (name === "course") return ACCEPTANCE_READ_LIMITS.courseRows;
    if (name === "courseSupportBatch") return ACCEPTANCE_READ_LIMITS.batchRows;
    return ACCEPTANCE_READ_LIMITS.evidenceRows;
  }
  async function count(name: string, where: unknown): Promise<number> {
    tick();
    const value = await delegate(name).count({ where });
    if (!Number.isSafeInteger(value) || (value as number) < 0) throwFence(new AcceptanceReadFence("READ_FAILED"));
    return value as number;
  }
  async function guardIncidentRelations(query: Query) {
    const selected = query.select ?? query.include ?? {};
    const history = selected.monitoringEvents;
    if (history && typeof history === "object") {
      const nested = history as Query;
      if (nested.take === undefined) {
        const where = { AND: [nested.where ?? {}, { incident: { is: query.where ?? {} } }] };
        if (await count("courseMonitoringEvent", where) > ACCEPTANCE_READ_LIMITS.evidenceRows) {
          throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "INCIDENT_HISTORY_ROWS"));
        }
        await guardHistoryGroups(where);
      }
    }
    const course = selected.course as Query | undefined;
    const preferences = (course?.select ?? course?.include)?.preferences as Query | undefined;
    if (preferences && preferences.take === undefined &&
        await count("coursePreference", { AND: [preferences.where ?? {},
          { course: { supportIncident: { is: query.where ?? {} } } }] }) > ACCEPTANCE_READ_LIMITS.evidenceRows) {
      throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "NESTED_PREFERENCE_ROWS"));
    }
    const batchIncidents = selected.batchIncidents as Query | undefined;
    if (batchIncidents) await guardVerificationRequests({
      ...batchIncidents, where: { AND: [batchIncidents.where ?? {}, { incident: { is: query.where ?? {} } }] },
    });
  }
  async function guardHistoryGroups(where: unknown) {
    tick();
    const groups = await delegate("courseMonitoringEvent").groupBy({
      by: ["incidentId"], where, _count: { _all: true },
    }) as Array<{ _count: { _all: number } }>;
    if (!Array.isArray(groups) || groups.length > ACCEPTANCE_READ_LIMITS.incidentRows ||
        groups.some((group) => !Number.isSafeInteger(group._count?._all) ||
          group._count._all < 0 || group._count._all > ACCEPTANCE_READ_LIMITS.incidentRows)) {
      throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "INCIDENT_HISTORY_GROUPS"));
    }
  }
  async function guardVerificationRequests(query: Query) {
    const requests = (query.select ?? query.include)?.verificationRequests as Query | undefined;
    if (requests && requests.take === undefined &&
        await count("courseSupportVerificationRequest", { AND: [requests.where ?? {},
          { batchIncident: { is: query.where ?? {} } }] }) > ACCEPTANCE_READ_LIMITS.evidenceRows) {
      throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "VERIFICATION_REQUEST_ROWS"));
    }
  }
  function checkTransferred(value: unknown) {
    assertOpen();
    const visit = (item: unknown, depth: number) => {
      if (depth > 128) throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "TRANSFER_DEPTH"));
      if (Array.isArray(item)) {
        transferredArrayItems += item.length;
        if (transferredArrayItems > ACCEPTANCE_READ_LIMITS.evidenceRows) throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "TRANSFER_ARRAY_ITEMS"));
        for (const child of item) visit(child, depth + 1);
      } else if (item && typeof item === "object" && !(item instanceof Date)) {
        for (const child of Object.values(item)) visit(child, depth + 1);
      }
    };
    visit(value, 0);
    transferredBytes += Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    if (transferredBytes > ACCEPTANCE_READ_LIMITS.evidenceBytes) throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "TRANSFER_BYTES"));
  }

  return new Proxy({} as Prisma.TransactionClient, {
    get(_target, property) {
      if (typeof property !== "string" || !MODELS.has(property)) throwFence(new AcceptanceReadFence("READ_FAILED"));
      if (!delegates.has(property)) {
        delegates.set(property, new Proxy({} as ReadDelegate, {
          get(_delegate, method) {
            if (typeof method !== "string" || !METHODS.has(method)) throwFence(new AcceptanceReadFence("READ_FAILED"));
            return async (args: Query = {}) => {
              assertOpen();
              const queryCategory = classifyAcceptanceReadQuery(property, method, args);
              try {
                if (method === "findMany" || method === "groupBy") {
                  // Counting raw matches is conservative for native distinct/grouped
                  // reads. Do not add take: it could alter which latest rows survive.
                  const matched = await count(property, args.where);
                  const selected = args.take === undefined ? matched : Math.min(matched, args.take);
                  if (!Number.isSafeInteger(selected) || selected < 0 || selected > rowLimit(property)) {
                    throwFence(new AcceptanceReadFence("EVIDENCE_BOUND_EXCEEDED", "TOP_LEVEL_ROWS"));
                  }
                }
                if (property === "courseSupportIncident" && method !== "count" && method !== "groupBy") {
                  await guardIncidentRelations(args);
                }
                if (property === "courseSupportBatchIncident" && method !== "count" && method !== "groupBy") {
                  await guardVerificationRequests(args);
                }
                if (property === "courseMonitoringEvent" && method === "findMany" && args.take === undefined) {
                  await guardHistoryGroups(args.where);
                }
                if (method === "findMany" || method === "findFirst" || method === "findUnique") {
                  await preflightBytes(property, method, args, queryCategory);
                }
                tick();
                const result = await delegate(property)[method](args);
                checkTransferred(result);
                return result;
              } catch (error) {
                if (error instanceof AcceptanceReadFence) throwFence(error);
                if (error instanceof AcceptanceBytePreflightFence) {
                  throwFence(new AcceptanceReadFence(error.reason, error.boundary, error.readCost));
                }
                if (firstFence) throw firstFence;
                throw error;
              }
            };
          },
        }));
      }
      return delegates.get(property);
    },
  });
}
