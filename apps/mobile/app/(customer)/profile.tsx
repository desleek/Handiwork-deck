import { router } from 'expo-router';
import { ProfileScreen } from '@/components/ProfileScreen';
import { Button } from '@/components/ui';

export default function CustomerProfile() {
  return (
    <ProfileScreen>
      <Button title="Wallet" variant="secondary" onPress={() => router.push('/wallet')} />
    </ProfileScreen>
  );
}
