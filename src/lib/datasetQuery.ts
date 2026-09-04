import { createHash } from "node:crypto";
import type { DuckDBValue, Json } from "@duckdb/node-api";
import { z } from "zod";
import {
  getPermitColumns,
  getPropertyColumns,
  PERMITS_VIEW,
  PROPERTIES_VIEW,
  resolvePermitQueryRuntimeLocation,
  resolvePermitTableLocation,
  resolvePropertyQueryRuntimeLocation,
  resolveQueryTableLocation,
  runInternalPermitQuery,
  runInternalPropertyQuery,
  type PropertyColumn,
} from "./duckdbQuery.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";

export const DATASET_QUERY_CONTRACT_VERSION = "dataset-query-plan-v1" as const;
export const DATASET_AGGREGATE_RESULT_VERSION =
  "dataset-aggregate-result-v1" as const;
export const DATASET_QUERY_MAX_FILTERS = 4;
export const DATASET_QUERY_MAX_PREDICATES = 3;
export const DATASET_QUERY_MAX_GROUPS = 100;
export const DATASET_QUERY_MAX_SCAN_ROWS = 1_000_000;
export const DATASET_QUERY_MAX_TIMEOUT_MS = 30_000;

const boundedIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);

export const datasetQueryDatasetSchema = z.enum(["properties", "permits"]);
export const datasetQueryFilterOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "isNull",
  "isNotNull",
]);
const datasetQueryScalarSchema = z.union([
  z.string().trim().min(1).max(120),
  z.number().finite(),
  z.boolean(),
]);

export const datasetQueryFilterSchema = z
  .object({
    field: boundedIdentifierSchema,
    operator: datasetQueryFilterOperatorSchema,
    value: datasetQueryScalarSchema.optional(),
  })
  .strict()
  .superRefine((filter, context) => {
    const nullOperator =
      filter.operator === "isNull" || filter.operator === "isNotNull";
    if (nullOperator && filter.value !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${filter.operator} does not accept a value`,
      });
    }
    if (!nullOperator && filter.value === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${filter.operator} requires a bound value`,
      });
    }
  });

const countMeasureSchema = z.object({ kind: z.literal("count") }).strict();
const averageMeasureSchema = z
  .object({
    kind: z.literal("average"),
    field: boundedIdentifierSchema,
  })
  .strict();
const shareMeasureSchema = z
  .object({
    kind: z.literal("share"),
    measuredField: boundedIdentifierSchema,
    predicate: z
      .array(datasetQueryFilterSchema)
      .min(1)
      .max(DATASET_QUERY_MAX_PREDICATES),
  })
  .strict();

export const datasetQueryMeasureSchema = z.discriminatedUnion("kind", [
  countMeasureSchema,
  averageMeasureSchema,
  shareMeasureSchema,
]);

export const datasetQueryPlanSchema = z
  .object({
    contractVersion: z.literal(DATASET_QUERY_CONTRACT_VERSION),
    dataset: datasetQueryDatasetSchema,
    county: z.string().trim().min(1).max(64),
    scopeFilters: z
      .array(datasetQueryFilterSchema)
      .max(DATASET_QUERY_MAX_FILTERS)
      .default([]),
    measure: datasetQueryMeasureSchema,
    groupBy: boundedIdentifierSchema.nullable().default(null),
    order: z
      .enum(["value_desc", "value_asc", "group_asc"])
      .default("value_desc"),
    budgets: z
      .object({
        maxRowsScanned: z
          .number()
          .int()
          .positive()
          .max(DATASET_QUERY_MAX_SCAN_ROWS),
        maxGroups: z.number().int().positive().max(DATASET_QUERY_MAX_GROUPS),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(DATASET_QUERY_MAX_TIMEOUT_MS),
      })
      .strict(),
  })
  .strict();

export type DatasetQueryDataset = z.infer<typeof datasetQueryDatasetSchema>;
export type DatasetQueryFilter = z.infer<typeof datasetQueryFilterSchema>;
export type DatasetQueryFilterOperator = z.infer<
  typeof datasetQueryFilterOperatorSchema
>;
export type DatasetQueryMeasure = z.infer<typeof datasetQueryMeasureSchema>;
export type DatasetQueryPlan = z.infer<typeof datasetQueryPlanSchema>;

