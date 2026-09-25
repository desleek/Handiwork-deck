import { type Queryable, pool, query } from '../db/pool';

export interface MatchedTechnician {
  user_id: string;
  full_name: string;
  distance_km: number;
  rating_avg: number;
}

/**
 * Verified, available technicians offering `categoryId` whose base is within
 * `radiusKm` of the job (the job's match radius, which escalation widens).
 * Haversine in SQL keeps us free of PostGIS for now; swap for a GiST index on
 * geography(Point) once volumes demand it.
 */
export async function findMatchingTechnicians(
  job: { lat: number; lng: number; category_id: number },
  radiusKm: number,
  db: Queryable = pool,
): Promise<MatchedTechnician[]> {
  return query<MatchedTechnician>(
    `SELECT * FROM (
       SELECT u.id AS user_id, u.full_name, tp.rating_avg, tp.service_radius_km,
              2 * 6371 * asin(sqrt(
                power(sin(radians(tp.base_lat - $1) / 2), 2) +
                cos(radians($1)) * cos(radians(tp.base_lat)) * power(sin(radians(tp.base_lng - $2) / 2), 2)
              )) AS distance_km
         FROM technician_profiles tp
         JOIN users u ON u.id = tp.user_id
         JOIN technician_services ts ON ts.technician_id = tp.user_id AND ts.category_id = $3
        WHERE u.is_active AND tp.is_available AND tp.verification_status = 'verified'
          AND tp.base_lat IS NOT NULL AND tp.base_lng IS NOT NULL
     ) m
     WHERE m.distance_km <= $4
     ORDER BY m.distance_km ASC, m.rating_avg DESC
     LIMIT 50`,
    [job.lat, job.lng, job.category_id, radiusKm],
    db,
  );
}
