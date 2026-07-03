import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { fetchGeoIndex, type GeoIndexEntry } from "../lib/oracleGeoIndex.ts";
import {
  isCountyServedByQueryTable,
  resolveDefaultQueryTableCounty,
  runInternalPropertyQuery,
  PROPERTIES_VIEW,
} from "../lib/duckdbQuery.ts";

/**
 * Story 3 — geo/value tools.
 *
 * Area input is a user-supplied bounding box OR a polygon ring of coordinates.
 * Membership is decided purely on each property's centroid (latitude/longitude).
 * The PRIMARY source is the per-county query table (DuckDB over Parquet): a bbox
 * becomes a SQL BETWEEN filter, and a polygon pre-filters by its bounding box in
 * SQL then ray-casts the survivors. When no query table serves the county the
 * tools fall back to the derived geo index. No NOAA/FEMA geometry, no PostGIS.
 */

export interface BoundingBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface PolygonPoint {
  lat: number;
  lng: number;
}

export interface AreaArgs {
  bbox?: BoundingBox;
  polygon?: PolygonPoint[];
  /**
   * County whose query table to read (case-insensitive). Optional: when absent
   * the sole/default served county is used, else the legacy geo index answers.
   */
  county?: string;
}

/** A centroid-bearing property row, shared by both the query-table and geo-index paths. */
interface AreaParcel {
  parcelIdentifier: string;
  requestIdentifier: string;
  folio?: string;
  latitude: number;
  longitude: number;
  currentAvmValue: number | null;
  propertyType: string | null;
}

/** Inclusive point-in-bounding-box test on centroid lat/lng. */
export function isPointInBbox(
  lat: number,
  lng: number,
  bbox: BoundingBox,
): boolean {
  return (
    lat >= bbox.minLat &&
    lat <= bbox.maxLat &&
    lng >= bbox.minLng &&
    lng <= bbox.maxLng
  );
}

/**
 * Ray-casting point-in-polygon test. The polygon is an ordered ring of
 * { lat, lng } vertices (the ring is treated as implicitly closed).
 */