type SafeFieldKind = "text" | "number" | "boolean" | "date";

interface SafeFieldPolicy {
  readonly kind: SafeFieldKind;
  readonly groupable: boolean;
  readonly measurable: boolean;
  readonly description: string;
}

const PROPERTY_FIELDS = {
  address_zip: {
    kind: "text",
    groupable: true,
    measurable: false,
    description: "ZIP/postal code; safe only as an aggregate grouping.",
  },
  lot_size_acre: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Lot size in acres.",
  },
  lot_area_sqft: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Lot area in square feet.",
  },
  exterior_wall_material: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Primary exterior wall material.",
  },
  roof_covering_material: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Primary roof covering material.",
  },
  property_type: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Structural property type classification.",
  },
  property_usage_type: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Use or zoning classification.",
  },
  built_year: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Year the primary structure was built.",
  },
  livable_floor_area: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Livable or heated floor area.",
  },
  total_area: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Total building area.",
  },
  assessed_value: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Assessed value.",
  },
  market_value: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Market value.",
  },
  land_value: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Land-only value.",
  },
  avm_value: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Automated valuation estimate.",
  },
  owner_count: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Number of recorded owners.",
  },
  owner_occupied: {
    kind: "boolean",
    groupable: true,
    measurable: true,
    description: "Recorded owner-occupancy flag.",
  },
  last_sale_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Most recent recorded sale date.",
  },
  has_permits: {
    kind: "boolean",
    groupable: true,
    measurable: true,
    description: "Whether known building permits are linked.",
  },
  permit_count: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Known permit count.",
  },
  has_sunbiz_tenant: {
    kind: "boolean",
    groupable: true,
    measurable: true,
    description: "Whether a Sunbiz tenant is linked.",
  },
  has_bbb_contractor: {
    kind: "boolean",
    groupable: true,
    measurable: true,
    description: "Whether a BBB contractor is linked.",
  },
  hoa_flag: {
    kind: "boolean",
    groupable: true,
    measurable: true,
    description: "HOA flag where supplied by the county source.",
  },
} as const satisfies Readonly<Record<string, SafeFieldPolicy>>;

const PERMIT_FIELDS = {
  improvement_type: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Permit improvement type.",
  },
  improvement_status: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Normalized permit status.",
  },
  improvement_action: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Permit action.",
  },
  permit_issue_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Permit issue date.",
  },
  application_received_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Application receipt date.",
  },
  final_inspection_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Final inspection date.",
  },
  permit_close_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Permit close date.",
  },
  completion_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Work completion date.",
  },
  expiration_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Permit expiration date.",
  },
  opened_date: {
    kind: "date",
    groupable: false,
    measurable: true,
    description: "Permit record open date.",
  },
  source_system: {
    kind: "text",
    groupable: true,
    measurable: true,
    description: "Permit source system.",
  },
  estimated_job_value: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Estimated construction value.",
  },
  fee: {
    kind: "number",
    groupable: false,
    measurable: true,
    description: "Permit fee.",
  },
} as const satisfies Readonly<Record<string, SafeFieldPolicy>>;

const POLICY_BY_DATASET: Readonly<
  Record<DatasetQueryDataset, Readonly<Record<string, SafeFieldPolicy>>>
> = {
  properties: PROPERTY_FIELDS,
  permits: PERMIT_FIELDS,
};

const OPERATORS_BY_KIND: Readonly<
  Record<SafeFieldKind, readonly DatasetQueryFilterOperator[]>
> = {
  text: ["eq", "neq", "isNull", "isNotNull"],
  boolean: ["eq", "neq", "isNull", "isNotNull"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "isNotNull"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "isNotNull"],
};

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalFilterKey(filter: DatasetQueryFilter): string {
  return canonicalJson(filter);
}

export function canonicalizeDatasetQueryPlan(input: unknown): DatasetQueryPlan {
  const parsed = datasetQueryPlanSchema.parse(input);
  const sortFilters = (
    filters: readonly DatasetQueryFilter[],
  ): DatasetQueryFilter[] =>
    [...filters].sort((left, right) =>
      canonicalFilterKey(left).localeCompare(canonicalFilterKey(right)),
    );
  return {
    ...parsed,
    county: normalizeCountyKey(parsed.county),
    scopeFilters: sortFilters(parsed.scopeFilters),
    measure:
      parsed.measure.kind === "share"
        ? {
            ...parsed.measure,
            predicate: sortFilters(parsed.measure.predicate),
          }
        : parsed.measure,
  };
}

