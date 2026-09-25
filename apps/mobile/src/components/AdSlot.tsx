import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Card, colors, Muted } from './ui';

interface Ad {
  id: string;
  title: string;
  body: string | null;
  click_url: string | null;
}

/** Sponsored spare-parts placement, targeted by category. */
export function AdSlot({ categoryId }: { categoryId?: number }) {
  const { data } = useApi<{ ads: Ad[] }>(`/ads/placements?limit=1${categoryId ? `&categoryId=${categoryId}` : ''}`);
  const ad = data?.ads[0];
  if (!ad) return null;
  const open = async () => {
    const { clickUrl } = await api<{ clickUrl: string | null }>(`/ads/${ad.id}/click`, { method: 'POST' });
    if (clickUrl) await WebBrowser.openBrowserAsync(clickUrl);
  };
  return (
    <Card onPress={open} style={{ borderColor: colors.primary, borderStyle: 'dashed' }}>
      <Muted>Sponsored · Spare parts</Muted>
      <Text style={{ fontWeight: '600', color: colors.ink }}>{ad.title}</Text>
      {ad.body ? <Muted>{ad.body}</Muted> : null}
    </Card>
  );
}
