import { AtlasIdentifierSchema } from "./contracts.ts";
import { awaitAtlasReady, type AtlasRuntime } from "./runtime.ts";
import {
  escapeAtlasLiteral,
  qualifyAtlasTable,
  quoteAtlasIdentifier,
  readAtlasCatalog,
  type AtlasCatalogColumn,
} from "./tables.ts";
import { validateScopedSelect } from "../lib/sqlSafety.ts";

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

function scope(source: AtlasSource): string {
  return `county = ${escapeAtlasLiteral(source.county)}
    AND data_group = ${escapeAtlasLiteral(source.dataGroup)}`;
}

function catalog(runtime: AtlasRuntime) {
  return readAtlasCatalog(runtime.connections.read, runtime.backend.kind);
}

function primaryKeyColumn(columns: AtlasCatalogColumn[]): string {
  const names = new Set(columns.map((column) => column.name));
  if (names.has("relationship_cid")) return "relationship_cid";
  return names.has("cid") ? "cid" : "property_cid";
}

export async function resolveAtlasSource(
  county: string,
  dataGroup: string,
): Promise<AtlasSource> {
  const normalizedGroup = AtlasIdentifierSchema.parse(dataGroup);
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

/**
 * Run a read-only SELECT over the county/data-group scope. Every content
 * table the statement names is shadowed by a same-named CTE filtered to the
 * scope, and the statement may reference nothing outside those tables.
 */
export async function runAtlasQuery(args: {
  county: string;
  dataGroup: string;
  limit: number;
  sql: string;
}): Promise<AtlasQueryResult> {
  const source = await resolveAtlasSource(args.county, args.dataGroup);
  const runtime = await awaitAtlasReady();
  const tables = await catalog(runtime);
  const validation = validateScopedSelect(
    args.sql,
    new Map(
      [...tables].map(([name, columns]) => [
        name,
        columns.map((column) => column.name),
      ]),
    ),
  );
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const scoped = validation.relations.map(
    (name) =>
      `${quoteAtlasIdentifier(name)} AS (
         SELECT * FROM ${qualifyAtlasTable(runtime.backend.kind, name)}
         WHERE ${scope(source)}
       )`,
  );
  const limit = Math.max(1, Math.min(args.limit, 1000));
  const rows = normalizedRows(
    await runtime.connections.read(
      `${scoped.length === 0 ? "" : `WITH ${scoped.join(", ")}`}
       SELECT *
       FROM (${validation.sql}) AS atlas_query
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
  const tables = await catalog(runtime);
  if (args.table === undefined) {
    const counts =
      tables.size === 0
        ? []
        : await runtime.connections.read(
            [...tables.keys()]
              .map(
                (name) =>
                  `SELECT ${escapeAtlasLiteral(name)} AS table_name, count(*) AS rows
                   FROM ${quoteAtlasIdentifier(name)}
                   WHERE ${scope(source)}`,
              )
              .join(" UNION ALL "),
          );
    return {
      tables: counts.map((row) => ({
        tableName: String(row.table_name),
        primaryKeyColumn: primaryKeyColumn(
          tables.get(String(row.table_name)) ?? [],
        ),
        rows: Number(row.rows ?? 0),
      })),
      source,
    };
  }

  const table = AtlasIdentifierSchema.parse(args.table);
  const columns = tables.get(table);
  if (columns === undefined) {
    throw new Error(`Atlas table '${table}' is not synchronized`);
  }
  return { columns, table, source };
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
  const limit = Math.max(1, Math.min(args.limit, 500));
  const offset = Math.max(0, args.offset);
  if (!(await catalog(runtime)).has("properties")) {
    return { limit, offset, properties: [], source, total: 0 };
  }
  const count = await runtime.connections.read(
    `SELECT count(*) AS count FROM properties WHERE ${scope(source)}`,
  );
  const rows = await runtime.connections.read(
    `SELECT * FROM properties
     WHERE ${scope(source)}
     ORDER BY property_cid
     LIMIT ${limit}
     OFFSET ${offset}`,
  );
  return {
    limit,
    offset,
    properties: normalizedRows(rows),
    source,
    total: Number(count[0]?.count ?? 0),
  };
}

/**
 * Assemble one property inside its scope. export-tables stores every entity
 * and relationship once per archive under the first property that referenced
 * it, so the property's own rows are only the seed: relationships are then
 * followed from_cid -> to_cid until nothing new appears or depth 8.
 */
export async function getAtlasProperty(args: {
  county: string;
  dataGroup: string;
  propertyCid: string;
}) {
  const source = await resolveAtlasSource(args.county, args.dataGroup);
  const runtime = await awaitAtlasReady();
  const tables = await catalog(runtime);
  const names = (table: string) =>
    new Set((tables.get(table) ?? []).map((column) => column.name));
  const relationshipTables = [...tables.keys()].filter(
    (table) => names(table).has("from_cid") && names(table).has("to_cid"),
  );
  const entityTables = [...tables.keys()].filter(
    (table) => names(table).has("cid") && !relationshipTables.includes(table),
  );
  const keyOf = (table: string) =>
    relationshipTables.includes(table)
      ? "relationship_cid"
      : entityTables.includes(table)
        ? "cid"
        : "property_cid";

  const records: Record<string, Array<Record<string, unknown>>> = {};
  const seen = new Set<string>();
  const entityCids = new Set<string>();
  const collect = (table: string, rows: Array<Record<string, unknown>>) => {
    const fresh = rows.filter(
      (row) => !seen.has(`${table}\u0000${String(row[keyOf(table)])}`),
    );
    for (const row of fresh) {
      seen.add(`${table}\u0000${String(row[keyOf(table)])}`);
      if (keyOf(table) === "cid") entityCids.add(String(row.cid));
    }
    if (fresh.length > 0) {
      (records[table] ??= []).push(...normalizedRows(fresh));
    }
    return fresh;
  };
  const fetch = (table: string, column: string, values: string[]) =>
    values.length === 0
      ? Promise.resolve([])
      : runtime.connections.read(
          `SELECT * FROM ${quoteAtlasIdentifier(table)}
           WHERE ${scope(source)}
             AND ${quoteAtlasIdentifier(column)} IN (${values
               .map(escapeAtlasLiteral)
               .join(", ")})`,
        );

  let pending = new Set<string>();
  for (const table of tables.keys()) {
    for (const row of collect(
      table,
      await fetch(table, "property_cid", [args.propertyCid]),
    )) {
      if (keyOf(table) === "relationship_cid") pending.add(String(row.to_cid));
    }
  }
  if (records.properties === undefined) {
    throw new Error(`CID_NOT_PUBLISHED: ${args.propertyCid}`);
  }

  for (let depth = 0; depth < 8 && pending.size > 0; depth += 1) {
    const targets = [...pending].filter((cid) => !entityCids.has(cid));
    const reached: string[] = [];
    for (const table of entityTables) {
      for (const row of collect(table, await fetch(table, "cid", targets))) {
        reached.push(String(row.cid));
      }
    }
    pending = new Set();
    for (const table of relationshipTables) {
      for (const row of collect(
        table,
        await fetch(table, "from_cid", reached),
      )) {
        pending.add(String(row.to_cid));
      }
    }
  }
  return { propertyCid: args.propertyCid, records, source };
}