function actualSafeFields(
  dataset: DatasetQueryDataset,
  columns: readonly PropertyColumn[],
): Readonly<Record<string, SafeFieldPolicy>> {
  const present = new Set(columns.map((column) => column.name));
  return Object.fromEntries(
    Object.entries(POLICY_BY_DATASET[dataset]).filter(([name]) =>
      present.has(name),
    ),
  );
}

function assertScalarMatchesField(
  value: string | number | boolean | undefined,
  field: SafeFieldPolicy,
): void {
  if (value === undefined) return;
  if (field.kind === "number" && typeof value !== "number") {
    throw new Error("numeric filters require a finite numeric value");
  }
  if (field.kind === "boolean" && typeof value !== "boolean") {
    throw new Error("boolean filters require a boolean value");
  }
  if (
    (field.kind === "text" || field.kind === "date") &&
    typeof value !== "string"
  ) {
    throw new Error(`${field.kind} filters require a string value`);
  }
}

function assertFilter(
  filter: DatasetQueryFilter,
  fields: Readonly<Record<string, SafeFieldPolicy>>,
): void {
  const field = fields[filter.field];
  if (field === undefined) {
    throw new Error(
      `field '${filter.field}' is unavailable or not allowlisted`,
    );
  }
  if (!OPERATORS_BY_KIND[field.kind].includes(filter.operator)) {
    throw new Error(
      `operator '${filter.operator}' is not allowed for ${field.kind} field '${filter.field}'`,
    );
  }
  assertScalarMatchesField(filter.value, field);
}

export function validateDatasetQueryPlanAgainstColumns(
  input: unknown,
  columns: readonly PropertyColumn[],
): DatasetQueryPlan {
  const plan = canonicalizeDatasetQueryPlan(input);
  const fields = actualSafeFields(plan.dataset, columns);
  for (const filter of plan.scopeFilters) assertFilter(filter, fields);

  if (plan.groupBy !== null) {
    const groupField = fields[plan.groupBy];
    if (groupField === undefined || !groupField.groupable) {
      throw new Error(
        `group field '${plan.groupBy}' is unavailable or not allowlisted`,
      );
    }
  }

  if (plan.measure.kind === "average") {
    const field = fields[plan.measure.field];
    if (field === undefined || field.kind !== "number" || !field.measurable) {
      throw new Error(
        `average field '${plan.measure.field}' is unavailable or not numeric`,
      );
    }
  }

  if (plan.measure.kind === "share") {
    const measured = fields[plan.measure.measuredField];
    if (measured === undefined || !measured.measurable) {
      throw new Error(
        `measured field '${plan.measure.measuredField}' is unavailable`,
      );
    }
    for (const filter of plan.measure.predicate) {
      assertFilter(filter, fields);
      if (
        filter.field === plan.measure.measuredField &&
        filter.operator === "isNull"
      ) {
        throw new Error(
          "a share predicate cannot count the measured field's null rows",
        );
      }
    }
  }
  return plan;
}

function compileFilter(
  filter: DatasetQueryFilter,
  parameters: DuckDBValue[],
): string {
  if (filter.operator === "isNull") return `${filter.field} IS NULL`;
  if (filter.operator === "isNotNull") return `${filter.field} IS NOT NULL`;
  const operator = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }[filter.operator];
  parameters.push(filter.value as DuckDBValue);
  return `${filter.field} ${operator} $${parameters.length}`;
}

export interface CompiledDatasetQuery {
  readonly plan: DatasetQueryPlan;
  readonly sql: string;
  readonly parameters: DuckDBValue[];
}

