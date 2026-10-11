import { Pressable, View } from 'react-native';
import type { Quote } from '../api/types';
import { bpsToPct, formatMoney } from '../lib/money';
import { useTheme } from '../theme';
import { Card, Divider, Row, T, Tag } from './ui';

/**
 * Itemized quote (Sections 5 & 14): labor, base parts, markup %, markup amount and platform fees
 * are always visibly separate — never a lump sum and never hidden behind a "details" toggle.
 */
export function PriceBreakdown({ quote, viewer, onChallenge }: { quote: Quote; viewer: 'customer' | 'technician' | 'admin'; onChallenge?: (lineId: string) => void }) {
  const t = useTheme();
  const labor = quote.lines.filter((l) => l.kind === 'labor');
  const parts = quote.lines.filter((l) => l.kind === 'part');
  const money = (n: number | null | undefined) => <T style={t.font.money}>{formatMoney(n)}</T>;

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="heading">Quote v{quote.version}</T>
        <Row gap={1}>
          {quote.laborOnly ? <Tag label="Labor only" tone="success" /> : null}
          {quote.status === 'pending_exception' ? <Tag label="Under review" tone="warning" /> : null}
          {quote.status === 'approved' ? <Tag label="Approved" tone="success" /> : null}
        </Row>
      </Row>

      <T v="small" muted>LABOR</T>
      {labor.map((l) => (
        <View key={l.id} style={{ gap: 2 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T style={{ flex: 1 }}>{l.description}{l.quantity !== 1 ? ` × ${l.quantity}` : ''}</T>
            {money(l.lineTotalMinor)}
          </Row>
          {quote.performanceMultiplierBps !== 0 && l.standardRateMinor ? (
            <T v="tiny" muted>
              Standard {formatMoney(l.standardRateMinor)} {quote.performanceMultiplierBps > 0 ? '+' : '−'}
              {bpsToPct(Math.abs(quote.performanceMultiplierBps))} performance rate
            </T>
          ) : null}
        </View>
      ))}

      {parts.length > 0 ? (
        <>
          <Divider />
          <T v="small" muted>PARTS & MATERIALS</T>
          {parts.map((p) => (
            <View key={p.id} style={{ gap: 4, paddingVertical: 2 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T style={{ flex: 1 }}>{p.description}{p.quantity !== 1 ? ` × ${p.quantity}` : ''}</T>
                {money(p.lineTotalMinor)}
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="small" muted>Base cost</T>
                <T v="small" muted style={t.font.money}>{formatMoney((p.baseUnitCostMinor ?? 0) * p.quantity)}</T>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="small" muted>Markup {bpsToPct(p.markupBps ?? 0)}</T>
                <T v="small" muted style={t.font.money}>{formatMoney(p.markupMinor)}</T>
              </Row>
              <Row gap={3}>
                {p.receiptUrl ? <Tag label="Receipt attached" tone="success" /> : null}
                {/* Price challenge entry point (Section 6c) */}
                {onChallenge && viewer === 'customer' ? (
                  <Pressable accessibilityRole="link" hitSlop={8} onPress={() => onChallenge(p.id)}>
                    <T v="small" style={{ color: t.color.link }}>Found it cheaper? Challenge this price</T>
                  </Pressable>
                ) : null}
              </Row>
            </View>
          ))}
        </>
      ) : null}

      <Divider />
      <Row style={{ justifyContent: 'space-between' }}><T muted>Labor</T>{money(quote.totals.laborMinor)}</Row>
      <Row style={{ justifyContent: 'space-between' }}><T muted>Parts (base cost)</T>{money(quote.totals.partsBaseMinor)}</Row>
      <Row style={{ justifyContent: 'space-between' }}><T muted>Parts markup</T>{money(quote.totals.markupMinor)}</Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="heading">Total</T>
        <T v="heading" style={t.font.money}>{formatMoney(quote.totals.totalMinor)}</T>
      </Row>
      {viewer === 'customer' ? (
        <T v="tiny" muted>
          Includes {formatMoney(quote.totals.platformFeesIncludedMinor)} Handiwork-Deck fees, paid by the technician. No fee on base part cost.
        </T>
      ) : (
        <>
          <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fee on labor</T><T v="small" muted>−{formatMoney(quote.totals.platformFees?.laborCommissionMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fee on markup</T><T v="small" muted>−{formatMoney(quote.totals.platformFees?.markupCommissionMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="heading">You receive</T><T v="heading" style={t.font.money}>{formatMoney(quote.totals.technicianNetMinor)}</T></Row>
        </>
      )}
    </Card>
  );
}
