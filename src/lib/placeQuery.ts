import { tmpdir } from "node:os";

import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBValue, Json } from "@duckdb/node-api";

import { logger } from "../logger.ts";
import { normalizeCountyKey } from "./countyIpnsRegistry.ts";
import { fetchPublishedCountyCatalog } from "./publishedCountyCatalog.ts";
import { MAX_ROW_LIMIT } from "./duckdbQuery.ts";
import type { ImmutablePlacesTableProvenance } from "./immutablePlacesProvenance.ts";

/** Stable DuckDB view exposed only to internally-authored places queries. */
export const PLACES_VIEW = "places";

/** Default page size for place rows and category groups. */
export const DEFAULT_PLACE_LIMIT = 100;

/** Maximum accepted offset, preventing pathological page scans. */
export const MAX_PLACE_OFFSET = 1_000_000;

const QUERY_TIMEOUT_MS = 60_000;
const MAX_CONNECTION_CACHE_SIZE = 4;
const METADATA_TIMEOUT_MS = 5_000;
const MAX_METADATA_BYTES = 512 * 1024;
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const FILEBASE_GATEWAY_HOST = "ipfs.filebase.io";
const DWEB_GATEWAY_SUFFIX = ".ipns.dweb.link";

/** Exact or substring matching for one scalar text field. */
export interface PlaceTextFilter {
  readonly value: string;
  readonly match: "exact" | "contains";
}

/** Supported structured filters over the published places parquet. */
export interface PlaceFilters {
  readonly taxonomyPrimary?: PlaceTextFilter;
  readonly taxonomyHierarchyMember?: string;
  readonly basicCategory?: PlaceTextFilter;
  readonly nameContains?: string;
  readonly normalizedNameContains?: string;
  readonly locality?: PlaceTextFilter;
  readonly postcode?: string;
  readonly operatingStatus?: string;
  readonly hostedService?: "include" | "exclude" | "only";
  readonly minConfidence?: number;
}

/** Supported deterministic row-order fields. */
export type PlaceSortField =
  | "gersId"
  | "name"
  | "taxonomyPrimary"
  | "locality"
  | "confidence";

