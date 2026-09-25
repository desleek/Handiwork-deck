import { useEffect, useState } from 'react';
import { View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { type LivePosition, watchTechnician } from '@/lib/liveLocation';
import { Muted } from './ui';

/** Shows the job location and, while en route, the technician's live position. */
export function LiveMap({ jobId, job }: { jobId: string; job: { lat: number; lng: number } }) {
  const [tech, setTech] = useState<LivePosition | null>(null);
  useEffect(() => watchTechnician(jobId, setTech), [jobId]);

  return (
    <View style={{ height: 220, borderRadius: 12, overflow: 'hidden' }}>
      <MapView
        style={{ flex: 1 }}
        initialRegion={{ latitude: job.lat, longitude: job.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 }}
      >
        <Marker coordinate={{ latitude: job.lat, longitude: job.lng }} title="Job location" />
        {tech && <Marker coordinate={{ latitude: tech.lat, longitude: tech.lng }} title="Technician" pinColor="#E8591A" />}
      </MapView>
      {!tech && (
        <View style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: '#fff', borderRadius: 8, padding: 6 }}>
          <Muted>Waiting for technician location…</Muted>
        </View>
      )}
    </View>
  );
}