export function compileDatasetQueryPlan(
  input: unknown,
  columns: readonly PropertyColumn[],
): CompiledDatasetQuery {
  const plan = validateDatasetQueryPlanAgainstColumns(input, columns);
  const parameters: DuckDBValue[] = [];
  const scopeWhere =
    plan.scopeFilters.length === 0
      ? "TRUE"
      : plan.scopeFilters
          .map((filter) => compileFilter(filter, parameters))
          .join(" AND ");
  const groupExpression =
    plan.groupBy === null ? "CAST(NULL AS VARCHAR)" : plan.groupBy;
  const groupPredicate =
    plan.groupBy === null ? "TRUE" : `${plan.groupBy} IS NOT NULL`;
  const groupClause = plan.groupBy === null ? "" : ` GROUP BY ${plan.groupBy}`;

  let numerator: string;
  let denominator: string;
  let value: string;
  let median = "CAST(NULL AS DOUBLE)";
  let measuredField: string | null = null;
  if (plan.measure.kind === "count") {
    numerator = "count(*)";
    denominator = "count(*)";
    value = "CAST(count(*) AS DOUBLE)";
  } else if (plan.measure.kind === "average") {
    measuredField = plan.measure.field;
    numerator = `coalesce(sum(${plan.measure.field}), 0)`;
    denominator = `count(${plan.measure.field})`;
    value = `avg(${plan.measure.field})`;
    median = `median(${plan.measure.field})`;
  } else {
    measuredField = plan.measure.measuredField;
    const predicate = plan.measure.predicate
      .map((filter) => compileFilter(filter, parameters))
      .join(" AND ");
    numerator =
      `count(*) FILTER (WHERE ${plan.measure.measuredField} IS NOT NULL ` +
      `AND (${predicate}))`;
    denominator = `count(${plan.measure.measuredField})`;
    value = `CAST(${numerator} AS DOUBLE) / NULLIF(CAST(${denominator} AS DOUBLE), 0)`;
  }

  const orderBy =
    plan.order === "group_asc"
      ? "group_key ASC NULLS LAST"
      : plan.order === "value_asc"
        ? "value ASC NULLS LAST, group_key ASC NULLS LAST"
        : "value DESC NULLS LAST, group_key ASC NULLS LAST";
  const measuredCount =
    measuredField === null ? "count(*)" : `count(${measuredField})`;

  const sql = `WITH scoped AS (
  SELECT * FROM ${plan.dataset === "properties" ? PROPERTIES_VIEW : PERMITS_VIEW}
  WHERE ${scopeWhere}
), totals AS (
  SELECT count(*) AS total_scope_count FROM scoped
), grouped AS (
  SELECT ${groupExpression} AS group_key,
         ${numerator} AS numerator,
         ${denominator} AS denominator,
         ${value} AS value,
         ${measuredCount} AS measured_count,
         count(*) AS scope_count,
         ${median} AS median
  FROM scoped
  WHERE ${groupPredicate}${groupClause}
), cardinality AS (
  SELECT grouped.*, count(*) OVER () AS total_groups FROM grouped
)
SELECT cardinality.*, totals.total_scope_count
FROM cardinality CROSS JOIN totals
ORDER BY ${orderBy}
LIMIT ${plan.budgets.maxGroups + 1}`;

  return { plan, sql, parameters };
}

function finiteNumber(value: Json, label: string): number {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`aggregate ${label} is not a finite number`);
  }
  return parsed;
}

function nullableFiniteNumber(value: Json, label: string): number | null {
  return value === null || value === undefined
    ? null
    : finiteNumber(value, label);
}

function tableProvenance(dataset: DatasetQueryDataset, county: string) {
  const resolution =
    dataset === "properties"
      ? resolveQueryTableLocation(county)
      : resolvePermitTableLocation(county);
  if (!resolution.served || resolution.location === null) {
    throw new Error(
      `county '${county}' is not served by the ${dataset} query table`,
    );
  }
  const runtimeLocation =
    dataset === "properties"
      ? resolvePropertyQueryRuntimeLocation(
          resolution.location,
          resolution.countyKey,
        )
      : resolvePermitQueryRuntimeLocation(
          resolution.location,
          resolution.countyKey,
        );
  const locatorKind = /\/ipfs\/(?:Qm|bafy)/u.test(runtimeLocation)
    ? ("immutable_cid" as const)
    : /^https?:\/\/[^/]+\/ipns\//u.test(runtimeLocation)
      ? ("mutable_ipns" as const)
      : /^https?:\/\//u.test(runtimeLocation)
        ? ("mutable_https" as const)
        : ("local_fixture" as const);
  const identity = sha256({
    dataset,
    countyKey: resolution.countyKey,
    runtimeLocation,
  });
  return {
    dataset,
    view: dataset === "properties" ? PROPERTIES_VIEW : PERMITS_VIEW,
    countyKey: resolution.countyKey ?? normalizeCountyKey(county),
    locatorKind,
    immutable: locatorKind === "immutable_cid",
    tableIdentity: identity,
  };
}

