import { createTextResult } from "../lib/utils.ts";
import { logger } from "../logger.ts";
import { fetchGeoIndex, type GeoIndexEntry } from "../lib/oracleGeoIndex.ts";

/**
 * Story 3 — geo/value tools.
 *
 * Area input is a user-supplied bounding box OR a polygon ring of coordinates.
 * Membership is decided purely on each property's centroid (latitude/longitude)
 * carried in the derived geo index — no NOAA/FEMA geometry, no PostGIS.
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

export async function findPropertiesInAreaHandler(args: AreaArgs) {
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
