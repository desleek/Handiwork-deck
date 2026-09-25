import { Tabs } from 'expo-router';
import { tabIcon, tabScreenOptions } from '@/components/tabs';

export default function AdvertiserTabs() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="index" options={{ title: 'Campaigns', tabBarIcon: tabIcon('megaphone') }} />
      <Tabs.Screen name="new" options={{ title: 'New campaign', tabBarIcon: tabIcon('add-circle') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