async function columnsFor(
  dataset: DatasetQueryDataset,
  county: string,
  signal?: AbortSignal,
): Promise<PropertyColumn[]> {
  return dataset === "properties"
    ? getPropertyColumns(county, signal)
    : getPermitColumns(county);
}

async function runCompiled(
  compiled: CompiledDatasetQuery,
  signal?: AbortSignal,
): Promise<Array<Record<string, Json>>> {
  return compiled.plan.dataset === "properties"
    ? runInternalPropertyQuery(
        compiled.plan.county,
        compiled.sql,
        compiled.parameters,
        signal,
      )
    : runInternalPermitQuery(
        compiled.plan.county,
        compiled.sql,
        compiled.parameters,
        signal,
      );
}

async function preflightRowUpperBound(
  plan: DatasetQueryPlan,
  signal?: AbortSignal,
): Promise<number> {
  const view = plan.dataset === "properties" ? PROPERTIES_VIEW : PERMITS_VIEW;
  const sql = `SELECT count(*) AS row_upper_bound FROM ${view}`;
  const rows =
    plan.dataset === "properties"
      ? await runInternalPropertyQuery(plan.county, sql, [], signal)
      : await runInternalPermitQuery(plan.county, sql, [], signal);
  const first = rows[0];
  return first === undefined
    ? 0
    : finiteNumber(first.row_upper_bound, "row_upper_bound");
}

export interface DatasetAggregateRow {
  readonly group: string | number | boolean | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly measuredCount: number;
  readonly scopeCount: number;
  readonly median: number | null;
}

export type DatasetQueryRefusal =
  | "row_budget_exceeded"
  | "group_cardinality_exceeded";

export async function executeDatasetQueryPlan(
  input: unknown,
  requestSignal?: AbortSignal,
) {
  const parsed = canonicalizeDatasetQueryPlan(input);
  const timeoutSignal = AbortSignal.timeout(parsed.budgets.timeoutMs);
  const signal =
    requestSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([requestSignal, timeoutSignal]);
  const columns = await columnsFor(parsed.dataset, parsed.county, signal);
  const compiled = compileDatasetQueryPlan(parsed, columns);
  const planHash = sha256(compiled.plan);
  const provenance = tableProvenance(
    compiled.plan.dataset,
    compiled.plan.county,
  );
  const provenanceHash = sha256(provenance);
  const rowUpperBound = await preflightRowUpperBound(compiled.plan, signal);
  if (rowUpperBound > compiled.plan.budgets.maxRowsScanned) {
    const completeness = {
      semantics:
        "query was not executed because the table row upper bound exceeded the scan budget; null means unmeasured and is never treated as zero",
      totalScopeCount: 0,
      returnedGroupScopeCount: 0,
      measuredRows: 0,
      unmeasuredRows: 0,
      measurementPercent: null,
    };
    const canonicalResult = {
      planHash,
      rows: [],
      totalGroups: 0,
      truncated: false,
      completeness,
      provenanceHash,
    };
    return {
      resultVersion: DATASET_AGGREGATE_RESULT_VERSION,
      status: "refused" as const,
      refusal: "row_budget_exceeded" as const,
      plan: compiled.plan,
      planHash,
      rows: [],
      totalGroups: 0,
      truncated: false,
      completeness,
      provenance,
      provenanceHash,
      resultHash: sha256(canonicalResult),
      executedAt: new Date().toISOString(),
    };
  }
  const rawRows = await runCompiled(compiled, signal);
  const first = rawRows[0];
  const totalScopeCount =
    first === undefined
      ? 0
      : finiteNumber(first.total_scope_count, "total_scope_count");
  const totalGroups =
    first === undefined ? 0 : finiteNumber(first.total_groups, "total_groups");
  const rows: DatasetAggregateRow[] = rawRows
    .slice(0, compiled.plan.budgets.maxGroups)
    .map((row) => ({
      group:
        row.group_key === undefined || row.group_key === null
          ? null
          : typeof row.group_key === "string" ||
              typeof row.group_key === "number" ||
              typeof row.group_key === "boolean"
            ? row.group_key
            : String(row.group_key),
      numerator: finiteNumber(row.numerator, "numerator"),
      denominator: finiteNumber(row.denominator, "denominator"),
      value: nullableFiniteNumber(row.value, "value"),
      measuredCount: finiteNumber(row.measured_count, "measured_count"),
      scopeCount: finiteNumber(row.scope_count, "scope_count"),
      median: nullableFiniteNumber(row.median, "median"),
    }));
  const measuredRows = rows.reduce((sum, row) => sum + row.measuredCount, 0);
  const groupedScopeRows = rows.reduce((sum, row) => sum + row.scopeCount, 0);
  const completeness = {
    semantics:
      "denominator counts non-null measuredField rows; scopeCount includes all scoped rows; null means unmeasured and omitted-group rows are never treated as zero",
    totalScopeCount,
    returnedGroupScopeCount: groupedScopeRows,
    measuredRows,
    unmeasuredRows: Math.max(0, groupedScopeRows - measuredRows),
    measurementPercent:
      groupedScopeRows === 0 ? null : (measuredRows / groupedScopeRows) * 100,
  };
  const refusal: DatasetQueryRefusal | null =
    totalGroups > compiled.plan.budgets.maxGroups
      ? "group_cardinality_exceeded"
      : null;
  const canonicalResult = {
    planHash,
    rows,
    totalGroups,
    truncated: totalGroups > compiled.plan.budgets.maxGroups,
    completeness,
    provenanceHash,
  };
  return {
    resultVersion: DATASET_AGGREGATE_RESULT_VERSION,
    status: refusal === null ? ("ok" as const) : ("refused" as const),
    refusal,
    plan: compiled.plan,
    planHash,
    rows,
    totalGroups,
    truncated: totalGroups > compiled.plan.budgets.maxGroups,
    completeness,
    provenance,
    provenanceHash,
    resultHash: sha256(canonicalResult),
    executedAt: new Date().toISOString(),
  };
}

