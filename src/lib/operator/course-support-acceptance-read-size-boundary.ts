import { Prisma } from "@prisma/client";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { ACCEPTANCE_READ_BOUNDARIES, type AcceptanceReadBoundary } from "./course-support-acceptance-read-fence";
import { createAcceptanceReadCost, parseAcceptanceReadCost, type AcceptanceReadCost,
  type AcceptanceReadQueryCategory } from "./course-support-acceptance-read-cost";

const MAX_IDENTITY_ITEMS = 16_384;
const MAX_IDENTITY_DEPTH = 16;
const MAX_IDENTITY_STRING_BYTES = 512;
const SELECTED_EVIDENCE_BYTE_FACTOR = 2n;
const MAX_NUMBER_OR_DATE_JSON_BYTES = 32;
const MAX_JSON_OBJECT_PAIRS = 50;

type Model = (typeof Prisma.dmmf.datamodel.models)[number];
type IdentityQuery = Record<string, unknown>;
type IdentityPlan = {
  model: Model;
  id: Model["fields"][number];
  method: ReadMethod;
  query: IdentityQuery;
  scalarFields: ReadonlySet<string>;
  evidenceScalarFields: readonly Model["fields"][number][];
  countFields: ReadonlySet<string> | null;
  relations: ReadonlyMap<string, {
    plan: IdentityPlan; isList: boolean; inverseName: string; inverseIsList: boolean;
  }>;
};
type ReadMethod = "findMany" | "findFirst" | "findUnique";
type IdentityReadDelegate = Record<ReadMethod, (args: unknown) => Promise<unknown>>;

export class AcceptanceBytePreflightFence extends Error {
  readonly boundary: AcceptanceReadBoundary | null;
  readonly readCost: AcceptanceReadCost | null;
  constructor(public readonly reason: "EVIDENCE_BOUND_EXCEEDED" | "READ_FAILED", boundary: AcceptanceReadBoundary | null = null,
    cost: AcceptanceReadCost | null = null) {
    super(reason);
    this.boundary = (ACCEPTANCE_READ_BOUNDARIES as readonly unknown[]).includes(boundary) ? boundary : null;
    this.readCost = reason === "EVIDENCE_BOUND_EXCEEDED" && this.boundary === "SELECTED_EVIDENCE_BYTES"
      ? parseAcceptanceReadCost(cost) : null;
  }
}

let generatedModels: {
  byName: Map<string, Model>; byDelegate: Map<string, Model>; enumStringBytes: Map<string, number>;
} | null = null;

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
    const enumStringBytes = new Map([...schema.matchAll(/^enum ([A-Za-z_][A-Za-z0-9_]*) \{\r?\n([\s\S]*?)^\}/gmu)]
      .map((match): [string, number] => {
        const values = match[2].split(/\r?\n/u).filter((line) => line.trim() && !/^\s*(?:\/\/|@@)/u.test(line))
          .map((line) => {
            const value = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+@map\("(?:\\.|[^"\\])*"\))?\s*(?:\/\/.*)?$/u)?.[1];
            if (!value) return fail("READ_FAILED");
            return Buffer.byteLength(JSON.stringify(value), "utf8");
          });
        if (values.length === 0) return fail("READ_FAILED");
        return [match[1], Math.max(...values)];
      }));
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
      enumStringBytes,
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

function supportedEvidenceScalar(field: Model["fields"][number]) {
  if (field.kind === "enum") {
    if (!generatedModelMetadata().enumStringBytes.has(field.type)) return fail("READ_FAILED");
  } else if (field.kind !== "scalar" || !["String", "Int", "Float", "Boolean", "DateTime", "Json"].includes(field.type)) {
    return fail("READ_FAILED");
  }
  return field;
}

function countSelection(model: Model, value: unknown): ReadonlySet<string> {
  const available = model.fields.filter((field) => field.kind === "object" && field.isList).map((field) => field.name);
  if (value === true) return new Set(available);
  const input = record(value);
  if (Object.keys(input).length !== 1 || !("select" in input)) return fail("READ_FAILED");
  const selected = new Set<string>();
  for (const [key, selection] of Object.entries(record(input.select))) {
    if (selection === false || selection === undefined) continue;
    if (selection !== true || !available.includes(key)) return fail("READ_FAILED");
    selected.add(key);
  }
  return selected;
}