/** Structured, caller-facing query contract. No SQL or URL is accepted. */
export interface PlaceQueryRequest {
  readonly county: string;
  readonly mode?: "rows" | "count" | "groupByPrimaryCategory";
  readonly filters?: PlaceFilters;
  readonly sortBy?: PlaceSortField;
  readonly sortDirection?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

/** Catalog-authorized places dataset and derived provenance locations. */
export interface PublishedPlacesDataset {
  readonly countyKey: string;
  readonly countyName: string;
  readonly stateCode: string;
  readonly countyFips: string;
  readonly updatedAt: string;
  readonly tableUrl: string;
  readonly indexUrl: string;
  readonly noticeUrl: string;
}

/** Sanitized publication metadata returned by the MCP. */
export interface PlacePublicationMetadata {
  readonly available: boolean;
  readonly rowCount: number | null;
  readonly overtureRelease: string | null;
  readonly published: boolean | null;
  readonly piiGate: string | null;
  readonly citation: string | null;
  readonly accessedDate: string | null;
  readonly elephantChangedDate: string | null;
  readonly themeLicence: string | null;
  readonly foursquareCopyright: string | null;
  readonly licenceGate: {
    readonly passed: boolean | null;
    readonly osmPresent: boolean | null;
    readonly unknownDatasets: readonly string[];
    readonly distinctDatasets: readonly string[];
  } | null;
  readonly error?: string;
}

/** Public source and coverage context attached to schema/query responses. */
export interface PlaceProvenance {
  readonly source: "Overture Maps Foundation Places";
  readonly catalogUpdatedAt: string;
  readonly placesTableUrl: string;
  readonly immutablePlacesTable: ImmutablePlacesTableProvenance | null;
  readonly publicationIndexUrl: string;
  readonly noticeUrl: string;
  readonly completionPercent: null;
  readonly completionNote: string;
  readonly publication: PlacePublicationMetadata;
}

/** One column returned by DuckDB DESCRIBE. */
export interface PlaceColumn {
  readonly name: string;
  readonly type: string;
}

/** Parameterized predicate generated from structured filters. */
export interface BuiltPlacePredicate {
  readonly sql: string;
  readonly params: DuckDBValue[];
}

interface PlaceConnectionEntry {
  readonly pending: Promise<DuckDBConnection>;
  tail: Promise<void>;
  lastUsedAt: number;
}

interface MetadataCacheEntry {
  readonly fetchedAt: number;
  readonly metadata: PlacePublicationMetadata;
}

const connectionCache = new Map<string, PlaceConnectionEntry>();
const metadataCache = new Map<string, MetadataCacheEntry>();

const ROW_PROJECTION = [
  "gers_id",
  "name_primary",
  "trim(regexp_replace(lower(coalesce(name_primary, '')), '[^a-z0-9]+', ' ', 'g')) AS normalized_name",
  "taxonomy_primary",
  "taxonomy_hierarchy",
  "basic_category",
  "legacy_category_primary",
  "operating_status",
  "confidence",
  "longitude",
  "latitude",
  "address_freeform",
  "address_locality",
  "address_postcode",
  "address_region",
  "address_country",
  "brand_name",
  "brand_wikidata",
  "is_hosted_service",
  "hosted_service_rule",
  "overture_release",
] as const;

const SORT_EXPRESSIONS: Readonly<Record<PlaceSortField, string>> = {
  gersId: "gers_id",
  name: "name_primary",
  taxonomyPrimary: "taxonomy_primary",
  locality: "address_locality",
  confidence: "confidence",
};

/**
 * Return whether a parsed URL points to an explicitly trusted public IPFS
 * gateway. Loopback HTTP is accepted only under the Vitest `test` environment.
 *
 * @param url - Parsed candidate places-table URL.
 * @returns True when the scheme and host are approved.
 */
function isTrustedPlacesGateway(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (
    process.env.NODE_ENV === "test" &&
    url.protocol === "http:" &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  ) {
    return true;
  }
  return (
    url.protocol === "https:" &&
    (hostname === FILEBASE_GATEWAY_HOST ||
      hostname.endsWith(DWEB_GATEWAY_SUFFIX))
  );
}

/**
 * Validate a catalog-supplied places-table URL before DuckDB can reach it.
 *
 * The caller never supplies this URL; it comes from the canonical published
 * county catalog. Validation remains strict so a compromised or mistaken
 * catalog cannot turn the MCP into an SSRF/file-reader primitive.
 *
 * @param raw - Catalog `placesTableUrl`.
 * @returns Canonical URL approved for a read-only parquet query.
 * @throws {Error} When the URL is not a trusted HTTPS places parquet.
 */
export function validatePublishedPlacesUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Published placesTableUrl is not an absolute URL.");
  }

  const lowerRaw = raw.toLowerCase();
  const isTestLoopback =
    process.env.NODE_ENV === "test" &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("Published placesTableUrl contains invalid path encoding.");
  }
  const pathSegments = decodedPath.split("/");
  if (
    !isTrustedPlacesGateway(url) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && !isTestLoopback) ||
    url.search !== "" ||
    url.hash !== "" ||
    /%2e|%2f|%5c/i.test(lowerRaw) ||
    /(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(raw) ||
    decodedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decodedPath) ||
    pathSegments.includes("..") ||
    !url.pathname.endsWith("/places-table.parquet")
  ) {
    throw new Error(
      "Published placesTableUrl must be a trusted HTTPS IPFS gateway URL ending in /places-table.parquet, without credentials, a custom port, query, fragment, or path traversal.",
    );
  }
  return url;
}

/**
 * Resolve one county's places dataset exclusively through the trusted catalog.
 *
 * @param county - Caller-supplied county key/name.
 * @returns Catalog identity plus validated table and provenance URLs.
 * @throws {Error} For invalid, unpublished, or places-unavailable counties.
 */
