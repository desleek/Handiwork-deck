import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { useAuth } from '@/lib/auth';
import { Button, Card, colors, Muted, Screen } from './ui';

export function ProfileScreen({ children }: { children?: ReactNode }) {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.ink }}>{user.full_name}</Text>
        {user.company_name ? <Muted>{user.company_name}</Muted> : null}
        <Muted>
          {user.role}
          {user.customer_type ? ` · ${user.customer_type}` : ''}
        </Muted>
        {user.phone_e164 ? <Muted>WhatsApp: {user.phone_e164}</Muted> : null}
        {user.email ? <Muted>{user.email}</Muted> : null}
      </Card>
      {children}
      <Button
        title="Sign out"
        variant="secondary"
        onPress={async () => {
          await signOut();
          router.replace('/sign-in');
        }}
      />
    </Screen>
  );
}
