import { Tabs } from 'expo-router';
import { tabIcon, tabScreenOptions } from '@/components/tabs';
import { useMarketplaceEnabled } from '@/lib/marketplace';

export default function CustomerTabs() {
  const deals = useMarketplaceEnabled();
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="index" options={{ title: 'Find help', tabBarIcon: tabIcon('search') }} />
      <Tabs.Screen name="jobs" options={{ title: 'My jobs', tabBarIcon: tabIcon('briefcase') }} />
      {/* Section 12: Marketplace / Deals — a separate tab, hidden when the module is off. */}
      <Tabs.Screen name="deals" options={{ title: 'Deals', tabBarIcon: tabIcon('pricetag'), href: deals ? undefined : null }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person') }} />
    </Tabs>
  );
}
