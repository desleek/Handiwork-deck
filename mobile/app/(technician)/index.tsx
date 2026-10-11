import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { api } from '../../src/api/client';
import { JobsList } from '../../src/components/JobsList';
import { Banner, Card, Row, T } from '../../src/components/ui';
import { startBroadcasting, stopBroadcasting } from '../../src/lib/location';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

/** Technician home: online toggle (drives live location, Section 9) + job inbox. */
export default function TechnicianHome() {
  const t = useTheme();
  const profile = useQuery({ queryKey: ['tech-profile'], queryFn: () => api('/technician/profile') });
  const [busy, setBusy] = useState(false);
  const online = !!profile.data?.profile?.is_online;
  const verified = profile.data?.profile?.verification_status === 'verified';

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const pos = await startBroadcasting();
        if (!pos) return;
        await api('/technician/online', { body: { online: true, ...pos } });
      } else {
        await stopBroadcasting();
        await api('/technician/online', { body: { online: false } });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['tech-profile'] });
    } catch (e: any) {
      Alert.alert('Could not change status', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <JobsList
      viewer="technician"
      header={
        <View style={{ gap: t.space(3), marginBottom: t.space(3) }}>
          {!verified && profile.data ? (
            <Banner text="Finish your profile (ID, services, coverage area) on the Profile tab. You can go online once an admin verifies you." />
          ) : null}
          <Card style={{ backgroundColor: online ? t.color.primarySoft : t.color.surface }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <T v="heading">{online ? 'You are online' : 'You are offline'}</T>
                <T v="small" muted>{online ? 'Customers nearby can see you on the map.' : 'Go online to appear on the map and get instant bookings.'}</T>
              </View>
              <Switch value={online} disabled={busy || !verified} onValueChange={toggle} />
            </Row>
          </Card>
        </View>
      }
    />
  );
}
