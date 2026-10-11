import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { api } from '../../src/api/client';
import { Button, Card, Empty, Row, Screen, T, Tag } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

/**
 * Marketplace / Deals (Section 12) — fully separate from booking, payment, chat and rating flows.
 * Plus the reserved Supplies section (Section 13): "Coming soon" with a waitlist.
 */
export default function Deals() {
  const t = useTheme();
  const [tab, setTab] = useState<'deals' | 'supplies'>('deals');
  const deals = useQuery({ queryKey: ['deals'], queryFn: () => api('/deals') });
  const join = useMutation({ mutationFn: () => api('/me/supplies-waitlist', { body: {} }) });

  return (
    <Screen>
      <Row>
        {(['deals', 'supplies'] as const).map((s) => (
          <Pressable key={s} onPress={() => setTab(s)} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 100, backgroundColor: tab === s ? t.color.primary : t.color.surface }}>
            <T v="small" style={{ color: tab === s ? t.color.primaryText : t.color.text }}>{s === 'deals' ? 'Deals' : 'Supplies'}</T>
          </Pressable>
        ))}
      </Row>

      {tab === 'supplies' ? (
        <Card>
          <Tag label="Coming soon" tone="warning" />
          <T v="heading">Buy parts and materials in the app</T>
          <T muted>Order from verified sellers with delivery or pickup. Join the waitlist and we'll tell you when it opens.</T>
          <Button title={join.isSuccess ? "You're on the list ✓" : 'Join the waitlist'} disabled={join.isSuccess} loading={join.isPending} onPress={() => join.mutate()} />
        </Card>
      ) : !deals.data?.enabled ? (
        <Empty title="Deals are coming" body="Offers from verified spare-parts sellers and brands will appear here." />
      ) : (
        <>
          {deals.data.ads.map((ad: any) => (
            <Pressable key={ad.id} onPress={() => ad.click_url && WebBrowser.openBrowserAsync(ad.click_url)}>
              <Card style={{ backgroundColor: t.color.sponsoredBg }}>
                <Tag label="Sponsored" />
                <Image source={{ uri: ad.image_url }} style={{ height: 140, borderRadius: t.radius.sm }} contentFit="cover" />
                <T v="heading">{ad.title}</T>
                {ad.body ? <T muted>{ad.body}</T> : null}
              </Card>
            </Pressable>
          ))}
          <T v="heading">Verified sellers</T>
          {deals.data.featuredSellers.map((s: any) => (
            <Card key={s.id}>
              <T v="heading">{s.name}</T>
              {s.address ? <T v="small" muted>{s.address}</T> : null}
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
