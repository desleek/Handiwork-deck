import { Tabs } from 'expo-router';
import { tabIcon, tabScreenOptions } from '@/components/tabs';

export default function AdminTabs() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="index" options={{ title: 'Operations', tabBarIcon: tabIcon('pulse') }} />
      <Tabs.Screen name="verify" options={{ title: 'Verify', tabBarIcon: tabIcon('shield-checkmark') }} />
      <Tabs.Screen name="ads" options={{ title: 'Ads', tabBarIcon: tabIcon('megaphone') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