async function datasetCapability(
  dataset: DatasetQueryDataset,
  county: string,
  signal?: AbortSignal,
) {
  try {
    const columns = await columnsFor(dataset, county, signal);
    const fields = actualSafeFields(dataset, columns);
    const provenance = tableProvenance(dataset, county);
    return {
      dataset,
      available: true as const,
      fields: Object.entries(fields)
        .map(([name, policy]) => ({
          name,
          type: policy.kind,
          description: policy.description,
          operators: OPERATORS_BY_KIND[policy.kind],
          groupable: policy.groupable,
          measurable: policy.measurable,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      measures: ["count", "share", "average"] as const,
      provenance,
      reason: null,
    };
  } catch {
    return {
      dataset,
      available: false as const,
      fields: [],
      measures: [],
      provenance: null,
      reason: `${dataset} query table is unavailable for this county`,
    };
  }
}

export async function getDatasetQueryCapabilities(
  county: string,
  signal?: AbortSignal,
) {
  const countyKey = normalizeCountyKey(county);
  const datasets = await Promise.all(
    (["properties", "permits"] as const).map((dataset) =>
      datasetCapability(dataset, countyKey, signal),
    ),
  );
  const contract = {
    contractVersion: DATASET_QUERY_CONTRACT_VERSION,
    allowedMeasures: ["count", "share", "average"],
    conjunctionOnly: true,
    callerSqlAllowed: false,
    callerUrlsAllowed: false,
    maxScopeFilters: DATASET_QUERY_MAX_FILTERS,
    maxPredicateFilters: DATASET_QUERY_MAX_PREDICATES,
    maxGroups: DATASET_QUERY_MAX_GROUPS,
    maxRowsScanned: DATASET_QUERY_MAX_SCAN_ROWS,
    maxTimeoutMs: DATASET_QUERY_MAX_TIMEOUT_MS,
    nullSemantics:
      "null means unmeasured; share denominators count only non-null measuredField rows",
  };
  return {
    capabilityVersion: "dataset-query-capability-v1",
    county: countyKey,
    contract,
    datasets,
    capabilityHash: sha256({ county: countyKey, contract, datasets }),
  };
}

export const datasetQueryInternals = {
  PROPERTY_FIELDS,
  PERMIT_FIELDS,
  OPERATORS_BY_KIND,
  canonicalJson,
  sha256,
};
