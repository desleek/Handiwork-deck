import { Tabs } from 'expo-router';
import { tabIcon, tabScreenOptions } from '@/components/tabs';

export default function CustomerTabs() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="index" options={{ title: 'Find help', tabBarIcon: tabIcon('search') }} />
      <Tabs.Screen name="jobs" options={{ title: 'My jobs', tabBarIcon: tabIcon('briefcase') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
