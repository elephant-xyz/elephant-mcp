import { GroupIdentifierSchema, TableIdentifierSchema } from "./contracts.ts";
import { awaitAtlasReady } from "./runtime.ts";
import { escapeAtlasLiteral, quoteAtlasIdentifier } from "./registry.ts";
import { validateSelectQuery } from "../lib/sqlSafety.ts";

export interface AtlasSource {
  archiveCid: string;
  county: string;
  dataGroup: string;
  indexCid: string;
  schemaCid: string;
  tablesCid: string;
}

export interface AtlasQueryResult {
  limit: number;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
  source: AtlasSource;
}

function normalizedRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint" ? Number(value) : value,
      ]),
    ),
  );
}

export async function resolveAtlasSource(
  county: string,
  dataGroup: string,
): Promise<AtlasSource> {
  const normalizedGroup = GroupIdentifierSchema.parse(dataGroup);
  const runtime = await awaitAtlasReady();
  const rows = await runtime.connections.read(
    `SELECT
      state.county,
      state.data_group,
      state.archive_cid,
      state.tables_cid,
      state.schema_cid,
      sync.index_cid
     FROM atlas_state AS state
     CROSS JOIN atlas_sync_state AS sync
     WHERE state.county = ${escapeAtlasLiteral(county)}
       AND state.data_group = ${escapeAtlasLiteral(normalizedGroup)}
       AND sync.singleton_key = 1`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `Atlas county/group '${county}/${normalizedGroup}' is not published`,
    );
  }
  return {
    archiveCid: String(row.archive_cid),
    county: String(row.county),
    dataGroup: String(row.data_group),
    indexCid: String(row.index_cid),
    schemaCid: String(row.schema_cid),
    tablesCid: String(row.tables_cid),
  };
}

async function scopedRelation(
  county: string,
  dataGroup: string,
  table: string,
): Promise<{ relation: string; source: AtlasSource }> {
  const logicalName = TableIdentifierSchema.parse(table);
  const source = await resolveAtlasSource(county, dataGroup);
  if (logicalName === "properties") {
    return {
      relation: `SELECT
        property_cid,
        root_schema_cid,
        root_cid
       FROM atlas_property_roots
       WHERE county = ${escapeAtlasLiteral(source.county)}
         AND data_group = ${escapeAtlasLiteral(source.dataGroup)}`,
      source,
    };
  }

  const runtime = await awaitAtlasReady();
  const registry = await runtime.connections.read(
    `SELECT physical_table_name, primary_key_column
     FROM atlas_table_registry
     WHERE table_name = ${escapeAtlasLiteral(logicalName)}`,
  );
  const registered = registry[0];
  if (registered === undefined) {
    throw new Error(`Atlas table '${logicalName}' is not synchronized`);
  }
  const physical = String(registered.physical_table_name);
  const primaryKey = String(registered.primary_key_column);
  return {
    relation: `SELECT
      content.*,
      membership.property_cid,
      membership.parquet_data_group_cid
     FROM ${quoteAtlasIdentifier(physical)} AS content
     JOIN atlas_membership AS membership
       ON membership.table_name = ${escapeAtlasLiteral(logicalName)}
      AND membership.row_cid =
        content.${quoteAtlasIdentifier(primaryKey)}
     WHERE membership.county = ${escapeAtlasLiteral(source.county)}
       AND membership.data_group = ${escapeAtlasLiteral(source.dataGroup)}`,
    source,
  };
}

function validateScopedQuery(statement: string): string {
  const validation = validateSelectQuery(statement);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  if (/^\s*WITH\b/iu.test(validation.sql)) {
    throw new Error("CTEs are not supported by Atlas scoped queries");
  }
  if (/\bJOIN\b/iu.test(validation.sql)) {
    throw new Error("JOIN is not supported by Atlas scoped queries");
  }
  const targets = [
    ...validation.sql.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/giu),
  ].map((match) => match[1]?.toLowerCase());
  if (targets.length !== 1 || targets[0] !== "properties") {
    throw new Error(
      "Atlas SQL must read only from the logical properties relation",
    );
  }
  return validation.sql;
}

