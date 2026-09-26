import { type CounterKind, toMinor } from '@handiwork/shared';
import { router } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { COUNTER_LABEL, pct, type Quote } from '@/lib/quotes';
import { PriceChallengeForm } from './PriceChallenge';
import { RatingLine } from './Stars';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Muted, styles } from './ui';

/** Labor and Parts/Materials as separate sections; each part discloses base cost, markup % and amount. */
export function Breakdown({ quote }: { quote: Quote }) {
  const labor = quote.items.filter((i) => i.kind === 'labor');
  const parts = quote.items.filter((i) => i.kind === 'material');
  const adjustments = quote.items.filter((i) => i.kind === 'adjustment');
  const row = (left: React.ReactNode, right: string, color: string = colors.ink, key?: string) => (
    <View key={key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ flex: 1, color }}>{left}</Text>
      <Text style={{ color }}>{right}</Text>
    </View>
  );
  const exceptionFor = (itemId: string) => quote.cap_exceptions?.find((e) => e.quote_item_id === itemId);
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.muted }}>LABOR</Text>
      {labor.map((i) =>
        row(
          <>
            {i.description}
            {i.quantity !== 1 ? <Text style={{ color: colors.muted }}> × {i.quantity}</Text> : null}
          </>,
          formatMoney(i.total_minor, quote.currency),
          colors.ink,
          i.id,
        ),
      )}
      {parts.length > 0 && <Text style={{ fontSize: 12, fontWeight: '700', color: colors.muted, marginTop: 4 }}>PARTS / MATERIALS</Text>}
      {parts.map((i) => {
        const ex = exceptionFor(i.id);
        return (
          <View key={i.id} style={{ gap: 1 }}>
            {row(
              <>
                {i.description}
                {i.quantity !== 1 ? <Text style={{ color: colors.muted }}> × {i.quantity}</Text> : null}
              </>,
              formatMoney(i.base_minor, quote.currency),
            )}
            {i.markup_minor > 0 && row(<Text style={{ color: colors.muted }}>  Markup {pct(i.markup_bps)}</Text>, formatMoney(i.markup_minor, quote.currency), colors.muted)}
            {ex && ex.status !== 'approved' && (
              <Badge label={ex.status === 'pending' ? `Markup ${pct(ex.requested_markup_bps)} under review` : `Exception declined — capped at ${pct(ex.cap_bps)}`} tone={ex.status === 'pending' ? 'warn' : 'bad'} />
            )}
            {ex?.status === 'approved' && <Badge label={`Markup ${pct(ex.requested_markup_bps)} approved by HANDIWORK`} tone="good" />}
          </View>
        );
      })}
      {adjustments.map((i) => row(i.description, formatMoney(i.total_minor, quote.currency), colors.success, i.id))}
      <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 4, gap: 2 }}>
        <Muted>
          Labor {formatMoney(quote.labor_minor, quote.currency)} · Parts {formatMoney(quote.parts_base_minor, quote.currency)} · Markup {formatMoney(quote.markup_minor, quote.currency)}
        </Muted>
        <Text style={{ fontWeight: '800', textAlign: 'right' }}>{formatMoney(quote.amount_minor, quote.currency)}</Text>
      </View>
    </View>
  );
}

function CounterStatus({ quote }: { quote: Quote }) {
  const c = quote.latest_counter;
  if (!c || c.status === 'superseded' || c.status === 'withdrawn') return null;
  const tone = c.status === 'accepted' ? 'good' : c.status === 'declined' ? 'bad' : 'warn';
  return (
    <View style={{ gap: 2 }}>
      <Badge label={`${COUNTER_LABEL[c.kind]} ${formatMoney(c.proposed_total_minor, quote.currency)} — ${c.status}`} tone={tone} />
      {c.message ? <Muted>“{c.message}”</Muted> : null}
    </View>
  );
}

