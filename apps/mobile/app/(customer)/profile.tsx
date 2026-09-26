import { router } from 'expo-router';
import { CustomerTrust, type Trust } from '@/components/CustomerTrust';
import { ProfileScreen } from '@/components/ProfileScreen';
import { Button, Card, Muted } from '@/components/ui';
import { useApi } from '@/lib/useApi';

export default function CustomerProfile() {
  const { data } = useApi<{ user: { trust?: Trust } }>('/me');
  return (
    <ProfileScreen>
      {data?.user.trust && (
        <Card>
          <CustomerTrust trust={data.user.trust} />
          {!data.user.trust.completionBadge && <Muted>Complete jobs and pay through HANDIWORK to earn the completion badge technicians look for.</Muted>}
        </Card>
      )}
      <Button title="Wallet" variant="secondary" onPress={() => router.push('/wallet')} />
    </ProfileScreen>
  );
}
