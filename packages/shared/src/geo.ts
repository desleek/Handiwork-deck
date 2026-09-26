const EARTH_RADIUS_KM = 6371;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Section 9 ETA: straight-line distance × a road factor at the technician's
 * reported speed (or a typical urban speed when they're stopped / speed unknown).
 */
export function estimateEtaMinutes(
  from: LatLng,
  to: LatLng,
  opts: { speedMps?: number | null; defaultSpeedKmh: number; roadFactor: number },
): { distanceKm: number; etaMinutes: number } {
  const roadKm = haversineKm(from, to) * opts.roadFactor;
  const reportedKmh = (opts.speedMps ?? 0) * 3.6;
  const kmh = reportedKmh >= 5 ? reportedKmh : opts.defaultSpeedKmh;
  return { distanceKm: Math.round(roadKm * 10) / 10, etaMinutes: Math.max(1, Math.ceil((roadKm / kmh) * 60)) };
}
