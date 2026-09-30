import { Prisma } from "@prisma/client";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { ACCEPTANCE_READ_BOUNDARIES, type AcceptanceReadBoundary } from "./course-support-acceptance-read-fence";

const MAX_IDENTITY_ITEMS = 16_384;
const MAX_IDENTITY_DEPTH = 16;
const MAX_IDENTITY_STRING_BYTES = 512;
const WHOLE_ROW_BYTE_FACTOR = 2n;

type Model = (typeof Prisma.dmmf.datamodel.models)[number];
type IdentityQuery = Record<string, unknown>;
type IdentityPlan = {
  model: Model;
  id: Model["fields"][number];
  method: ReadMethod;
  query: IdentityQuery;
  scalarFields: ReadonlySet<string>;
  relations: ReadonlyMap<string, {
    plan: IdentityPlan; isList: boolean; inverseName: string; inverseIsList: boolean;
  }>;
};
type ReadMethod = "findMany" | "findFirst" | "findUnique";
type IdentityReadDelegate = Record<ReadMethod, (args: unknown) => Promise<unknown>>;

export class AcceptanceBytePreflightFence extends Error {
  readonly boundary: AcceptanceReadBoundary | null;
  constructor(public readonly reason: "EVIDENCE_BOUND_EXCEEDED" | "READ_FAILED", boundary: AcceptanceReadBoundary | null = null) {
    super(reason);
    this.boundary = (ACCEPTANCE_READ_BOUNDARIES as readonly unknown[]).includes(boundary) ? boundary : null;
  }
}

let generatedModels: { byName: Map<string, Model>; byDelegate: Map<string, Model> } | null = null;

function generatedModelMetadata() {
  if (generatedModels) return generatedModels;
  try {
    // Prisma7's runtime DMMF omits ID/list/map flags. Read those missing facts
    // from that same generated client's schema, never a cwd/source fallback.
    const schemaPath = createRequire(import.meta.url).resolve(".prisma/client/schema.prisma");
    if (statSync(schemaPath).size > 1_048_576) return fail("READ_FAILED");
    const schema = readFileSync(schemaPath, "utf8");
    const blocks = new Map([...schema.matchAll(/^model ([A-Za-z_][A-Za-z0-9_]*) \{\r?\n([\s\S]*?)^\}/gmu)]
      .map((match) => [match[1], match[2]]));
    if (blocks.size !== Prisma.dmmf.datamodel.models.length) return fail("READ_FAILED");
    const models = Prisma.dmmf.datamodel.models.map((model): Model => {
      const block = blocks.get(model.name);
      if (block === undefined || /@@(?:schema|ignore)\b/u.test(block)) return fail("READ_FAILED");
      const mappedName = block.match(/^\s*@@map\(("(?:\\.|[^"\\])*")\)\s*$/mu);
      const dbName = mappedName ? JSON.parse(mappedName[1]) as string : null;
      if (typeof dbName !== "string" && dbName !== null || (model.dbName ?? null) !== dbName) return fail("READ_FAILED");
      const fields = model.fields.map((field) => {
        const line = block.split(/\r?\n/u).find((candidate) => new RegExp(`^\\s*${field.name}\\s+`, "u").test(candidate));
        const parsed = line?.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\]|\?)?(?:\s+(.*))?$/u);
        if (!parsed || parsed[2] !== field.type) return fail("READ_FAILED");
        const attributes = parsed[4] ?? "";
        if (/@ignore\b/u.test(attributes)) return fail("READ_FAILED");
        const mapped = attributes.match(/(?:^|\s)@map\(("(?:\\.|[^"\\])*")\)/u);
        const fieldDbName = mapped ? JSON.parse(mapped[1]) as string : null;
        if (typeof fieldDbName !== "string" && fieldDbName !== null ||
            field.dbName !== undefined && field.dbName !== null && field.dbName !== fieldDbName) return fail("READ_FAILED");
        const isId = /(?:^|\s)@id(?:\s|\(|$)/u.test(attributes);
        const isList = parsed[3] === "[]";
        if (typeof field.isId === "boolean" && field.isId !== isId ||
            typeof field.isList === "boolean" && field.isList !== isList) return fail("READ_FAILED");
        return { ...field, isId, isList, dbName: fieldDbName };
      });
      return { ...model, dbName, fields };
    });
    generatedModels = {
      byName: new Map(models.map((model) => [model.name, model])),
      byDelegate: new Map(models.map((model) => [model.name[0].toLowerCase() + model.name.slice(1), model])),
    };
    return generatedModels;
  } catch (error) {
    if (error instanceof AcceptanceBytePreflightFence) throw error;
    return fail("READ_FAILED");
  }
}