function identityPlan(
  model: Model, args: unknown, method: ReadMethod, ancestors = new Set<string>(), nestedList = false,
): IdentityPlan {
  if (ancestors.size >= MAX_IDENTITY_DEPTH || ancestors.has(model.name)) {
    return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_PLAN_DEPTH_OR_CYCLE");
  }
  const ids = model.fields.filter((field) => field.isId);
  if (ids.length !== 1 || !["String", "Int", "BigInt"].includes(ids[0].type)) {
    return fail("READ_FAILED");
  }
  const input = record(args);
  const nativeSelect = input.select === null ? undefined : input.select;
  const nativeInclude = input.include === null ? undefined : input.include;
  if ((nativeSelect !== undefined && nativeInclude !== undefined) || input.omit !== undefined) {
    return fail("READ_FAILED");
  }
  const id = ids[0];
  const select: Record<string, unknown> = { [id.name]: true };
  const scalarFields = new Set([id.name]);
  const evidenceScalarFields = new Map<string, Model["fields"][number]>();
  let countFields: ReadonlySet<string> | null = null;
  if (nativeSelect === undefined) {
    for (const field of model.fields.filter((field) => field.kind !== "object")) {
      evidenceScalarFields.set(field.name, supportedEvidenceScalar(field));
    }
  }
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
  const selected = nativeSelect ?? nativeInclude;
  if (selected !== undefined) {
    for (const [key, value] of Object.entries(record(selected))) {
      if (value === false || value === undefined) continue;
      if (key === "_count") {
        countFields = countSelection(model, value);
        continue;
      }
      const field = model.fields.find((candidate) => candidate.name === key);
      if (!field) return fail("READ_FAILED");
      if (field.kind !== "object") {
        if (nativeInclude !== undefined || value !== true) return fail("READ_FAILED");
        evidenceScalarFields.set(field.name, supportedEvidenceScalar(field));
        continue;
      }
      const related = generatedModelMetadata().byName.get(field.type);
      if (!related) return fail("READ_FAILED");
      const inverse = related.fields.filter((candidate) =>
        candidate.kind === "object" && candidate.type === model.name &&
        candidate.relationName === field.relationName,
      );
      if (inverse.length !== 1 || (field.isList && inverse[0].isList)) return fail("READ_FAILED");
      const plan = identityPlan(
        related, value === true ? {} : value, field.isList ? "findMany" : "findUnique",
        new Set([...ancestors, model.name]), field.isList,
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
  // Prisma's Query strategy may fetch every matching child before applying
  // per-parent list pagination, even with a unique-ID order. Cover that physical
  // scope in every auxiliary nested-list read, conservatively including single
  // parents. Query-strategy distinct can also run after hydration despite an ID
  // order, so cover its physical scope. Pure top-level deterministic limits stay
  // intact; timestamp-tied reads still cover all possible winners. The native
  // query is never modified.
  const order = Array.isArray(scope.orderBy) ? scope.orderBy : [scope.orderBy];
  const orderedById = order.some((value) => value && typeof value === "object" &&
    !Array.isArray(value) && ["asc", "desc"].includes((value as Record<string, unknown>)[id.name] as string));
  if (method !== "findUnique" && (nestedList || input.distinct !== undefined || !orderedById) &&
      (scope.take !== undefined || scope.distinct !== undefined || scope.skip !== undefined ||
        scope.cursor !== undefined || method === "findFirst")) {
    delete scope.take;
    delete scope.distinct;
    delete scope.skip;
    delete scope.cursor;
    method = "findMany";
  }
  return { model, id, method, scalarFields, evidenceScalarFields: [...evidenceScalarFields.values()], countFields,
    relations, query: { ...scope, select } };
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

function selectedRowByteExpression(fields: readonly Model["fields"][number][]) {
  const chunks: Prisma.Sql[] = [];
  for (let offset = 0; offset < fields.length; offset += MAX_JSON_OBJECT_PAIRS) {
    const pairs = fields.slice(offset, offset + MAX_JSON_OBJECT_PAIRS).map((field) => Prisma.sql`
      ${field.name}::text, acceptance_row.${quotedGeneratedIdentifier(field.dbName ?? field.name)}
    `);
    chunks.push(Prisma.sql`jsonb_build_object(${Prisma.join(pairs)})`);
  }
  const projection = chunks.length ? Prisma.sql`(${Prisma.join(chunks, " || ")})` : Prisma.sql`'{}'::jsonb`;
  const padding = fields.flatMap((field) => {
    const bytes = field.kind === "enum" ? generatedModelMetadata().enumStringBytes.get(field.type)!
      : field.type === "Float" || field.type === "DateTime" ? MAX_NUMBER_OR_DATE_JSON_BYTES : 0;
    if (!bytes) return [];
    const occurrences = field.isList
      ? Prisma.sql`COALESCE(cardinality(acceptance_row.${quotedGeneratedIdentifier(field.dbName ?? field.name)}), 0)::bigint`
      : Prisma.sql`1::bigint`;
    return [Prisma.sql`${bytes}::bigint * ${occurrences}`];
  });
  // JSONB covers selected keys, JSON/string escaping and scalar/list syntax.
  // Add a full native JSON allowance for each Float/DateTime and enum value.
  const typedPadding = padding.length ? Prisma.sql`(${Prisma.join(padding, " + ")})` : Prisma.sql`0::bigint`;
  return Prisma.sql`octet_length(${projection}::text) + ${typedPadding}`;
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
  let terminalFence: AcceptanceBytePreflightFence | null = null;
  const throwIfFenced = () => {
    if (terminalFence) throw terminalFence;
  };
  const tick = () => {
    throwIfFenced();
    options.tick();
  };
  return async (delegateName: string, method: ReadMethod, args: unknown = {},
    queryCategory: AcceptanceReadQueryCategory = "UNCLASSIFIED") => {
    try {
      throwIfFenced();
      const model = generatedModelMetadata().byDelegate.get(delegateName);
      if (!model || !["findMany", "findFirst", "findUnique"].includes(method)) return fail("READ_FAILED");
      const plan = identityPlan(model, args, method);
      let boundedIdentityItems = 0;
      const guardIdentityRows = async (
        current: IdentityPlan, where = current.query.where,
        parent?: { rows: number; isList: boolean; multiplicity: number; inverseIsList: boolean },
      ) => {
        tick();
        const counted = await (Reflect.get(transaction, current.model.name[0].toLowerCase() + current.model.name.slice(1)) as {
          count: (input: unknown) => Promise<unknown>;
        }).count({ where });
        throwIfFenced();
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
      tick();
      const delegate = Reflect.get(transaction, delegateName) as IdentityReadDelegate;
      const result = await delegate[plan.method](plan.query);
      throwIfFenced();
      const identitiesByModel = new Map<Model, Map<string, number>>();
      const selectedFieldsByModel = new Map<Model, Map<string, Model["fields"][number]>>();
      let identityItems = 0;
      let envelopeBytes = 0n;
      const addEnvelope = (bytes: number) => {
        envelopeBytes += BigInt(bytes);
        if (cumulativeBytes + envelopeBytes * SELECTED_EVIDENCE_BYTE_FACTOR > BigInt(options.maxBytes)) {
          throw new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", createAcceptanceReadCost({
            queryCategory, component: "STRUCTURAL_ENVELOPE", limitBytes: BigInt(options.maxBytes),
            cumulativeBeforeComponentBytes: cumulativeBytes,
            componentChargeBytes: envelopeBytes * SELECTED_EVIDENCE_BYTE_FACTOR,
            attemptedCumulativeBytes: cumulativeBytes + envelopeBytes * SELECTED_EVIDENCE_BYTE_FACTOR,
            hydrationObservedBytes: envelopeBytes * SELECTED_EVIDENCE_BYTE_FACTOR,
          }));
        }
      };
      const keyEnvelope = (key: string) => Buffer.byteLength(JSON.stringify(key), "utf8") + 2; // Colon and conservative comma.
      const collectRow = (value: unknown, current: IdentityPlan) => {
        if (++identityItems > maxIdentityItems) return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_RESULT_ITEMS");
        const row = record(value);
        const identity = identityValue(row[current.id.name], current.id);
        const identities = identitiesByModel.get(current.model) ?? new Map<string, number>();
        identities.set(identity, (identities.get(identity) ?? 0) + 1);
        identitiesByModel.set(current.model, identities);
        const selectedFields = selectedFieldsByModel.get(current.model) ?? new Map<string, Model["fields"][number]>();
        for (const field of current.evidenceScalarFields) selectedFields.set(field.name, field);
        selectedFieldsByModel.set(current.model, selectedFields);
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
          addEnvelope(keyEnvelope(key));
          if (relation.isList) {
            if (!Array.isArray(related)) return fail("READ_FAILED");
            if (identityItems + related.length > maxIdentityItems) return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_RESULT_ITEMS");
            addEnvelope(2 + Math.max(0, related.length - 1));
            for (const child of related) collectRow(child, relation.plan);
          } else if (related !== null) {
            collectRow(related, relation.plan);
          } else addEnvelope(4);
        }
        if (current.countFields !== null) {
          addEnvelope(keyEnvelope("_count") + 2);
          for (const key of current.countFields) addEnvelope(keyEnvelope(key) + MAX_NUMBER_OR_DATE_JSON_BYTES);
        }
      };
      if (plan.method === "findMany") {
        if (!Array.isArray(result)) return fail("READ_FAILED");
        if (result.length > maxIdentityItems) return fail("EVIDENCE_BOUND_EXCEEDED", "IDENTITY_RESULT_ITEMS");
        addEnvelope(2 + Math.max(0, result.length - 1));
        for (const row of result) collectRow(row, plan);
      } else if (result !== null) collectRow(result, plan);
      else addEnvelope(4);

      cumulativeBytes += envelopeBytes * SELECTED_EVIDENCE_BYTE_FACTOR;
      let hydrationObservedBytes = envelopeBytes * SELECTED_EVIDENCE_BYTE_FACTOR;

      for (const [selectedModel, identities] of identitiesByModel) {
        const id = selectedModel.fields.find((field) => field.isId)!;
        const weightedIdentities = [...identities].map(([identity, occurrences]) => {
          if (!Number.isSafeInteger(occurrences) || occurrences < 1 || occurrences > maxIdentityItems) {
            return fail("READ_FAILED");
          }
          return Prisma.sql`(${identity}::text, ${BigInt(occurrences)}::bigint)`;
        });
        tick();
        const selectedBytes = selectedRowByteExpression([...selectedFieldsByModel.get(selectedModel)!.values()]);
        const totals = await transaction.$queryRaw<Array<{ bytes: bigint; matchedRows: bigint }>>(Prisma.sql`
          SELECT COALESCE(SUM((${selectedBytes}) * acceptance_weight.occurrences), 0)::bigint AS "bytes",
                 COUNT(*)::bigint AS "matchedRows"
          FROM ${quotedGeneratedIdentifier(selectedModel.dbName ?? selectedModel.name)} AS acceptance_row
          JOIN (VALUES ${Prisma.join(weightedIdentities)}) AS acceptance_weight(identity, occurrences)
            ON acceptance_row.${quotedGeneratedIdentifier(id.dbName ?? id.name)}::text = acceptance_weight.identity
        `);
        throwIfFenced();
        if (!Array.isArray(totals) || totals.length !== 1) return fail("READ_FAILED");
        const total = record(totals[0]);
        const bytes = nonnegativeInteger(total.bytes);
        if (nonnegativeInteger(total.matchedRows) !== BigInt(identities.size)) return fail("READ_FAILED");
        const cumulativeBeforeComponentBytes = cumulativeBytes;
        cumulativeBytes += bytes * SELECTED_EVIDENCE_BYTE_FACTOR;
        hydrationObservedBytes += bytes * SELECTED_EVIDENCE_BYTE_FACTOR;
        if (cumulativeBytes > BigInt(options.maxBytes)) {
          throw new AcceptanceBytePreflightFence("EVIDENCE_BOUND_EXCEEDED", "SELECTED_EVIDENCE_BYTES", createAcceptanceReadCost({
            queryCategory, component: "SELECTED_SCALARS", limitBytes: BigInt(options.maxBytes),
            cumulativeBeforeComponentBytes, componentChargeBytes: bytes * SELECTED_EVIDENCE_BYTE_FACTOR,
            attemptedCumulativeBytes: cumulativeBytes, hydrationObservedBytes,
          }));
        }
      }
    } catch (error) {
      throwIfFenced();
      if (error instanceof AcceptanceBytePreflightFence) {
        terminalFence = error;
        throw terminalFence;
      }
      const nativeCode = error && typeof error === "object" && "code" in error ? error.code : null;
      const meta = error && typeof error === "object" && "meta" in error ? error.meta : null;
      const metaCode = meta && typeof meta === "object" && "code" in meta ? meta.code : null;
      const timeoutCode = nativeCode === "P2028" || nativeCode === "57014" ? nativeCode
        : metaCode === "57014" ? metaCode : null;
      if (timeoutCode) throw Object.assign(new Error("READ_TIMEOUT"), { code: timeoutCode });
      if (error instanceof Error && "reason" in error &&
          (error.reason === "EVIDENCE_BOUND_EXCEEDED" || error.reason === "READ_FAILED")) {
        terminalFence = new AcceptanceBytePreflightFence(error.reason);
        throw terminalFence;
      }
      terminalFence = new AcceptanceBytePreflightFence("READ_FAILED");
      throw terminalFence;
    }
  };
}