export async function resolvePublishedPlacesDataset(
  county: string,
): Promise<PublishedPlacesDataset> {
  const countyKey = normalizeCountyKey(county);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countyKey)) {
    throw new Error(
      `County '${county}' is invalid. Use a published lowercase county key such as 'lee'.`,
    );
  }

  const catalog = await fetchPublishedCountyCatalog();
  const published = catalog.counties.find(
    (candidate) => candidate.countyKey === countyKey,
  );
  if (published === undefined) {
    throw new Error(
      `County '${countyKey}' is not in the published Oracle county catalog.`,
    );
  }
  if (published.placesTableUrl === null) {
    throw new Error(
      `County '${countyKey}' has no published Overture places table (placesTableUrl is null).`,
    );
  }

  const tableUrl = validatePublishedPlacesUrl(published.placesTableUrl);
  return {
    countyKey,
    countyName: published.countyName,
    stateCode: published.stateCode,
    countyFips: published.countyFips,
    updatedAt: published.updatedAt,
    tableUrl: tableUrl.toString(),
    indexUrl: new URL("index.json", tableUrl).toString(),
    noticeUrl: new URL("../NOTICE.txt", tableUrl).toString(),
  };
}

/**
 * Add one parameter and return its DuckDB positional placeholder.
 *
 * @param params - Mutable parameter list owned by one predicate build.
 * @param value - Scalar value to bind.
 * @returns `$N` placeholder matching the appended value.
 */
function bind(params: DuckDBValue[], value: DuckDBValue): string {
  params.push(value);
  return `$${params.length}`;
}

/**
 * Normalize free text the same way the derived `normalized_name` expression
 * does in DuckDB.
 *
 * @param value - Caller search text.
 * @returns Lowercase alphanumeric words separated by one space.
 */
function normalizeNameSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Build an exact/contains predicate with a bound value.
 *
 * @param column - Hard-coded, trusted SQL column identifier.
 * @param filter - Structured text filter.
 * @param params - Query parameter list.
 * @returns One SQL predicate.
 */
function buildTextPredicate(
  column: string,
  filter: PlaceTextFilter,
  params: DuckDBValue[],
): string {
  const placeholder = bind(params, filter.value.trim());
  return filter.match === "exact"
    ? `lower(${column}) = lower(${placeholder})`
    : `${column} ILIKE '%' || ${placeholder} || '%'`;
}

/**
 * Convert the structured places filters into parameterized SQL.
 *
 * County is always enforced inside the parquet as defense in depth, even
 * though the table URL already comes from that county's catalog row.
 *
 * @param countyKey - Validated canonical county key.
 * @param filters - Optional caller filters.
 * @returns SQL predicate and positional parameters.
 */
export function buildPlacePredicate(
  countyKey: string,
  filters: PlaceFilters = {},
): BuiltPlacePredicate {
  const params: DuckDBValue[] = [];
  const predicates = [`county_key = ${bind(params, countyKey)}`];

  if (filters.taxonomyPrimary !== undefined) {
    predicates.push(
      buildTextPredicate("taxonomy_primary", filters.taxonomyPrimary, params),
    );
  }
  if (filters.taxonomyHierarchyMember !== undefined) {
    const placeholder = bind(params, filters.taxonomyHierarchyMember.trim());
    predicates.push(
      `list_contains(string_split(lower(coalesce(taxonomy_hierarchy, '')), '/'), lower(${placeholder}))`,
    );
  }
  if (filters.basicCategory !== undefined) {
    predicates.push(
      buildTextPredicate("basic_category", filters.basicCategory, params),
    );
  }
  if (filters.nameContains !== undefined) {
    const placeholder = bind(params, filters.nameContains.trim());
    predicates.push(`name_primary ILIKE '%' || ${placeholder} || '%'`);
  }
  if (filters.normalizedNameContains !== undefined) {
    const normalized = normalizeNameSearch(filters.normalizedNameContains);
    const placeholder = bind(params, normalized);
    predicates.push(
      `trim(regexp_replace(lower(coalesce(name_primary, '')), '[^a-z0-9]+', ' ', 'g')) LIKE '%' || ${placeholder} || '%'`,
    );
  }
  if (filters.locality !== undefined) {
    predicates.push(
      buildTextPredicate("address_locality", filters.locality, params),
    );
  }
  if (filters.postcode !== undefined) {
    const placeholder = bind(params, filters.postcode.trim());
    predicates.push(`address_postcode = ${placeholder}`);
  }
  if (filters.operatingStatus !== undefined) {
    const placeholder = bind(params, filters.operatingStatus.trim());
    predicates.push(`lower(operating_status) = lower(${placeholder})`);
  }
  if (filters.hostedService === "exclude") {
    predicates.push("is_hosted_service IS DISTINCT FROM TRUE");
  } else if (filters.hostedService === "only") {
    predicates.push("is_hosted_service IS TRUE");
  }
  if (filters.minConfidence !== undefined) {
    const placeholder = bind(params, filters.minConfidence);
    predicates.push(`confidence >= ${placeholder}`);
  }

  return {
    sql: predicates.join(" AND "),
    params,
  };
}