function fail(reason: "EVIDENCE_BOUND_EXCEEDED" | "READ_FAILED", boundary: AcceptanceReadBoundary | null = null): never {
  throw new AcceptanceBytePreflightFence(reason, boundary);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    return fail("READ_FAILED");
  }
  return value as Record<string, unknown>;
}

function identityPlan(
  model: Model, args: unknown, method: ReadMethod, ancestors = new Set<string>(),
): IdentityPlan {
  if (ancestors.size >= MAX_IDENTITY_DEPTH || ancestors.has(model.name)) {
    return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_PLAN_DEPTH_OR_CYCLE");
  }
  const ids = model.fields.filter((field) => field.isId);
  if (ids.length !== 1 || !["String", "Int", "BigInt"].includes(ids[0].type)) {
    return fail("READ_FAILED");
  }
  const input = record(args);
  if ((input.select !== undefined && input.include !== undefined) || input.omit !== undefined) {
    return fail("READ_FAILED");
  }
  const id = ids[0];
  const select: Record<string, unknown> = { [id.name]: true };
  const scalarFields = new Set([id.name]);
  const relations = new Map<string, {
    plan: IdentityPlan; isList: boolean; inverseName: string; inverseIsList: boolean;
  }>();
  const distinct = input.distinct === undefined ? []
    : typeof input.distinct === "string" ? [input.distinct]
      : Array.isArray(input.distinct) ? input.distinct : fail("READ_FAILED");
  for (const key of distinct) {
    const field = model.fields.find((candidate) => candidate.name === key);
    if (typeof key !== "string" || !field || field.kind === "object" ||
        field.isList || ["Json", "Bytes", "Unsupported"].includes(field.type)) {
      return fail("READ_FAILED");
    }
    select[key] = true;
    scalarFields.add(key);
  }
  const selected = input.select ?? input.include;
  if (selected !== undefined) {
    for (const [key, value] of Object.entries(record(selected))) {
      if (value === false || value === undefined || key === "_count") continue;
      const field = model.fields.find((candidate) => candidate.name === key);
      if (!field) return fail("READ_FAILED");
      if (field.kind !== "object") continue;
      const related = generatedModelMetadata().byName.get(field.type);
      if (!related) return fail("READ_FAILED");
      const inverse = related.fields.filter((candidate) =>
        candidate.kind === "object" && candidate.type === model.name &&
        candidate.relationName === field.relationName,
      );
      if (inverse.length !== 1 || (field.isList && inverse[0].isList)) return fail("READ_FAILED");
      const plan = identityPlan(
        related, value === true ? {} : value, field.isList ? "findMany" : "findUnique",
        new Set([...ancestors, model.name]),
      );
      select[key] = plan.query;
      relations.set(key, {
        plan, isList: field.isList, inverseName: inverse[0].name, inverseIsList: inverse[0].isList,
      });
    }
  }
  const { select: originalSelect, include: originalInclude, ...scope } = input;
  void originalSelect;
  void originalInclude;
  // The native query can choose any timestamp-tied row. Only the auxiliary
  // identity read broadens in that case; an arbitrary tie-breaker would change
  // which evidence is covered. The original evidence query is never modified.
  const order = Array.isArray(scope.orderBy) ? scope.orderBy : [scope.orderBy];
  const orderedById = order.some((value) => value && typeof value === "object" &&
    !Array.isArray(value) && ["asc", "desc"].includes((value as Record<string, unknown>)[id.name] as string));
  if (method !== "findUnique" && !orderedById &&
      (scope.take !== undefined || scope.distinct !== undefined || scope.skip !== undefined ||
        scope.cursor !== undefined || method === "findFirst")) {
    delete scope.take;
    delete scope.distinct;
    delete scope.skip;
    delete scope.cursor;
    method = "findMany";
  }
  return { model, id, method, scalarFields, relations, query: { ...scope, select } };
}

