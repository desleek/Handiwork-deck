import { Tabs } from 'expo-router';
import { PlatformIcon } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

export default function TechnicianTabs() {
  const t = useTheme();
  const icon = (name: string) => ({ color }: { color: string }) => <PlatformIcon name={name} color={color} />;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.color.primary,
        tabBarStyle: { backgroundColor: t.color.surface, borderTopColor: t.color.border },
        headerStyle: { backgroundColor: t.color.surface },
        headerTintColor: t.color.text,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Jobs', tabBarIcon: icon('clipboard-text-outline') }} />
      <Tabs.Screen name="earnings" options={{ title: 'Earnings', tabBarIcon: icon('chart-line') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: icon('storefront-outline') }} />
      <Tabs.Screen name="wallet" options={{ title: 'Wallet', tabBarIcon: icon('wallet-outline') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('account-circle-outline') }} />
    </Tabs>
  );
}
