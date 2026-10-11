import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../src/api/client';
import { Stars } from '../../src/components/StarInput';
import { Avatar, Button, Card, Empty, Footer, IconButton, Loading, Note, PlatformIcon, Row, Segmented, T, Tag, useChoiceSheet } from '../../src/components/ui';
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

type Tab = 'about' | 'work' | 'reviews';

/**
 * Full profile (Section 3): verification, rating, jobs done, labor rate with its context, services
 * with labor-only stance, portfolio (max 5), reviews with category scores, certifications.
 */
export default function TechnicianProfile() {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('about');
  const { data, isLoading } = useQuery({ queryKey: ['technician', id], queryFn: () => api(`/technicians/${id}`) });
  if (isLoading || !data) return <Loading />;

  const firstName = String(data.name).split(' ')[0];
  const services: any[] = data.categories;
  const lowest = services.length ? Math.min(...services.map((c) => c.startingPriceMinor)) : null;
  const book = (c: any) =>
    router.push({
      pathname: '/book/[technicianId]',
      params: { technicianId: data.id, categoryId: c.id, construction: c.supercategory === 'construction' ? '1' : '0', name: data.name, service: c.name, laborMinor: String(c.startingPriceMinor) },
    });
  const onBook = async () => {
    if (services.length === 1) return book(services[0]);
    const i = await sheet.open(`What do you need ${firstName} for?`, services.map((c) => `${c.name} · ${formatMoney(c.startingPriceMinor)}`));
    if (i !== null) book(services[i]);
  };
  const verifiedLabel = data.certifications.length ? 'ID & certificate verified' : 'ID verified';

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg }}>
      {sheet.element}
      <ScrollView>
        {/* Green hero: who they are and why you can trust them */}
        <SafeAreaView edges={['top']} style={{ backgroundColor: t.color.hero }}>
          <View style={{ paddingHorizontal: t.space(5), paddingTop: t.space(3), paddingBottom: t.space(6), gap: t.space(4.5) }}>
            <IconButton icon="chevron-left" label="Back" onDark onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
            <Row gap={4}>
              <Avatar name={data.name} url={data.avatarUrl} size={76} />
              <View style={{ flex: 1, gap: 4 }}>
                <T v="title" color={t.color.heroText} style={{ fontSize: 26, lineHeight: 30 }}>{data.name}</T>
                <T v="small" color={t.color.heroMuted} numberOfLines={1}>
                  {services[0]?.name ?? 'Technician'}
                  {services.length > 1 ? ` + ${services.length - 1} more` : ''}
                </T>
                <Tag label={verifiedLabel} tone="attention" icon="shield-check-outline" />
              </View>
            </Row>
            <Row gap={2}>
              <HeroStat value={data.ratingAvg ? `${Number(data.ratingAvg).toFixed(1)}★` : 'New'} label={data.ratingCount ? `${data.ratingCount} reviews` : 'no reviews yet'} />
              <HeroStat value={String(data.completedJobs ?? 0)} label="jobs done" />
              <HeroStat value={data.isOnline ? 'Online' : 'Offline'} label={data.isOnline ? 'available now' : 'books ahead'} dot={data.isOnline} />
            </Row>
          </View>
        </SafeAreaView>

        <View style={{ padding: t.space(5), gap: t.space(4) }}>
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { key: 'about', label: 'About' },
              { key: 'work', label: `Work${data.portfolio.length ? ` (${data.portfolio.length})` : ''}` },
              { key: 'reviews', label: 'Reviews' },
            ]}
          />

          {tab === 'about' ? (
            <View style={{ gap: t.space(4) }}>
              {data.bio ? <T style={{ color: t.color.textSoft }}>{data.bio}</T> : null}

              <Card>
                <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <T v="bodyStrong">Labor rate</T>
                  <T v="title" color={t.color.primary} style={t.font.money}>{services.length > 1 ? `from ${formatMoney(lowest)}` : formatMoney(lowest)}</T>
                </Row>
                <T v="small" muted>
                  Per job, agreed before you book. Parts are quoted separately after diagnosis, at supplier price plus a capped handling fee.
                </T>
                {data.rateContext ? <T v="tiny" muted>{data.rateContext.explanation}</T> : null}
              </Card>

              <View style={{ gap: t.space(2.5) }}>
                <T v="label" muted>Services</T>
                {services.map((c) => (
                  <Card key={c.id} style={{ padding: t.space(3.5), gap: t.space(1.5) }}>
                    <Row gap={3}>
                      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: t.color.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                        <MaterialCommunityIcons name={c.icon} size={22} color={t.color.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <T v="bodyStrong">{c.name}</T>
                        <T v="tiny" muted>{c.laborOnly}</T>
                      </View>
                      <T v="bodyStrong" style={t.font.money}>{formatMoney(c.startingPriceMinor)}</T>
                    </Row>
                    {services.length > 1 || c.supercategory === 'construction' ? (
                      <Button size="md" kind="secondary" title={c.supercategory === 'construction' ? 'Request a site visit' : `Book for ${c.name.toLowerCase()}`} onPress={() => book(c)} />
                    ) : null}
                  </Card>
                ))}
              </View>

              {data.certifications.length ? (
                <View style={{ gap: t.space(2) }}>
                  <T v="label" muted>Certifications</T>
                  {data.certifications.map((c: any) => (
                    <Row key={c.id} gap={2}>
                      <PlatformIcon name="check-decagram" size={18} color={t.color.primary} />
                      <T style={{ flex: 1 }}>{c.title}{c.issuer ? <T muted> · {c.issuer}</T> : null}</T>
                    </Row>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {tab === 'work' ? (
            data.portfolio.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space(2.5) }}>
                {data.portfolio.map((p: any) => (
                  <View key={p.id} style={{ width: '48.5%', gap: 4 }}>
                    <Image source={{ uri: p.url }} style={{ width: '100%', aspectRatio: 1, borderRadius: t.radius.md }} contentFit="cover" accessibilityLabel={p.caption ?? 'Portfolio photo'} />
                    {p.caption ? <T v="tiny" muted numberOfLines={2}>{p.caption}</T> : null}
                  </View>
                ))}
              </View>
            ) : (
              <Empty icon="image-outline" title="No photos yet" body={`${firstName} hasn't added photos of past work.`} />
            )
          ) : null}

          {tab === 'reviews' ? (
            <View style={{ gap: t.space(3) }}>
              {data.categoryScores?.competence ? (
                <Card>
                  {Object.entries(SCORE_LABELS).map(([k, label]) => {
                    const v = Number(data.categoryScores[k]);
                    return (
                      <Row key={k} gap={3}>
                        <T v="small" style={{ width: 110 }}>{label}</T>
                        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: t.color.surfaceAlt, overflow: 'hidden' }}>
                          <View style={{ width: `${(v / 5) * 100}%`, height: 8, borderRadius: 4, backgroundColor: t.color.primary }} />
                        </View>
                        <T v="smallStrong" style={[t.font.money, { width: 28, textAlign: 'right' }]}>{v.toFixed(1)}</T>
                      </Row>
                    );
                  })}
                </Card>
              ) : null}
              {data.reviews.length === 0 ? <Empty icon="star-outline" title="No reviews yet" body="Be the first to book and rate." /> : null}
              {data.reviews.map((r: any) => (
                <Card key={r.id}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T v="bodyStrong">{r.customer_first_name}</T>
                    <Stars value={Number(r.overall)} />
                  </Row>
                  <T v="tiny" muted>{r.category} · {new Date(r.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}</T>
                  {r.review_text ? <T style={{ color: t.color.textSoft }}>{r.review_text}</T> : null}
                  {/* Category-score tags on each review (Section 3) */}
                  <Row style={{ flexWrap: 'wrap' }} gap={1.5}>
                    {Object.entries(SCORE_LABELS).map(([k, label]) => (
                      <Tag key={k} label={`${label} ${r[k]}`} tone={r[k] >= 4 ? 'success' : r[k] <= 2 ? 'danger' : 'neutral'} />
                    ))}
                  </Row>
                </Card>
              ))}
            </View>
          ) : null}

          <Note title="Pay through the app, never in cash." text={`Your money is held until you confirm the job is done, so you're covered if anything goes wrong.`} />
        </View>
      </ScrollView>

      {services.length ? (
        <Footer>
          <Button title={services.length === 1 && services[0].supercategory === 'construction' ? 'Request a site visit' : `Book ${firstName}`} onPress={onBook} />
        </Footer>
      ) : null}
    </View>
  );
}

function HeroStat({ value, label, dot }: { value: string; label: string; dot?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.color.heroRaised, borderRadius: 14, paddingVertical: t.space(2.5), paddingHorizontal: t.space(3), gap: 2 }}>
      <Row gap={1.5}>
        {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.color.online }} /> : null}
        <T v="heading" color={t.color.heroText} style={{ fontSize: 19 }}>{value}</T>
      </Row>
      <T v="tiny" color={t.color.heroMuted} numberOfLines={1}>{label}</T>
    </View>
  );
}