export async function runAtlasQuery(args: {
  county: string;
  dataGroup: string;
  limit: number;
  sql: string;
  table: string;
}): Promise<AtlasQueryResult> {
  const statement = validateScopedQuery(args.sql);
  const { relation, source } = await scopedRelation(
    args.county,
    args.dataGroup,
    args.table,
  );
  const limit = Math.max(1, Math.min(args.limit, 1000));
  const runtime = await awaitAtlasReady();
  const rows = normalizedRows(
    await runtime.connections.read(
      `WITH properties AS (${relation})
       SELECT *
       FROM (${statement}) AS atlas_query
       LIMIT ${limit}`,
    ),
  );
  return { limit, rowCount: rows.length, rows, source };
}

export async function getAtlasQuerySchema(args: {
  county: string;
  dataGroup: string;
  table?: string;
}) {
  const source = await resolveAtlasSource(args.county, args.dataGroup);
  const runtime = await awaitAtlasReady();
  if (args.table === undefined) {
    const tables = await runtime.connections.read(
      `SELECT
        registry.table_name,
        registry.table_kind,
        registry.primary_key_column,
        count(membership.row_cid) AS rows
       FROM atlas_table_registry AS registry
       LEFT JOIN atlas_membership AS membership
         ON membership.table_name = registry.table_name
        AND membership.county = ${escapeAtlasLiteral(source.county)}
        AND membership.data_group = ${escapeAtlasLiteral(source.dataGroup)}
       GROUP BY
         registry.table_name,
         registry.table_kind,
         registry.primary_key_column
       ORDER BY registry.table_name`,
    );
    const roots = await runtime.connections.read(
      `SELECT count(*) AS rows
       FROM atlas_property_roots
       WHERE county = ${escapeAtlasLiteral(source.county)}
         AND data_group = ${escapeAtlasLiteral(source.dataGroup)}`,
    );
    return {
      tables: [
        {
          tableName: "properties",
          tableKind: "property_roots",
          primaryKeyColumn: "property_cid",
          rows: Number(roots[0]?.rows ?? 0),
        },
        ...tables.map((row) => ({
          tableName: String(row.table_name),
          tableKind: String(row.table_kind),
          primaryKeyColumn: String(row.primary_key_column),
          rows: Number(row.rows ?? 0),
        })),
      ],
      source,
    };
  }

  const table = TableIdentifierSchema.parse(args.table);
  if (table === "properties") {
    return {
      columns: [
        { name: "property_cid", type: "text" },
        { name: "root_schema_cid", type: "text" },
        { name: "root_cid", type: "text" },
      ],
      table,
      source,
    };
  }
  const columns = await runtime.connections.read(
    `SELECT column_name, canonical_type
     FROM atlas_column_registry
     WHERE table_name = ${escapeAtlasLiteral(table)}
     ORDER BY column_name`,
  );
  if (columns.length === 0) {
    throw new Error(`Atlas table '${table}' is not synchronized`);
  }
  return {
    columns: [
      ...columns.map((row) => ({
        name: String(row.column_name),
        type: String(row.canonical_type),
      })),
      { name: "property_cid", type: "text" },
      { name: "parquet_data_group_cid", type: "text" },
    ],
    table,
    source,
  };
}

