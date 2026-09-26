import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { type LivePosition, pollTracking, type Tracking, watchTechnician } from '@/lib/liveLocation';
import { colors, Muted } from './ui';

/** Section 9: the booked technician's live en-route position and ETA. */
export function LiveMap({ jobId, job }: { jobId: string; job: { lat: number; lng: number } }) {
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [realtime, setRealtime] = useState<LivePosition | null>(null);
  useEffect(() => pollTracking(jobId, setTracking), [jobId]);
  useEffect(() => watchTechnician(jobId, setRealtime), [jobId]);

  if (tracking && !tracking.active) return null;
  const pos = realtime ?? tracking?.position ?? null;
  const status = !tracking
    ? 'Connecting…'
    : !tracking.technicianOnline
      ? 'Technician is offline — location sharing paused'
      : !tracking.position
        ? 'Waiting for technician location…'
        : tracking.stale
          ? `Last seen ${new Date(tracking.position.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : null;

  return (
    <View style={{ gap: 6 }}>
      {tracking?.etaMinutes != null && tracking.position && (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.primary }}>~{tracking.etaMinutes} min</Text>
          <Muted>{tracking.distanceKm} km away</Muted>
        </View>
      )}
      <View style={{ height: 220, borderRadius: 12, overflow: 'hidden' }}>
        <MapView style={{ flex: 1 }} initialRegion={{ latitude: job.lat, longitude: job.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 }}>
          <Marker coordinate={{ latitude: job.lat, longitude: job.lng }} title="Job location" />
          {pos && <Marker coordinate={{ latitude: pos.lat, longitude: pos.lng }} title="Technician" pinColor={colors.primary} />}
        </MapView>
        {status && (
          <View style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: '#fff', borderRadius: 8, padding: 6 }}>
            <Muted>{status}</Muted>
          </View>
        )}
      </View>
    </View>
  );
}
