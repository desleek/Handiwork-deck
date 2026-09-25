import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { JobCard, type JobSummary } from '@/components/JobCard';
import { Card, colors, ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { isOnline, setOnline } from '@/lib/presence';
import { useApi } from '@/lib/useApi';

export default function TechnicianFeed() {
  const { data, error, loading } = useApi<{ jobs: (JobSummary & { is_request_to_me?: boolean })[] }>('/jobs?feed=nearby');
  const [online, setOnlineState] = useState(isOnline());
  const [presenceError, setPresenceError] = useState<unknown>(null);
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '700', color: online ? colors.success : colors.ink }}>{online ? "You're online" : "You're offline"}</Text>
            <Muted>Online technicians appear live on customers' map.</Muted>
          </View>
          <Switch
            value={online}
            onValueChange={async (v) => {
              setPresenceError(null);
              try {
                await setOnline(v);
                setOnlineState(v);
              } catch (e) {
                setPresenceError(e);
              }
            }}
          />
        </View>
        <ErrorText error={presenceError} />
      </Card>
      <ErrorText error={error} />
      {data?.jobs.length === 0 && (
        <Muted>No open jobs near you right now. Make sure you're verified, available, and have set your services and base location in Profile.</Muted>
      )}
      {data?.jobs.map((j) => (
        <JobCard key={j.id} job={j} highlight={j.is_request_to_me ? 'Booking request for you' : undefined} onPress={() => router.push(`/job/${j.id}`)} />
      ))}
    </Screen>
  );
}