export async function listAtlasCounties() {
  const runtime = await awaitAtlasReady();
  const sync = await runtime.connections.read(
    `SELECT index_cid, generated_from, synced_at
     FROM atlas_sync_state
     WHERE singleton_key = 1`,
  );
  const groups = await runtime.connections.read(
    `SELECT
      county,
      state,
      fips,
      data_group,
      archive_cid,
      tables_cid,
      schema_cid,
      published_at,
      loaded_at
     FROM atlas_state
     ORDER BY state, county, data_group`,
  );
  const counties = new Map<
    string,
    {
      county: string;
      state: string;
      fips: string;
      groups: Record<string, unknown>;
    }
  >();
  for (const row of groups) {
    const key = `${row.state}/${row.county}`;
    const county = counties.get(key) ?? {
      county: String(row.county),
      state: String(row.state),
      fips: String(row.fips),
      groups: {},
    };
    county.groups[String(row.data_group)] = {
      archiveCid: String(row.archive_cid),
      tablesCid: String(row.tables_cid),
      schemaCid: String(row.schema_cid),
      publishedAt: String(row.published_at),
      loadedAt: String(row.loaded_at),
    };
    counties.set(key, county);
  }
  return {
    counties: [...counties.values()],
    countyCount: counties.size,
    generatedFrom: String(sync[0]?.generated_from ?? ""),
    indexCid: String(sync[0]?.index_cid ?? ""),
    syncedAt: String(sync[0]?.synced_at ?? ""),
  };
}

export async function listAtlasProperties(args: {
  county: string;
  dataGroup: string;
  limit: number;
  offset: number;
}) {
  const source = await resolveAtlasSource(args.county, args.dataGroup);
  const runtime = await awaitAtlasReady();
  const count = await runtime.connections.read(
    `SELECT count(DISTINCT property_cid) AS count
     FROM atlas_property_roots
     WHERE county = ${escapeAtlasLiteral(source.county)}
       AND data_group = ${escapeAtlasLiteral(source.dataGroup)}`,
  );
  const rows = await runtime.connections.read(
    `SELECT property_cid, root_schema_cid, root_cid
     FROM atlas_property_roots
     WHERE county = ${escapeAtlasLiteral(source.county)}
       AND data_group = ${escapeAtlasLiteral(source.dataGroup)}
     ORDER BY property_cid, root_schema_cid
     LIMIT ${Math.max(1, Math.min(args.limit, 500))}
     OFFSET ${Math.max(0, args.offset)}`,
  );
  return {
    limit: Math.max(1, Math.min(args.limit, 500)),
    offset: Math.max(0, args.offset),
    properties: normalizedRows(rows),
    source,
    total: Number(count[0]?.count ?? 0),
  };
}

export async function getAtlasProperty(args: {
  county: string;
  dataGroup: string;
  propertyCid: string;
}) {
  const source = await resolveAtlasSource(args.county, args.dataGroup);
  const runtime = await awaitAtlasReady();
  const roots = await runtime.connections.read(
    `SELECT root_schema_cid, root_cid
     FROM atlas_property_roots
     WHERE county = ${escapeAtlasLiteral(source.county)}
       AND data_group = ${escapeAtlasLiteral(source.dataGroup)}
       AND property_cid = ${escapeAtlasLiteral(args.propertyCid)}
     ORDER BY root_schema_cid`,
  );
  if (roots.length === 0) {
    throw new Error(`CID_NOT_PUBLISHED: ${args.propertyCid}`);
  }
  const memberships = await runtime.connections.read(
    `SELECT table_name, row_cid
     FROM atlas_membership
     WHERE county = ${escapeAtlasLiteral(source.county)}
       AND data_group = ${escapeAtlasLiteral(source.dataGroup)}
       AND property_cid = ${escapeAtlasLiteral(args.propertyCid)}
     ORDER BY table_name, row_cid`,
  );
  const records: Record<string, Array<Record<string, unknown>>> = {};
  for (const membership of memberships) {
    const tableName = String(membership.table_name);
    const registered = await runtime.connections.read(
      `SELECT physical_table_name, primary_key_column
       FROM atlas_table_registry
       WHERE table_name = ${escapeAtlasLiteral(tableName)}`,
    );
    const table = registered[0];
    if (table === undefined) continue;
    const row = await runtime.connections.read(
      `SELECT *
       FROM ${quoteAtlasIdentifier(String(table.physical_table_name))}
       WHERE ${quoteAtlasIdentifier(
         String(table.primary_key_column),
       )} = ${escapeAtlasLiteral(String(membership.row_cid))}`,
    );
    (records[tableName] ??= []).push(...normalizedRows(row));
  }
  return {
    propertyCid: args.propertyCid,
    records,
    roots: normalizedRows(roots),
    source,
  };
}