/**
 * Convert a DuckDB JSON count scalar into a safe JavaScript number.
 *
 * @param value - DuckDB scalar.
 * @returns Finite non-negative count.
 */
function toCount(value: Json | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Execute one DuckDB operation with an interrupt-based deadline.
 *
 * Connections are serialized per county, so an interrupt can affect only the
 * timed operation currently using that connection.
 *
 * @template Result - Operation result type.
 * @param connection - Exclusive county connection.
 * @param operation - DuckDB operation to run.
 * @returns Operation result.
 * @throws {Error} With a clear timeout message after the deadline.
 */
export async function runWithTimeout<Result>(
  connection: DuckDBConnection,
  operation: () => Promise<Result>,
  timeoutMs = QUERY_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<Result> {
  let timedOut = false;
  let aborted = abortSignal?.aborted === true;
  const interrupt = () => {
    try {
      connection.interrupt();
    } catch {
      // The operation's own rejection remains authoritative.
    }
  };
  const handleAbort = () => {
    aborted = true;
    interrupt();
  };
  if (aborted) {
    throw new Error("Places query was aborted before execution.");
  }
  abortSignal?.addEventListener("abort", handleAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    interrupt();
  }, timeoutMs);
  try {
    const result = await operation();
    if (aborted) {
      throw new Error("Places query was aborted during execution.");
    }
    return result;
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Places query exceeded the ${timeoutMs / 1000}-second timeout.`,
      );
    }
    if (aborted) {
      throw new Error("Places query was aborted during execution.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", handleAbort);
  }
}

/**
 * Open one in-memory DuckDB view over the validated public parquet.
 *
 * @param dataset - Catalog-authorized places dataset.
 * @returns Connected DuckDB instance with the stable `places` view.
 */
async function openPlaceConnection(
  dataset: PublishedPlacesDataset,
  options: {
    readonly timeoutMs?: number;
  } = {},
): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const homeDir = process.env.DUCKDB_HOME_DIRECTORY ?? tmpdir();
    await runWithTimeout(
      connection,
      () =>
        connection.run(`SET home_directory='${homeDir.replace(/'/g, "''")}'`),
      options.timeoutMs,
    );
    await runWithTimeout(
      connection,
      () => connection.run("INSTALL httpfs"),
      options.timeoutMs,
    );
    await runWithTimeout(
      connection,
      () => connection.run("LOAD httpfs"),
      options.timeoutMs,
    );
    await runWithTimeout(
      connection,
      () => connection.run("SET memory_limit='256MB'"),
      options.timeoutMs,
    );
    await runWithTimeout(
      connection,
      () => connection.run("SET threads=2"),
      options.timeoutMs,
    );

    const escaped = dataset.tableUrl.replace(/'/g, "''");
    await runWithTimeout(
      connection,
      () =>
        connection.run(
          `CREATE VIEW ${PLACES_VIEW} AS SELECT * FROM read_parquet('${escaped}')`,
        ),
      options.timeoutMs,
    );
    logger.info(
      { county: dataset.countyKey, location: dataset.tableUrl },
      "Opened catalog-authorized places query view",
    );
    return connection;
  } catch (error) {
    connection.closeSync();
    throw error;
  }
}

/**
 * Close the least-recently-used cached connection after its queued work ends.
 *
 * @returns Nothing.
 */
function evictOldestConnection(): void {
  if (connectionCache.size < MAX_CONNECTION_CACHE_SIZE) return;
  const oldest = [...connectionCache.entries()].sort(
    ([, left], [, right]) => left.lastUsedAt - right.lastUsedAt,
  )[0];
  if (oldest === undefined) return;
  const [cacheKey, entry] = oldest;
  connectionCache.delete(cacheKey);
  void entry.tail
    .then(async () => {
      const connection = await entry.pending;
      connection.closeSync();
    })
    .catch((error: unknown) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to close evicted places query connection",
      );
    });
}

/**
 * Return or create the bounded cached connection for one exact catalog URL.
 *
 * @param dataset - Catalog-authorized places dataset.
 * @returns Cached connection entry.
 */