/** Customer's view of a quote: breakdown plus approve / counter / chat. */
export function CustomerQuoteCard({ jobId, quote, open, onChange }: { jobId: string; quote: Quote; open: boolean; onChange: () => void }) {
  const [counterKind, setCounterKind] = useState<Exclude<CounterKind, 'price_challenge'> | null>(null);
  const [challenging, setChallenging] = useState(false);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setCounterKind(null);
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const pendingCounter = quote.latest_counter?.status === 'pending' ? quote.latest_counter : null;
  const laborOnlyAllowed = quote.labor_only_policy === 'accept' && quote.materials_minor > 0;
  const hasParts = quote.items.some((i) => i.kind === 'material');

  const sendCounter = () =>
    run('counter', () =>
      api(`/jobs/${jobId}/quotes/${quote.id}/counter`, {
        body: {
          kind: counterKind,
          message: message.trim() || undefined,
          proposedLaborMinor: counterKind === 'labor_negotiation' ? toMinor(Number(amount), quote.currency) : undefined,
        },
      }),
    );
  const respond = (decision: 'accept' | 'decline') =>
    run(decision, () => api(`/jobs/${jobId}/quotes/${quote.id}/counters/${pendingCounter!.id}/respond`, { body: { decision } }));

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontWeight: '700', color: colors.ink }} onPress={() => router.push(`/technician/${quote.technician_id}`)}>
          {quote.technician_name} ›
        </Text>
        <RatingLine avg={quote.rating_avg} count={quote.rating_count} />
      </View>
      <Muted>
        Rev {quote.revision}
        {quote.eta_minutes ? ` · can start in ${quote.eta_minutes} min` : ''}
        {quote.labor_only ? ' · labor only' : ''}
      </Muted>
      {quote.message ? <Text style={{ color: colors.ink }}>{quote.message}</Text> : null}
      <Breakdown quote={quote} />
      <CounterStatus quote={quote} />
      {quote.status === 'pending_exception' && <Muted>This quote includes a markup above our cap and is being reviewed by HANDIWORK. You can approve it once the review is done.</Muted>}

      <Button title="Chat" variant="secondary" onPress={() => router.push({ pathname: '/chat/[jobId]', params: { jobId, technicianId: quote.technician_id, name: quote.technician_name } })} />

      {open && quote.status === 'pending' && !counterKind && !challenging && (
        <>
          <Button title={`Approve ${formatMoney(quote.amount_minor, quote.currency)}`} loading={busy === 'accept'} onPress={() => run('accept', () => api(`/jobs/${jobId}/quotes/${quote.id}/accept`, { method: 'POST' }))} />
          <View style={styles.row}>
            {laborOnlyAllowed && <Chip label="Labor only" onPress={() => setCounterKind('labor_only')} />}
            {quote.labor_minor > 0 && <Chip label="Negotiate labor" onPress={() => setCounterKind('labor_negotiation')} />}
            {hasParts && <Chip label="Challenge parts prices" onPress={() => setChallenging(true)} />}
          </View>
          {hasParts && quote.labor_only_policy === 'decline' && <Muted>This technician declared "no labor-only" for this service.</Muted>}
        </>
      )}

      {challenging && (
        <PriceChallengeForm
          jobId={jobId}
          quote={quote}
          onCancel={() => setChallenging(false)}
          onDone={() => {
            setChallenging(false);
            onChange();
          }}
        />
      )}

      {counterKind && (
        <View style={{ gap: 8 }}>
          <Text style={styles.label}>{COUNTER_LABEL[counterKind]}</Text>
          {counterKind === 'labor_only' && (
            <Muted>
              You'll supply the parts. New total: {formatMoney(quote.labor_minor, quote.currency)}
            </Muted>
          )}
          {counterKind === 'labor_negotiation' && (
            <>
              <Muted>For this job only — it never changes the technician's standard rate for anyone else.</Muted>
              <Field label={`Labor you'd pay (standard ${formatMoney(quote.labor_minor, quote.currency)})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
            </>
          )}
          <Field label="Message (optional)" value={message} onChangeText={setMessage} multiline />
          <Button title="Send" loading={busy === 'counter'} disabled={counterKind === 'labor_negotiation' && !(Number(amount) > 0)} onPress={sendCounter} />
          <Button title="Cancel" variant="secondary" onPress={() => setCounterKind(null)} />
        </View>
      )}

      {open && pendingCounter?.awaiting === 'customer' && (
        <View style={{ gap: 6, backgroundColor: '#EEF6FF', padding: 10, borderRadius: 8 }}>
          <Text style={{ fontWeight: '700', color: colors.ink }}>
            {quote.technician_name} proposes labor at {formatMoney(pendingCounter.proposed_labor_minor, quote.currency)} (total {formatMoney(pendingCounter.proposed_total_minor, quote.currency)})
          </Text>
          {pendingCounter.message ? <Muted>“{pendingCounter.message}”</Muted> : null}
          <Button title="Accept & book" loading={busy === 'accept'} onPress={() => respond('accept')} />
          <Button title="Decline (keep standard rate)" variant="secondary" loading={busy === 'decline'} onPress={() => respond('decline')} />
        </View>
      )}
      {open && pendingCounter?.awaiting === 'technician' && (
        <Button
          title="Withdraw my offer"
          variant="secondary"
          loading={busy === 'withdraw'}
          onPress={() => run('withdraw', () => api(`/jobs/${jobId}/quotes/${quote.id}/counters/${pendingCounter.id}/withdraw`, { method: 'POST' }))}
        />
      )}
      <ErrorText error={error} />
    </Card>
  );
}

/** Technician's view of their own quote: status, counter response, revise. */
export function TechnicianQuoteCard({ jobId, quote, onRevise, onChange }: { jobId: string; quote: Quote; onRevise: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const open = quote.latest_counter?.status === 'pending' ? quote.latest_counter : null;
  const c = open?.awaiting === 'technician' ? open : null;
  const [counterLabor, setCounterLabor] = useState('');
  const respond = async (decision: 'accept' | 'decline' | 'counter') => {
    setBusy(decision);
    setError(null);
    try {
      await api(`/jobs/${jobId}/quotes/${quote.id}/counters/${c!.id}/respond`, {
        body: { decision, proposedLaborMinor: decision === 'counter' ? toMinor(Number(counterLabor), quote.currency) : undefined },
      });
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={styles.label}>Your quote (rev {quote.revision})</Text>
        <Badge
          label={quote.status === 'pending_exception' ? 'cap exception under review' : quote.status}
          tone={quote.status === 'accepted' ? 'good' : quote.status === 'rejected' ? 'bad' : quote.status === 'pending_exception' ? 'warn' : 'neutral'}
        />
      </View>
      <Breakdown quote={quote} />
      {quote.cap_exceptions
        ?.filter((e) => e.admin_note)
        .map((e) => (
          <Muted key={e.id}>
            Admin note on “{e.line_description}”: {e.admin_note}
          </Muted>
        ))}
      {c && (
        <View style={{ gap: 6, backgroundColor: '#FEF3C7', padding: 10, borderRadius: 8 }}>
          <Text style={{ fontWeight: '700', color: '#92400E' }}>
            {c.kind === 'labor_only' ? 'Labor-only request' : 'Labor cost proposal'} — {formatMoney(c.proposed_total_minor, quote.currency)}
          </Text>
          {c.kind === 'labor_only' && (
            <Text style={{ color: '#92400E' }}>
              The customer supplies the parts; your part lines are removed. You declared "Accept" for this service, so declining counts toward your labor-only rejection cap.
            </Text>
          )}
          {c.kind === 'labor_negotiation' && c.proposed_labor_minor != null && (
            <Text style={{ color: '#92400E' }}>
              Labor {formatMoney(quote.labor_minor, quote.currency)} → {formatMoney(c.proposed_labor_minor, quote.currency)} (this job only)
            </Text>
          )}
          {c.message ? <Text style={{ color: '#92400E' }}>“{c.message}”</Text> : null}
          <Button title="Accept & get booked" loading={busy === 'accept'} onPress={() => respond('accept')} />
          {c.kind === 'labor_negotiation' && (
            <>
              <Field label={`Counter with labor (${quote.currency})`} value={counterLabor} onChangeText={setCounterLabor} keyboardType="decimal-pad" />
              <Button title="Send counter" variant="secondary" loading={busy === 'counter'} disabled={!(Number(counterLabor) > 0)} onPress={() => respond('counter')} />
            </>
          )}
          <Button title={c.kind === 'labor_negotiation' ? 'Decline — hold my standard rate' : 'Decline'} variant="secondary" loading={busy === 'decline'} onPress={() => respond('decline')} />
        </View>
      )}
      {open?.awaiting === 'customer' && <Muted>Waiting for the customer to answer your labor counter of {formatMoney(open.proposed_labor_minor, quote.currency)}.</Muted>}
      {!c && quote.latest_counter?.status === 'declined' && <Muted>You declined the customer's last counter-offer.</Muted>}
      {['pending', 'pending_exception', 'countered'].includes(quote.status) && <Button title="Revise quote" variant="secondary" onPress={onRevise} />}
      <ErrorText error={error} />
    </Card>
  );
}
