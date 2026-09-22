import { ATLAS_IDENTIFIER_PATTERN } from "../atlas/contracts.ts";
import { getAtlasQuerySchema, runAtlasQuery } from "../atlas/query.ts";
import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";

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

/** Quote a table or column name once it is known to exist in the scope. */
function identifier(value: string, available: readonly string[]): string {
  if (!ATLAS_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid Atlas identifier '${value}'`);
  }
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

async function areaRows(args: AreaArgs) {
  const area = bounds(args);
  const schema = await getAtlasQuerySchema({
    county: args.county,
    dataGroup: args.dataGroup,
    state: args.state,
    table: args.table,
  });
  const available = schema.columns.map((column) => column.name);
  const latitude = identifier(args.latitudeColumn, available);
  const longitude = identifier(args.longitudeColumn, available);
  const parcel = identifier(args.parcelColumn, available);
  const value = identifier(args.valueColumn, available);
  const result = await runAtlasQuery({
    county: args.county,
    dataGroup: args.dataGroup,
    state: args.state,
    limit: 1000,
    sql: `SELECT
      ${parcel} AS parcel_identifier,
      ${latitude} AS latitude,
      ${longitude} AS longitude,
      ${value} AS value
     FROM "${schema.table}"
     WHERE ${latitude} BETWEEN ${area.minLat} AND ${area.maxLat}
       AND ${longitude} BETWEEN ${area.minLng} AND ${area.maxLng}`,
  });
  const rows = result.rows.filter((row) => {
    if (area.polygon === undefined) return true;
    return insidePolygon(
      Number(row.latitude),
      Number(row.longitude),
      area.polygon,
    );
  });
  return { result, rows };
}

function errorResult(message: string, error: unknown) {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    message,
  );
  return {
    ...createTextResult({
      error: message,
      details: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}

export async function findPropertiesInAreaHandler(args: AreaArgs) {
  try {
    const { result, rows } = await areaRows(args);
    return createTextResult({
      count: rows.length,
      parcels: rows,
      source: result.source,
    });
  } catch (error) {
    return errorResult("Failed to find Atlas properties in area", error);
  }
}

export async function sumPropertyValueInAreaHandler(args: AreaArgs) {
  try {
    const { result, rows } = await areaRows(args);
    return createTextResult({
      count: rows.length,
      parcels: rows.map((row) => String(row.parcel_identifier ?? "")),
      totalValue: rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0),
      source: result.source,
    });
  } catch (error) {
    return errorResult("Failed to sum Atlas property values in area", error);
  }
}
