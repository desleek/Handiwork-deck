import { router } from 'expo-router';
import { ProfileScreen } from '@/components/ProfileScreen';
import { Button } from '@/components/ui';

export default function AdminProfile() {
  return (
    <ProfileScreen>
      <Button title="Pricing & platform settings" variant="secondary" onPress={() => router.push('/admin-settings')} />
    </ProfileScreen>
  );
}
