import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { PlatformIcon } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

/** Bottom tab bar on both platforms; icons follow each platform's conventions (Section 14a). */
export default function CustomerTabs() {
  const t = useTheme();
  const icon = (name: string) => ({ color }: { color: string }) => <PlatformIcon name={name} color={color} size={Platform.OS === 'ios' ? 24 : 22} />;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.color.primary,
        tabBarStyle: { backgroundColor: t.color.surface, borderTopColor: t.color.border },
        headerStyle: { backgroundColor: t.color.surface },
        headerTintColor: t.color.text,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Discover', tabBarIcon: icon('magnify') }} />
      <Tabs.Screen name="jobs" options={{ title: 'My jobs', tabBarIcon: icon('briefcase-outline') }} />
      <Tabs.Screen name="deals" options={{ title: 'Deals', tabBarIcon: icon('tag-outline') }} />
      <Tabs.Screen name="wallet" options={{ title: 'Wallet', tabBarIcon: icon('wallet-outline') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('account-circle-outline') }} />
    </Tabs>
  );
}
