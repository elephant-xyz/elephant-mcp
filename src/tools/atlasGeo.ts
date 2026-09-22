import { getAtlasQuerySchema, runAtlasQuery } from "../atlas/query.ts";
import { createTextResult, toolError } from "../lib/utils.ts";

interface Point {
  lat: number;
  lng: number;
}

interface AreaArgs {
  bbox?: {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
  };
  polygon?: Point[];
  county: string;
  dataGroup: string;
  state: string;
  table: string;
  latitudeColumn: string;
  longitudeColumn: string;
  parcelColumn: string;
  valueColumn: string;
}

/** Quote a column name once it is known to exist in the scoped table. */
function identifier(value: string, available: readonly string[]): string {
  if (!available.includes(value)) {
    throw new Error(
      `Column '${value}' does not exist; available columns: ${available.join(", ")}`,
    );
  }
  return `"${value}"`;
}

function bounds(args: AreaArgs) {
  if (args.bbox !== undefined && args.polygon !== undefined) {
    throw new Error("Provide exactly one of bbox or polygon");
  }
  if (args.bbox !== undefined) {
    if (
      args.bbox.minLat > args.bbox.maxLat ||
      args.bbox.minLng > args.bbox.maxLng
    ) {
      throw new Error("Invalid bounding box");
    }
    return { ...args.bbox, polygon: undefined };
  }
  if (args.polygon === undefined || args.polygon.length < 3) {
    throw new Error("Provide a bbox or polygon with at least three points");
  }
  const latitudes = args.polygon.map((point) => point.lat);
  const longitudes = args.polygon.map((point) => point.lng);
  return {
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLng: Math.min(...longitudes),
    maxLng: Math.max(...longitudes),
    polygon: args.polygon,
  };
}

function insidePolygon(lat: number, lng: number, polygon: Point[]): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const left = polygon[current];
    const right = polygon[previous];
    if (left === undefined || right === undefined) continue;
    if (
      left.lng > lng !== right.lng > lng &&
      lat <
        ((right.lat - left.lat) * (lng - left.lng)) / (right.lng - left.lng) +
          left.lat
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Rows returned per call; runAtlasQuery enforces the same ceiling. */
const ROW_CAP = 1000;

/**
 * Count and sum inside the bounding box in SQL. A polygon is applied in JS
 * to at most ROW_CAP bounding-box candidates, so its count and sum are
 * exact only when `truncated` is false.
 */
async function area(args: AreaArgs, withRows: boolean) {
  const shape = bounds(args);
  const schema = await getAtlasQuerySchema({
    county: args.county,
    dataGroup: args.dataGroup,
    state: args.state,
    table: args.table,
  });
  const available = (schema.columns ?? []).map((column) => column.name);
  const latitude = identifier(args.latitudeColumn, available);
  const longitude = identifier(args.longitudeColumn, available);
  const parcel = identifier(args.parcelColumn, available);
  const value = identifier(args.valueColumn, available);
  const where = `FROM "${schema.table}"
     WHERE ${latitude} BETWEEN ${shape.minLat} AND ${shape.maxLat}
       AND ${longitude} BETWEEN ${shape.minLng} AND ${shape.maxLng}`;
  const query = (sql: string) =>
    runAtlasQuery({
      county: args.county,
      dataGroup: args.dataGroup,
      state: args.state,
      limit: ROW_CAP,
      sql,
    });

  const totals = await query(
    `SELECT count(*) AS count, sum(${value}) AS total ${where}`,
  );
  const inBox = Number(totals.rows[0]?.count ?? 0);
  const truncated = inBox > ROW_CAP;
  if (!withRows && shape.polygon === undefined) {
    return {
      count: inBox,
      rows: [],
      source: totals.source,
      totalValue: Number(totals.rows[0]?.total ?? 0),
      truncated: false,
    };
  }

  const candidates = await query(
    `SELECT
      ${parcel} AS parcel_identifier,
      ${latitude} AS latitude,
      ${longitude} AS longitude,
      ${value} AS value
     ${where}`,
  );
  const rows =
    shape.polygon === undefined
      ? candidates.rows
      : candidates.rows.filter((row) =>
          insidePolygon(
            Number(row.latitude),
            Number(row.longitude),
            shape.polygon,
          ),
        );
  return {
    count: shape.polygon === undefined ? inBox : rows.length,
    rows,
    source: totals.source,
    totalValue: rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0),
    truncated,
  };
}

export async function findPropertiesInAreaHandler(args: AreaArgs) {
  try {
    const { count, rows, source, truncated } = await area(args, true);
    return createTextResult({
      count,
      parcels: rows,
      rowCap: ROW_CAP,
      source,
      truncated,
    });
  } catch (error) {
    return toolError("Failed to find Atlas properties in area", error);
  }
}

export async function sumPropertyValueInAreaHandler(args: AreaArgs) {
  try {
    const { count, source, totalValue, truncated } = await area(args, false);
    return createTextResult({
      count,
      rowCap: ROW_CAP,
      source,
      totalValue,
      truncated,
    });
  } catch (error) {
    return toolError("Failed to sum Atlas property values in area", error);
  }
}
