'use strict';

const EARTH_RADIUS_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bounding box that fully contains a circle, for a cheap indexed pre-filter. */
function boundingBox(lat, lng, radiusMeters) {
  const dLat = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.max(0.000001, Math.cos(toRad(lat)));
  const dLng = dLat / cos;
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** Parses "minLng,minLat,maxLng,maxLat" (the usual map bbox order). */
function parseBbox(str) {
  if (!str) return null;
  const parts = String(str).split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts;
  return { minLat, maxLat, minLng, maxLng };
}

module.exports = { distanceMeters, boundingBox, parseBbox };