export function isPointInPolygon(
  lat: number,
  lng: number,
  polygon: PolygonPoint[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;

    const intersects =
      a.lng > lng !== b.lng > lng &&
      lat < ((b.lat - a.lat) * (lng - a.lng)) / (b.lng - a.lng) + a.lat;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

type AreaResolution =
  | { readonly predicate: (entry: GeoIndexEntry) => boolean }
  | { readonly error: string };

/**
 * Resolve the requested area into a centroid-membership predicate, or an
 * explicit error. A bbox takes precedence when both are supplied; a polygon
 * needs at least 3 vertices. A request with no usable area is an error — never
 * a silently empty result that masquerades as "a valid area containing
 * nothing".
 */
function resolveArea(args: AreaArgs): AreaResolution {
  if (args.bbox) {
    const bbox = args.bbox;
    if (bbox.minLat > bbox.maxLat || bbox.minLng > bbox.maxLng) {
      return {
        error:
          "Invalid area: bbox minLat must be ≤ maxLat and minLng must be ≤ maxLng",
      };
    }
    return {
      predicate: (entry) =>
        isPointInBbox(entry.latitude, entry.longitude, bbox),
    };
  }
  if (args.polygon) {
    if (args.polygon.length < 3) {
      return {
        error: "Invalid area: a polygon requires at least 3 vertices",
      };
    }
    const polygon = args.polygon;
    return {
      predicate: (entry) =>
        isPointInPolygon(entry.latitude, entry.longitude, polygon),
    };
  }
  return {
    error: "Invalid area: provide a bbox or a polygon of at least 3 vertices",
  };
}

type AreaBounds = {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLng: number;
  readonly maxLng: number;
};

type BoundsResolution =
  | { readonly bounds: AreaBounds; readonly polygon?: PolygonPoint[] }
  | { readonly error: string };

/**
 * Resolve the requested area into a lat/lng bounding box for the SQL pre-filter,
 * plus the polygon ring when a polygon was supplied (so the SQL survivors can be
 * ray-cast). Validation mirrors {@link resolveArea} exactly.
 */
function resolveAreaBounds(args: AreaArgs): BoundsResolution {
  if (args.bbox) {
    const bbox = args.bbox;
    if (bbox.minLat > bbox.maxLat || bbox.minLng > bbox.maxLng) {
      return {
        error:
          "Invalid area: bbox minLat must be ≤ maxLat and minLng must be ≤ maxLng",
      };
    }
    return {
      bounds: {
        minLat: bbox.minLat,
        maxLat: bbox.maxLat,
        minLng: bbox.minLng,
        maxLng: bbox.maxLng,
      },
    };
  }
  if (args.polygon) {
    if (args.polygon.length < 3) {
      return { error: "Invalid area: a polygon requires at least 3 vertices" };
    }
    const lats = args.polygon.map((point) => point.lat);
    const lngs = args.polygon.map((point) => point.lng);
    return {
      bounds: {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs),
      },
      polygon: args.polygon,
    };
  }
  return {
    error: "Invalid area: provide a bbox or a polygon of at least 3 vertices",
  };
}

/**
 * Fetch the centroid-bearing rows inside the area from a county's query table.
 * The bbox filter runs in SQL; a polygon additionally ray-casts the survivors so
 * membership matches the geo-index path's semantics exactly.
 */
async function fetchAreaParcelsFromQueryTable(
  county: string | undefined,
  bounds: AreaBounds,
  polygon: PolygonPoint[] | undefined,
): Promise<AreaParcel[]> {
  const rows = await runInternalPropertyQuery(
    county,
    `SELECT parcel_identifier, request_identifier, latitude, longitude,
            avm_value, property_type
     FROM ${PROPERTIES_VIEW}
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       AND latitude BETWEEN $1 AND $2
       AND longitude BETWEEN $3 AND $4`,
    [bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng],
  );

  const parcels: AreaParcel[] = rows.map((row) => ({
    parcelIdentifier:
      row.parcel_identifier == null ? "" : String(row.parcel_identifier),
    requestIdentifier:
      row.request_identifier == null ? "" : String(row.request_identifier),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    currentAvmValue: row.avm_value == null ? null : Number(row.avm_value),
    propertyType: row.property_type == null ? null : String(row.property_type),
  }));

  if (!polygon) {
    return parcels;
  }
  return parcels.filter((parcel) =>
    isPointInPolygon(parcel.latitude, parcel.longitude, polygon),
  );
}

/** Resolve the county a countyless geo request should target on the query table. */
function resolveAreaCounty(args: AreaArgs): string | undefined {
  return args.county ?? resolveDefaultQueryTableCounty() ?? undefined;
}

export async function findPropertiesInAreaHandler(args: AreaArgs) {
  const county = resolveAreaCounty(args);

  if (isCountyServedByQueryTable(county)) {
    const resolved = resolveAreaBounds(args);
    if ("error" in resolved) {
      return createTextResult({ error: resolved.error });
    }
    try {
      const parcels = await fetchAreaParcelsFromQueryTable(
        county,
        resolved.bounds,
        resolved.polygon,
      );
      return createTextResult({ count: parcels.length, parcels });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), args },
        "findPropertiesInArea failed (query table)",
      );
      return createTextResult({
        error: "Failed to find properties in area",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const area = resolveArea(args);
  if ("error" in area) {
    return createTextResult({ error: area.error });
  }

  try {
    const index = await fetchGeoIndex();
    const inArea = index.entries.filter(area.predicate);
    const parcels = inArea.map((entry) => ({
      parcelIdentifier: entry.parcelIdentifier,
      requestIdentifier: entry.requestIdentifier,
      folio: entry.folio,
      latitude: entry.latitude,
      longitude: entry.longitude,
      currentAvmValue: entry.currentAvmValue,
      propertyType: entry.propertyType,
    }));

    return createTextResult({
      count: parcels.length,
      parcels,
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        args,
      },
      "findPropertiesInArea failed",
    );
    return createTextResult({
      error: "Failed to find properties in area",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function sumPropertyValueInAreaHandler(args: AreaArgs) {
  const county = resolveAreaCounty(args);

  if (isCountyServedByQueryTable(county)) {
    const resolved = resolveAreaBounds(args);
    if ("error" in resolved) {
      return createTextResult({ error: resolved.error });
    }
    try {
      const parcels = await fetchAreaParcelsFromQueryTable(
        county,
        resolved.bounds,
        resolved.polygon,
      );
      const totalValue = parcels.reduce(
        (sum, parcel) => sum + (parcel.currentAvmValue ?? 0),
        0,
      );
      return createTextResult({
        totalValue,
        count: parcels.length,
        parcels: parcels.map((parcel) => parcel.parcelIdentifier),
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), args },
        "sumPropertyValueInArea failed (query table)",
      );
      return createTextResult({
        error: "Failed to sum property value in area",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const area = resolveArea(args);
  if ("error" in area) {
    return createTextResult({ error: area.error });
  }

  try {
    const index = await fetchGeoIndex();
    const inArea = index.entries.filter(area.predicate);
    const totalValue = inArea.reduce(
      (sum, entry) => sum + (entry.currentAvmValue ?? 0),
      0,
    );

    return createTextResult({
      totalValue,
      count: inArea.length,
      parcels: inArea.map((entry) => entry.parcelIdentifier),
    });
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        args,
      },
      "sumPropertyValueInArea failed",
    );
    return createTextResult({
      error: "Failed to sum property value in area",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