function identityValue(value: unknown, field: Model["fields"][number]): string {
  if (field.type === "String" ? typeof value !== "string"
    : field.type === "Int" ? !Number.isSafeInteger(value)
      : typeof value !== "bigint") return fail("READ_FAILED");
  const identity = String(value);
  if (!identity || Buffer.byteLength(identity, "utf8") > MAX_IDENTITY_STRING_BYTES) {
    return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_VALUE_BYTES");
  }
  return identity;
}

function quotedGeneratedIdentifier(value: string) {
  return Prisma.raw(`"${value.replaceAll('"', '""')}"`);
}

function nonnegativeInteger(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,30}$/u.test(value)) return BigInt(value);
  return fail("READ_FAILED");
}

/** Read only selected identities and byte aggregates before native evidence hydration. */
export function createAcceptanceBytePreflight(
  transaction: Prisma.TransactionClient,
  options: { tick: () => void; maxBytes: number; maxIdentityItems?: number },
) {
  const maxIdentityItems = options.maxIdentityItems ?? MAX_IDENTITY_ITEMS;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 ||
      !Number.isSafeInteger(maxIdentityItems) || maxIdentityItems < 1) {
    return fail("READ_FAILED");
  }
  let cumulativeBytes = 0n;
  return async (delegateName: string, method: ReadMethod, args: unknown = {}) => {
    try {
      const model = generatedModelMetadata().byDelegate.get(delegateName);
      if (!model || !["findMany", "findFirst", "findUnique"].includes(method)) return fail("READ_FAILED");
      const plan = identityPlan(model, args, method);
      let boundedIdentityItems = 0;
      const guardIdentityRows = async (
        current: IdentityPlan, where = current.query.where,
        parent?: { rows: number; isList: boolean; multiplicity: number; inverseIsList: boolean },
      ) => {
        options.tick();
        const counted = await (Reflect.get(transaction, current.model.name[0].toLowerCase() + current.model.name.slice(1)) as {
          count: (input: unknown) => Promise<unknown>;
        }).count({ where });
        if (!Number.isSafeInteger(counted) || (counted as number) < 0) return fail("READ_FAILED");
        const take = current.query.take;
        if (take !== undefined && (!Number.isSafeInteger(take) || (take as number) < 0)) return fail("READ_FAILED");
        const rows = parent
          ? parent.isList
            ? Math.min((counted as number) * parent.multiplicity,
              take === undefined ? (counted as number) * parent.multiplicity : parent.rows * (take as number))
            : counted === 0 ? 0 : parent.rows
          : Math.min(counted as number, current.method === "findMany" ? (take as number | undefined) ?? counted as number : 1);
        boundedIdentityItems += rows;
        if (!Number.isSafeInteger(boundedIdentityItems) || boundedIdentityItems > maxIdentityItems) {
          return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_PRECOUNT_ITEMS");
        }
        if (rows === 0) return;
        const multiplicity = !parent ? 1
          : parent.isList || !parent.inverseIsList ? parent.multiplicity : parent.rows;
        for (const relation of current.relations.values()) {
          await guardIdentityRows(relation.plan, { AND: [relation.plan.query.where ?? {}, {
            [relation.inverseName]: relation.inverseIsList ? { some: where ?? {} } : { is: where ?? {} },
          }] }, { rows, isList: relation.isList, inverseIsList: relation.inverseIsList, multiplicity });
        }
      };
      await guardIdentityRows(plan);
      options.tick();
      const delegate = Reflect.get(transaction, delegateName) as IdentityReadDelegate;
      const result = await delegate[plan.method](plan.query);
      const identitiesByModel = new Map<Model, Map<string, number>>();
      let identityItems = 0;
      const collectRow = (value: unknown, current: IdentityPlan) => {
        if (++identityItems > maxIdentityItems) return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_RESULT_ITEMS");
        const row = record(value);
        const identity = identityValue(row[current.id.name], current.id);
        const identities = identitiesByModel.get(current.model) ?? new Map<string, number>();
        identities.set(identity, (identities.get(identity) ?? 0) + 1);
        identitiesByModel.set(current.model, identities);
        for (const key of Object.keys(row)) {
          if (!current.scalarFields.has(key) && !current.relations.has(key)) return fail("READ_FAILED");
        }
        for (const field of current.scalarFields) {
          if (!(field in row)) return fail("READ_FAILED");
          const scalar = row[field];
          if (scalar !== null && typeof scalar === "object" && !(scalar instanceof Date)) return fail("READ_FAILED");
          if (typeof scalar === "string" && Buffer.byteLength(scalar, "utf8") > MAX_IDENTITY_STRING_BYTES) {
            return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_VALUE_BYTES");
          }
        }
        for (const [key, relation] of current.relations) {
          const related = row[key];
          if (relation.isList) {
            if (!Array.isArray(related)) return fail("READ_FAILED");
            if (identityItems + related.length > maxIdentityItems) return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_RESULT_ITEMS");
            for (const child of related) collectRow(child, relation.plan);
          } else if (related !== null) {
            collectRow(related, relation.plan);
          }
        }
      };
      if (plan.method === "findMany") {
        if (!Array.isArray(result)) return fail("READ_FAILED");
        if (result.length > maxIdentityItems) return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_RESULT_ITEMS");
        for (const row of result) collectRow(row, plan);
      } else if (result !== null) collectRow(result, plan);

      for (const [selectedModel, identities] of identitiesByModel) {
        const id = selectedModel.fields.find((field) => field.isId)!;
        const multiplicity = Math.max(...identities.values());
        options.tick();
        const totals = await transaction.$queryRaw<Array<{ bytes: bigint; matchedRows: bigint }>>(Prisma.sql`
          SELECT COALESCE(SUM(octet_length(to_jsonb(acceptance_row)::text)), 0)::bigint AS "bytes",
                 COUNT(*)::bigint AS "matchedRows"
          FROM ${quotedGeneratedIdentifier(selectedModel.dbName ?? selectedModel.name)} AS acceptance_row
          WHERE acceptance_row.${quotedGeneratedIdentifier(id.dbName ?? id.name)}::text IN (${Prisma.join([...identities.keys()])})
        `);
        if (!Array.isArray(totals) || totals.length !== 1) return fail("READ_FAILED");
        const total = record(totals[0]);
        const bytes = nonnegativeInteger(total.bytes);
        if (nonnegativeInteger(total.matchedRows) !== BigInt(identities.size)) return fail("READ_FAILED");
        cumulativeBytes += bytes * BigInt(multiplicity) * WHOLE_ROW_BYTE_FACTOR;
        if (cumulativeBytes > BigInt(options.maxBytes)) return fail("EVIDENCE_BOUND_EXCEEDED", "WHOLE_ROW_BYTES");
      }
    } catch (error) {
      if (error instanceof AcceptanceBytePreflightFence) throw error;
      const nativeCode = error && typeof error === "object" && "code" in error ? error.code : null;
      const meta = error && typeof error === "object" && "meta" in error ? error.meta : null;
      const metaCode = meta && typeof meta === "object" && "code" in meta ? meta.code : null;
      const timeoutCode = nativeCode === "P2028" || nativeCode === "57014" ? nativeCode
        : metaCode === "57014" ? metaCode : null;
      if (timeoutCode) throw Object.assign(new Error("READ_TIMEOUT"), { code: timeoutCode });
      if (error instanceof Error && "reason" in error &&
          (error.reason === "EVIDENCE_BOUND_EXCEEDED" || error.reason === "READ_FAILED")) {
        return fail(error.reason);
      }
      return fail("READ_FAILED");
    }
  };
}
