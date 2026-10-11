import { Pressable, View } from 'react-native';
import type { Quote, QuoteLine } from '../api/types';
import { bpsToPct, formatMoney } from '../lib/money';
import { useTheme } from '../theme';
import { Card, Divider, PlatformIcon, Row, T, Tag } from './ui';

/**
 * Itemized quote (Sections 5 & 14): labor, base parts, markup %, markup amount and platform fees
 * are always visibly separate — never a lump sum and never hidden behind a "details" toggle.
 */
export function PriceBreakdown({
  quote,
  viewer,
  onChallenge,
  awaitingApproval,
}: {
  quote: Quote;
  viewer: 'customer' | 'technician' | 'admin';
  onChallenge?: (lineId: string) => void;
  awaitingApproval?: boolean;
}) {
  const t = useTheme();
  const labor = quote.lines.filter((l) => l.kind === 'labor');
  const parts = quote.lines.filter((l) => l.kind === 'part');
  const { totals } = quote;
  const markupBps = totals.partsBaseMinor ? Math.round((totals.markupMinor / totals.partsBaseMinor) * 10_000) : 0;
  const money = (n: number | null | undefined, strong?: boolean) => <T v={strong ? 'bodyStrong' : 'body'} style={t.font.money}>{formatMoney(n)}</T>;

  return (
    <View style={{ gap: t.space(4) }}>
      {/* Headline */}
      <Card style={{ padding: t.space(4.5), gap: t.space(1.5) }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="small" muted>{awaitingApproval ? 'Total to approve' : `Quote v${quote.version}`}</T>
          <Row gap={1}>
            {quote.laborOnly ? <Tag label="Labor only" tone="success" /> : null}
            {quote.status === 'pending_exception' ? <Tag label="Under review" tone="warning" icon="clock-outline" /> : null}
            {quote.status === 'approved' ? <Tag label="Approved" tone="success" icon="check" /> : null}
          </Row>
        </Row>
        <T v="amount">{formatMoney(totals.totalMinor)}</T>
        {quote.notes ? (
          <T style={{ color: t.color.textSoft }}>
            <T v="bodyStrong">Diagnosis: </T>
            {quote.notes}
          </T>
        ) : null}
      </Card>

      {/* Line items */}
      <View style={{ gap: t.space(2.5) }}>
        <T v="heading">What's included</T>
        <Card style={{ padding: 0, gap: 0 }}>
          {[...labor, ...parts].map((l, i) => (
            <View key={l.id}>
              {i > 0 ? <Divider inset={t.space(4)} /> : null}
              <LineRow line={l} multiplierBps={quote.performanceMultiplierBps} onChallenge={onChallenge && viewer === 'customer' && l.kind === 'part' ? () => onChallenge(l.id) : undefined} />
            </View>
          ))}
        </Card>
      </View>

      {/* How the total adds up — always open */}
      <Card>
        <T v="heading">How the total adds up</T>
        {parts.length ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}><T>Parts at supplier price</T>{money(totals.partsBaseMinor)}</Row>
            <Row style={{ justifyContent: 'space-between' }}><T>Parts handling ({bpsToPct(markupBps)})</T>{money(totals.markupMinor)}</Row>
          </>
        ) : null}
        <Row style={{ justifyContent: 'space-between' }}><T>Labor</T>{money(totals.laborMinor)}</Row>
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">Total</T>
          <T v="heading" style={t.font.money}>{formatMoney(totals.totalMinor)}</T>
        </Row>
        {viewer === 'customer' ? (
          <T v="tiny" muted>
            {parts.length ? 'The handling fee covers sourcing and transport, and Handiwork-Deck caps it. ' : ''}
            Includes {formatMoney(totals.platformFeesIncludedMinor)} Handiwork-Deck fees, paid by the technician. No fee on the supplier price of parts.
          </T>
        ) : (
          <>
            <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fee on labor</T><T v="small" muted style={t.font.money}>−{formatMoney(totals.platformFees?.laborCommissionMinor)}</T></Row>
            <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fee on handling</T><T v="small" muted style={t.font.money}>−{formatMoney(totals.platformFees?.markupCommissionMinor)}</T></Row>
            <Row style={{ justifyContent: 'space-between' }}><T v="heading">You receive</T><T v="heading" color={t.color.primary} style={t.font.money}>{formatMoney(totals.technicianNetMinor)}</T></Row>
          </>
        )}
      </Card>
    </View>
  );
}

function LineRow({ line: l, multiplierBps, onChallenge }: { line: QuoteLine; multiplierBps: number; onChallenge?: () => void }) {
  const t = useTheme();
  const isPart = l.kind === 'part';
  return (
    <Row gap={3} style={{ padding: t.space(4), alignItems: 'flex-start' }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: isPart ? t.color.accentSoft : t.color.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <PlatformIcon name={isPart ? 'package-variant-closed' : 'wrench-outline'} size={18} color={isPart ? t.color.accentInk : t.color.primary} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <T v="bodyStrong">
          {l.description}
          {l.quantity !== 1 ? ` × ${l.quantity}` : ''}
        </T>
        {isPart ? (
          <T v="small" muted style={t.font.money}>
            {formatMoney(l.baseUnitCostMinor)} each at supplier · handling {bpsToPct(l.markupBps ?? 0)} ({formatMoney(l.markupMinor)})
          </T>
        ) : multiplierBps !== 0 && l.standardRateMinor ? (
          <T v="small" muted>
            Standard {formatMoney(l.standardRateMinor)} {multiplierBps > 0 ? '+' : '−'}
            {bpsToPct(Math.abs(multiplierBps))} performance rate
          </T>
        ) : (
          <T v="small" muted>Labor</T>
        )}
        <Row gap={3} style={{ flexWrap: 'wrap' }}>
          {l.receiptUrl ? <Tag label="Receipt attached" tone="success" icon="check" /> : null}
          {/* Price challenge entry point (Section 6c) */}
          {onChallenge ? (
            <Pressable accessibilityRole="link" hitSlop={8} onPress={onChallenge} style={{ paddingVertical: 4 }}>
              <Row gap={1}>
                <PlatformIcon name="tag-outline" size={14} color={t.color.link} />
                <T v="smallStrong" color={t.color.link}>Seen it cheaper? Challenge this price</T>
              </Row>
            </Pressable>
          ) : null}
        </Row>
      </View>
      <T v="bodyStrong" style={t.font.money}>{formatMoney(l.lineTotalMinor)}</T>
    </Row>
  );
}
