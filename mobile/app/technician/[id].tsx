import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { api } from '../../src/api/client';
import { Stars } from '../../src/components/StarInput';
import { Banner, Button, Card, Divider, Loading, Row, Screen, T, Tag } from '../../src/components/ui';
import { formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

const SCORE_LABELS: Record<string, string> = {
  competence: 'Competence',
  punctuality: 'Punctuality',
  professionalism: 'Professionalism',
  courtesy: 'Courtesy',
  delivery_timeline: 'Timeline',
  pricing_fairness: 'Fair pricing',
  quality_of_work: 'Quality',
};

/** Full profile (Section 3): portfolio (max 5), reviews with category scores, certifications, labor-only stance, rate context. */
export default function TechnicianProfile() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useQuery({ queryKey: ['technician', id], queryFn: () => api(`/technicians/${id}`) });
  if (isLoading || !data) return <Loading />;

  return (
    <Screen>
      <Row gap={3}>
        {data.avatarUrl ? <Image source={{ uri: data.avatarUrl }} style={{ width: 64, height: 64, borderRadius: 32 }} /> : null}
        <View style={{ flex: 1, gap: 2 }}>
          <T v="title">{data.name}</T>
          <Row>
            <Stars value={data.ratingAvg} count={data.ratingCount} />
            {data.isOnline ? <Tag label="Online now" tone="success" /> : null}
          </Row>
        </View>
      </Row>
      {data.bio ? <T>{data.bio}</T> : null}
      {data.rateContext ? <Banner tone="info" text={data.rateContext.explanation} /> : null}

      {data.portfolio.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space(2) }}>
          {data.portfolio.map((p: any) => (
            <Image key={p.id} source={{ uri: p.url }} style={{ width: 200, height: 150, borderRadius: t.radius.md }} contentFit="cover" />
          ))}
        </ScrollView>
      ) : null}

      <Card>
        <T v="heading">Services</T>
        {data.categories.map((c: any) => (
          <View key={c.id} style={{ gap: 4, paddingVertical: 4 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={2} style={{ flex: 1 }}>
                <MaterialCommunityIcons name={c.icon} size={20} color={t.color.primary} />
                <T style={{ flex: 1 }}>{c.name}</T>
              </Row>
              <T style={t.font.money}>from {formatMoney(c.startingPriceMinor)}</T>
            </Row>
            <T v="tiny" muted>{c.laborOnly}</T>
            <Button title={`Book ${c.name}`} kind="secondary" onPress={() => router.push({ pathname: '/book/[technicianId]', params: { technicianId: data.id, categoryId: c.id } })} />
          </View>
        ))}
      </Card>

      {data.certifications.length ? (
        <Card>
          <T v="heading">Certifications</T>
          {data.certifications.map((c: any) => <T key={c.id}>✓ {c.title}{c.issuer ? ` — ${c.issuer}` : ''}</T>)}
        </Card>
      ) : null}

      {data.categoryScores?.competence ? (
        <Card>
          <T v="heading">Scores</T>
          {Object.entries(SCORE_LABELS).map(([k, label]) => (
            <Row key={k} style={{ justifyContent: 'space-between' }}>
              <T muted>{label}</T>
              <T>{Number(data.categoryScores[k]).toFixed(1)}</T>
            </Row>
          ))}
        </Card>
      ) : null}

      <T v="heading">Reviews</T>
      {data.reviews.length === 0 ? <T muted>No reviews yet.</T> : null}
      {data.reviews.map((r: any) => (
        <Card key={r.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="small">{r.customer_first_name} · {r.category}</T>
            <Stars value={Number(r.overall)} />
          </Row>
          <T>{r.review_text}</T>
          <Divider />
          {/* Category-score tags on each review (Section 3) */}
          <Row style={{ flexWrap: 'wrap' }} gap={1}>
            {Object.entries(SCORE_LABELS).map(([k, label]) => (
              <Tag key={k} label={`${label} ${r[k]}`} tone={r[k] >= 4 ? 'success' : r[k] <= 2 ? 'danger' : 'neutral'} />
            ))}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