function getConnectionEntry(
  dataset: PublishedPlacesDataset,
  options: {
    readonly timeoutMs?: number;
  } = {},
): PlaceConnectionEntry {
  const cacheKey = `${dataset.countyKey}::${dataset.tableUrl}`;
  const existing = connectionCache.get(cacheKey);
  if (existing !== undefined) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  evictOldestConnection();
  // Connection setup is shared by every queued request for this exact
  // county/release URL. A single caller's cancellation must not reject that
  // shared promise and fail unrelated callers waiting on the same entry.
  const pending = openPlaceConnection(dataset, options);
  const entry: PlaceConnectionEntry = {
    pending,
    tail: Promise.resolve(),
    lastUsedAt: Date.now(),
  };
  connectionCache.set(cacheKey, entry);
  pending.catch(() => {
    if (connectionCache.get(cacheKey) === entry) {
      connectionCache.delete(cacheKey);
    }
  });
  return entry;
}

/**
 * Serialize work on a cached county connection.
 *
 * @template Result - Operation result type.
 * @param dataset - Catalog-authorized dataset.
 * @param operation - Exclusive operation.
 * @returns Operation result.
 */
export async function withPlaceConnection<Result>(
  dataset: PublishedPlacesDataset,
  operation: (connection: DuckDBConnection) => Promise<Result>,
  options: {
    readonly connectionTimeoutMs?: number;
    readonly abortSignal?: AbortSignal;
  } = {},
): Promise<Result> {
  const entry = getConnectionEntry(dataset, {
    timeoutMs: options.connectionTimeoutMs,
  });
  const predecessor = entry.tail;
  let release: (() => void) | undefined;
  entry.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    if (options.abortSignal?.aborted === true) {
      throw new Error("Places query was aborted before execution.");
    }
    const connection = await entry.pending;
    if (options.abortSignal?.aborted === true) {
      throw new Error("Places query was aborted before execution.");
    }
    entry.lastUsedAt = Date.now();
    return await operation(connection);
  } finally {
    release?.();
  }
}

/**
 * Run a parameterized, internally-authored places query.
 *
 * @param connection - Exclusive county connection.
 * @param sql - Trusted SQL with positional parameters.
 * @param params - Bound scalar values.
 * @returns JSON-safe DuckDB rows.
 */
export async function readPlaceRows(
  connection: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  options: {
    readonly timeoutMs?: number;
    readonly abortSignal?: AbortSignal;
  } = {},
): Promise<Array<Record<string, Json>>> {
  const reader = await runWithTimeout(
    connection,
    () => connection.runAndReadAll(sql, params),
    options.timeoutMs,
    options.abortSignal,
  );
  return reader.getRowObjectsJson();
}

/**
 * Fetch and sanitize the small sibling publication index.
 *
 * Query availability never depends on this optional metadata fetch. A timeout
 * or malformed index is represented explicitly while the catalog/index/notice
 * URLs remain available to the caller.
 *
 * @param dataset - Catalog-authorized places dataset.
 * @returns Sanitized publication metadata.
 */
