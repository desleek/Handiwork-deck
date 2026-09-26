import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '@/lib/api';
import type { Category } from '@/lib/categories';
import { useApi } from '@/lib/useApi';
import { Badge, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles } from './ui';

interface AdCard {
  id: string;
  title: string;
  body: string | null;
  click_url: string | null;
  label: string;
  seller_name?: string;
  seller_city?: string | null;
  advertiser_name?: string | null;
  sponsor_name?: string | null;
}
interface Seller {
  id: string;
  name: string;
  city: string | null;
  address?: string | null;
}
interface Deals {
  featuredSellers: AdCard[];
  brandCards: AdCard[];
  verifiedSellers: Seller[];
}
type Result = { sponsored: true; label: 'Sponsored'; item: AdCard } | { sponsored: false; label: null; item: Seller };

async function openAd(ad: AdCard) {
  const { clickUrl } = await api<{ clickUrl: string | null }>(`/marketplace/ads/${ad.id}/click`, { method: 'POST' });
  if (clickUrl) await WebBrowser.openBrowserAsync(clickUrl);
}

function SponsoredCard({ ad }: { ad: AdCard }) {
  return (
    <Card onPress={() => void openAd(ad)} style={{ borderColor: colors.primary, borderStyle: 'dashed' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontWeight: '600', color: colors.ink, flex: 1 }}>{ad.title}</Text>
        <Badge label={ad.label} />
      </View>
      {ad.seller_name ? (
        <Muted>
          ✓ Verified seller · {ad.seller_name}
          {ad.seller_city ? `, ${ad.seller_city}` : ''}
        </Muted>
      ) : null}
      {ad.advertiser_name || ad.sponsor_name ? <Muted>{ad.advertiser_name ?? ad.sponsor_name}</Muted> : null}
      {ad.body ? <Muted>{ad.body}</Muted> : null}
    </Card>
  );
}

function SellerRow({ seller }: { seller: Seller }) {
  return (
    <Card>
      <Text style={{ fontWeight: '600', color: colors.ink }}>{seller.name}</Text>
      <Muted>✓ Verified spare-parts seller{seller.city ? ` · ${seller.city}` : ''}</Muted>
    </Card>
  );
}

/**
 * Section 12: the Marketplace / Deals tab. The only place ads appear — never in
 * booking, payment, chat or rating screens. Everything paid is labeled.
 */
export default function DealsScreen() {
  const { data: cats } = useApi<{ categories: Category[] }>('/categories');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const deals = useApi<Deals>(`/marketplace/deals${categoryId ? `?categoryId=${categoryId}` : ''}`);
  const search = useApi<{ results: Result[] }>(q.trim().length >= 2 ? `/marketplace/search?q=${encodeURIComponent(q.trim())}${categoryId ? `&categoryId=${categoryId}` : ''}` : null);

  if (deals.loading && !deals.data) return <Loading />;
  const d = deals.data;
  return (
    <Screen>
      <ErrorText error={deals.error} />
      <Field label="Search verified parts sellers" value={q} onChangeText={setQ} placeholder="e.g. pipes, compressor, Ikeja" />
      <View style={styles.row}>
        <Chip label="All" selected={categoryId === null} onPress={() => setCategoryId(null)} />
        {cats?.categories.slice(0, 8).map((c) => (
          <Chip key={c.id} label={c.name} selected={categoryId === c.id} onPress={() => setCategoryId(c.id)} />
        ))}
      </View>

      {q.trim().length >= 2 ? (
        <>
          <Text style={styles.label}>Results</Text>
          {search.data?.results.length === 0 && <Muted>No verified sellers match.</Muted>}
          {search.data?.results.map((r) =>
            r.sponsored ? <SponsoredCard key={`s-${r.item.id}`} ad={r.item} /> : <SellerRow key={r.item.id} seller={r.item} />,
          )}
        </>
      ) : (
        <>
          {!!d?.featuredSellers.length && <Text style={styles.label}>Featured sellers</Text>}
          {d?.featuredSellers.map((a) => <SponsoredCard key={a.id} ad={a} />)}
          {!!d?.brandCards.length && <Text style={styles.label}>Deals</Text>}
          {d?.brandCards.map((a) => <SponsoredCard key={a.id} ad={a} />)}
          <Text style={styles.label}>Verified sellers</Text>
          {d?.verifiedSellers.length === 0 && <Muted>No verified sellers here yet.</Muted>}
          {d?.verifiedSellers.map((s) => <SellerRow key={s.id} seller={s} />)}
        </>
      )}
      <Muted>Sellers are verified by HANDIWORK-DECK. Featured and sponsored listings are paid placements.</Muted>
    </Screen>
  );
}
