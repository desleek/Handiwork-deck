import Ionicons from '@expo/vector-icons/Ionicons';
import { LABOR_STANCE_LABEL, type LaborStance, type PerformanceMultiplier, REVIEW_CATEGORIES, REVIEW_CATEGORY_LABEL } from '@handiwork/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { RatingLine, ScoreBar } from '@/components/Stars';
import { Badge, Button, Card, Chip, colors, ErrorText, Loading, Muted, Screen, styles } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { iconFor } from '@/lib/categories';
import { formatMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Profile {
  id: string;
  full_name: string;
  company_name: string | null;
  headline: string | null;
  bio: string | null;
  avatar_url: string | null;
  years_experience: number;
  verification_status: string;
  rating_avg: number;
  rating_count: number;
  labor_stance: LaborStance;
  instant_book_enabled: boolean;
  services: { id: number; name: string; icon: string | null; base_rate_minor: number | null; currency: string | null }[];
  portfolio: { id: string; url: string | null; caption: string | null }[];
  certifications: { title: string; issuer: string | null; is_verified: boolean; expired: boolean }[];
  categoryScores: Record<string, number | null> | null;
  performance: PerformanceMultiplier;
  reviews: { id: string; overall: number; comment: string; reviewer: string; created_at: string; tags: string[]; category_name: string }[];
}

const TIER_LABEL: Record<PerformanceMultiplier['tier'], string> = {
  new: 'New technician',
  elite: 'Elite performer',
  trusted: 'Trusted performer',
  standard: 'Standard',
  under_review: 'Under review',
};

export default function TechnicianProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { data, error, loading } = useApi<{ technician: Profile }>(`/technicians/${id}`);
  const [serviceId, setServiceId] = useState<number | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorText error={error} /></Screen>;
  const t = data.technician;
  const service = t.services.find((s) => s.id === serviceId) ?? t.services[0];
  const canInstant = t.instant_book_enabled && !!service?.base_rate_minor;

  const book = (mode: 'request' | 'instant') =>
    service &&
    router.push({ pathname: '/post-job', params: { categoryId: String(service.id), name: service.name, technicianId: t.id, technicianName: t.full_name, bookingMode: mode } });

  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <Avatar url={t.avatar_url} name={t.full_name} size={76} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ fontSize: 20, fontWeight: '700', color: colors.ink }}>{t.full_name}</Text>
          {t.headline ? <Muted>{t.headline}</Muted> : null}
          <View style={styles.row}>
            <RatingLine avg={t.rating_avg} count={t.rating_count} />
            {t.verification_status === 'verified' && <Badge label="Verified" tone="good" />}
            <Muted>{t.years_experience} yrs</Muted>
          </View>
        </View>
      </View>

      {/* Performance multiplier with its reasons */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.label}>{TIER_LABEL[t.performance.tier]}</Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.primary }}>{t.performance.multiplier.toFixed(2)}×</Text>
        </View>
        {t.performance.reasons.map((r) => (
          <Muted key={r}>• {r}</Muted>
        ))}
        <Muted>The performance multiplier reflects ratings, completed jobs and reliability. Higher means ranked higher.</Muted>
      </Card>

      <Card>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Ionicons name="construct-outline" size={18} color={colors.ink} />
          <Text style={{ flex: 1, color: colors.ink }}>{LABOR_STANCE_LABEL[t.labor_stance]}</Text>
        </View>
      </Card>

      {t.bio ? <Text style={{ color: colors.ink }}>{t.bio}</Text> : null}

      {/* Services & starting prices */}
      <Text style={styles.label}>Services</Text>
      <View style={styles.row}>
        {t.services.map((s) => (
          <Chip
            key={s.id}
            label={`${s.name}${s.base_rate_minor && s.currency ? ` · from ${formatMoney(s.base_rate_minor, s.currency)}` : ''}`}
            selected={service?.id === s.id}
            onPress={() => setServiceId(s.id)}
          />
        ))}
      </View>

      {user?.role === 'customer' && service && (
        <View style={{ gap: 8 }}>
          {canInstant && <Button title={`⚡ Instant book — ${formatMoney(service.base_rate_minor, service.currency ?? 'NGN')}`} onPress={() => book('instant')} />}
          <Button title="Request a booking" variant={canInstant ? 'secondary' : 'primary'} onPress={() => book('request')} />
        </View>
      )}

      {/* Portfolio (max 5) */}
      {t.portfolio.length > 0 && (
        <>
          <Text style={styles.label}>Portfolio</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
            {t.portfolio.map((p) =>
              p.url ? (
                <View key={p.id} style={{ width: 180, gap: 4 }}>
                  <Image source={{ uri: p.url }} style={{ width: 180, height: 140, borderRadius: 10, backgroundColor: colors.line }} />
                  {p.caption ? <Muted>{p.caption}</Muted> : null}
                </View>
              ) : null,
            )}
          </ScrollView>
        </>
      )}

      {t.certifications.length > 0 && (
        <>
          <Text style={styles.label}>Certifications</Text>
          {t.certifications.map((c, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name={c.is_verified ? 'ribbon' : 'ribbon-outline'} size={18} color={c.is_verified ? colors.success : colors.muted} />
              <Text style={{ flex: 1, color: colors.ink }}>
                {c.title}
                {c.issuer ? <Text style={{ color: colors.muted }}> · {c.issuer}</Text> : null}
              </Text>
              {c.expired ? <Badge label="Expired" tone="bad" /> : c.is_verified ? <Badge label="Verified" tone="good" /> : null}
            </View>
          ))}
        </>
      )}

      {t.categoryScores && t.rating_count > 0 && (
        <Card>
          {REVIEW_CATEGORIES.map((c) => (
            <ScoreBar key={c} label={REVIEW_CATEGORY_LABEL[c]} value={t.categoryScores?.[c] ?? null} />
          ))}
        </Card>
      )}

      <Text style={styles.label}>Reviews</Text>
      {t.reviews.length === 0 && <Muted>No reviews yet.</Muted>}
      {t.reviews.map((r) => (
        <Card key={r.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '600' }}>{r.reviewer}</Text>
            <Text style={{ fontWeight: '600', color: colors.ink }}>★ {Number(r.overall).toFixed(1)}</Text>
          </View>
          <Muted>
            {r.category_name} · {new Date(r.created_at).toLocaleDateString()}
          </Muted>
          <Text style={{ color: colors.ink }}>{r.comment}</Text>
          <View style={[styles.row, { gap: 6 }]}>
            {r.tags.map((tag) => (
              <Badge key={tag} label={tag} tone={tag.endsWith('1★') || tag.endsWith('2★') ? 'bad' : 'neutral'} />
            ))}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