async function fetchPublicationMetadata(
  dataset: PublishedPlacesDataset,
): Promise<PlacePublicationMetadata> {
  const cached = metadataCache.get(dataset.indexUrl);
  if (
    cached !== undefined &&
    Date.now() - cached.fetchedAt < METADATA_CACHE_TTL_MS
  ) {
    return cached.metadata;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  let metadata: PlacePublicationMetadata;
  try {
    const response = await fetch(dataset.indexUrl, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`publication index returned HTTP ${response.status}`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("publication index exceeds the metadata size limit");
    }
    metadata = sanitizePublicationMetadata(JSON.parse(body) as unknown);
  } catch (error) {
    metadata = {
      available: false,
      rowCount: null,
      overtureRelease: null,
      published: null,
      piiGate: null,
      citation: null,
      accessedDate: null,
      elephantChangedDate: null,
      themeLicence: null,
      foursquareCopyright: null,
      licenceGate: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
  metadataCache.set(dataset.indexUrl, {
    fetchedAt: Date.now(),
    metadata,
  });
  return metadata;
}

/**
 * Test whether an unknown JSON value is a plain record.
 *
 * @param value - Unknown parsed JSON.
 * @returns True for non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return a string property or null.
 *
 * @param record - Parsed JSON object.
 * @param key - Property key.
 * @returns String value or null.
 */
function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

/**
 * Return a boolean property or null.
 *
 * @param record - Parsed JSON object.
 * @param key - Property key.
 * @returns Boolean value or null.
 */
function booleanField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | null {
  return typeof record[key] === "boolean" ? record[key] : null;
}

/**
 * Return a finite non-negative integer property or null.
 *
 * @param record - Parsed JSON object.
 * @param key - Property key.
 * @returns Valid integer or null.
 */
function countField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Return only string members from a JSON array.
 *
 * @param value - Unknown parsed value.
 * @returns String-only array.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Sanitize the publication index to the provenance fields useful to agents.
 *
 * @param raw - Parsed publication index JSON.
 * @returns Bounded, typed metadata.
 */
export function sanitizePublicationMetadata(
  raw: unknown,
): PlacePublicationMetadata {
  if (!isRecord(raw)) {
    throw new Error("publication index is not a JSON object");
  }
  const attribution = isRecord(raw.attribution) ? raw.attribution : {};
  const rawGate = isRecord(attribution.licenceGate)
    ? attribution.licenceGate
    : null;
  const licenceGate =
    rawGate === null
      ? null
      : {
          passed: booleanField(rawGate, "passed"),
          osmPresent: booleanField(rawGate, "osmPresent"),
          unknownDatasets: stringArray(rawGate.unknownDatasets),
          distinctDatasets: stringArray(rawGate.distinctDatasets),
        };

  return {
    available: true,
    rowCount: countField(raw, "rowCount"),
    overtureRelease:
      stringField(raw, "overtureRelease") ??
      stringField(attribution, "overtureRelease"),
    published: booleanField(raw, "published"),
    piiGate: stringField(raw, "piiGate"),
    citation: stringField(attribution, "citation"),
    accessedDate: stringField(attribution, "accessedDate"),
    elephantChangedDate: stringField(attribution, "elephantChangedDate"),
    themeLicence: stringField(attribution, "themeLicence"),
    foursquareCopyright: stringField(attribution, "foursquareCopyright"),
    licenceGate,
  };
}

/**
 * Build public source context for a schema/query response.
 *
 * @param dataset - Catalog-authorized places dataset.
 * @returns Source URLs, release/licence metadata, and honest null completeness.
 */
export async function getPlaceProvenance(
  dataset: PublishedPlacesDataset,
  immutablePlacesTable: ImmutablePlacesTableProvenance | null = null,
): Promise<PlaceProvenance> {
  return {
    source: "Overture Maps Foundation Places",
    catalogUpdatedAt: dataset.updatedAt,
    placesTableUrl: dataset.tableUrl,
    immutablePlacesTable,
    publicationIndexUrl: dataset.indexUrl,
    noticeUrl: dataset.noticeUrl,
    completionPercent: null,
    completionNote:
      "No authoritative denominator exists for all business locations; expected_count is null, so completionPercent must remain null.",
    publication: await fetchPublicationMetadata(dataset),
  };
}

/**
 * Describe the real published places parquet for one county.
 *
 * @param county - Published county key.
 * @returns Dataset identity, DuckDB columns, and publication provenance.
 */
export async function describePlacesDataset(county: string): Promise<{
  readonly dataset: PublishedPlacesDataset;
  readonly columns: PlaceColumn[];
  readonly provenance: PlaceProvenance;
}> {
  const dataset = await resolvePublishedPlacesDataset(county);
  const [columns, provenance] = await Promise.all([
    withPlaceConnection(dataset, async (connection) => {
      const rows = await readPlaceRows(
        connection,
        `DESCRIBE ${PLACES_VIEW}`,
        [],
      );
      return rows.map((row) => ({
        name: String(row.column_name ?? ""),
        type: String(row.column_type ?? ""),
      }));
    }),
    getPlaceProvenance(dataset),
  ]);
  return { dataset, columns, provenance };
}

/**
 * Execute a structured, read-only places query.
 *
 * All SQL is authored here. Caller values are bound parameters, identifiers
 * come from fixed allowlists, results are capped, and the table URL is resolved
 * only from the canonical published-county catalog.
 *
 * @param request - Structured filters, mode, pagination, and deterministic sort.
 * @returns Count, page, or grouped primary-category response.
 */
export async function runPlacesQuery(
  request: PlaceQueryRequest,
): Promise<Record<string, unknown>> {
  const dataset = await resolvePublishedPlacesDataset(request.county);
  const mode = request.mode ?? "rows";
  const filters = request.filters ?? {};
  const limit = Math.max(
    1,
    Math.min(request.limit ?? DEFAULT_PLACE_LIMIT, MAX_ROW_LIMIT),
  );
  const offset = Math.max(0, Math.min(request.offset ?? 0, MAX_PLACE_OFFSET));
  const predicate = buildPlacePredicate(dataset.countyKey, filters);
  const provenancePromise = getPlaceProvenance(dataset);

  const result = await withPlaceConnection(
    dataset,
    async (connection): Promise<Record<string, unknown>> => {
      const summaryRows = await readPlaceRows(
        connection,
        `SELECT
           count(*) AS total_count,
           count(DISTINCT taxonomy_primary)
             + CASE WHEN count(*) FILTER (WHERE taxonomy_primary IS NULL) > 0
                    THEN 1 ELSE 0 END AS total_groups
         FROM ${PLACES_VIEW}
         WHERE ${predicate.sql}`,
        [...predicate.params],
      );
      const summary = summaryRows[0] ?? {};
      const totalCount = toCount(summary.total_count);
      const totalGroups = toCount(summary.total_groups);

      if (mode === "count") {
        return {
          county: dataset.countyKey,
          mode,
          totalCount,
          filters,
        };
      }

      const pageParams: DuckDBValue[] = [...predicate.params, limit, offset];
      const limitPlaceholder = `$${predicate.params.length + 1}`;
      const offsetPlaceholder = `$${predicate.params.length + 2}`;

      if (mode === "groupByPrimaryCategory") {
        const groups = await readPlaceRows(
          connection,
          `SELECT
             taxonomy_primary,
             count(*) AS place_count
           FROM ${PLACES_VIEW}
           WHERE ${predicate.sql}
           GROUP BY taxonomy_primary
           ORDER BY place_count DESC, taxonomy_primary ASC NULLS LAST
           LIMIT ${limitPlaceholder}
           OFFSET ${offsetPlaceholder}`,
          pageParams,
        );
        return {
          county: dataset.countyKey,
          mode,
          totalCount,
          totalGroups,
          offset,
          limit,
          groupCount: groups.length,
          filters,
          groups: groups.map((group) => ({
            taxonomyPrimary:
              group.taxonomy_primary === null ||
              group.taxonomy_primary === undefined
                ? null
                : String(group.taxonomy_primary),
            placeCount: toCount(group.place_count),
          })),
        };
      }

      const sortBy = request.sortBy ?? "gersId";
      const sortDirection = request.sortDirection ?? "asc";
      const sortExpression = SORT_EXPRESSIONS[sortBy];
      const direction = sortDirection === "desc" ? "DESC" : "ASC";
      const rows = await readPlaceRows(
        connection,
        `SELECT ${ROW_PROJECTION.join(", ")}
         FROM ${PLACES_VIEW}
         WHERE ${predicate.sql}
         ORDER BY ${sortExpression} ${direction} NULLS LAST, gers_id ASC
         LIMIT ${limitPlaceholder}
         OFFSET ${offsetPlaceholder}`,
        pageParams,
      );
      return {
        county: dataset.countyKey,
        mode,
        totalCount,
        offset,
        limit,
        rowCount: rows.length,
        sort: { by: sortBy, direction: sortDirection },
        filters,
        rows,
      };
    },
  );

  return {
    ...result,
    provenance: await provenancePromise,
  };
}

/**
 * Close all places DuckDB connections and clear metadata caches.
 *
 * Intended for tests and controlled shutdown; no cached rows or parquet files
 * are persisted by this module.
 *
 * @returns Promise resolving after queued work and connection closure.
 */
export async function clearPlaceQueryCaches(): Promise<void> {
  const entries = [...connectionCache.values()];
  connectionCache.clear();
  metadataCache.clear();
  await Promise.all(
    entries.map(async (entry) => {
      await entry.tail;
      try {
        const connection = await entry.pending;
        connection.closeSync();
      } catch {
        // A failed open has no live connection to close.
      }
    }),
  );
}
