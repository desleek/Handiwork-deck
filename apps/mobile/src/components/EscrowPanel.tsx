import { type JobStatus, toMinor } from '@handiwork/shared';
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { PaymentPicker } from './PaymentPicker';
import { Badge, Button, Card, ErrorText, Field, Muted, styles } from './ui';

interface Escrow {
  status: 'unfunded' | 'held' | 'captured' | 'refunded';
  hold: {
    held_minor: number;
    captured_minor: number | null;
    labor_minor: number | null;
    parts_base_minor: number | null;
    markup_minor: number | null;
    commission_minor: number | null;
    technician_payout_minor: number | null;
    refunded_minor: number;
    released_by: string | null;
  } | null;
  autoReleaseAt: string | null;
}

const FUNDABLE: JobStatus[] = ['assigned', 'en_route', 'in_progress', 'completed'];

/**
 * Section 11 escrow: the customer secures the accepted quote before work starts,
 * then confirms to release it (or it auto-releases). Technicians see whether
 * payment is secured before setting off.
 */
export function EscrowPanel({
  jobId,
  status,
  currency,
  amountMinor,
  role,
  onChange,
}: {
  jobId: string;
  status: JobStatus;
  currency: string;
  amountMinor: number;
  role: 'customer' | 'technician' | 'admin';
  onChange: () => void;
}) {
  const { data, reload } = useApi<Escrow>(`/jobs/${jobId}/escrow`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [settleAmount, setSettleAmount] = useState('');
  if (!data) return null;
  const refresh = () => {
    void reload();
    onChange();
  };
  const money = (n: number | null | undefined) => formatMoney(Number(n ?? 0), currency);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    Alert.alert('Release payment?', 'Confirm the work is done. The technician is paid from escrow.', [
      { text: 'Not yet' },
      {
        text: 'Release',
        onPress: () => void run(() => api(`/jobs/${jobId}/confirm-completion`, { method: 'POST' })),
      },
    ]);

  if (data.status === 'unfunded') {
    if (!FUNDABLE.includes(status)) return null;
    if (role === 'customer') {
      return (
        <View>
          <Muted>
            {status === 'completed'
              ? 'Paying now also confirms the work and releases payment to your technician.'
              : 'Your payment is held safely in escrow and only released when you confirm the job is done. Your technician sets off once it is secured.'}
          </Muted>
          <PaymentPicker
            endpoint={`/jobs/${jobId}/payments`}
            amountMinor={amountMinor}
            currency={currency}
            title={status === 'completed' ? `Pay ${money(amountMinor)}` : `Secure ${money(amountMinor)} in escrow`}
            buttonTitle={status === 'completed' ? 'Pay now' : 'Secure payment'}
            onPaid={refresh}
          />
        </View>
      );
    }
    return (
      <Card>
        <Badge label="Awaiting payment" tone="warn" />
        <Muted>The customer hasn't secured payment yet. You'll get an alert when it's held in escrow — then you can set off.</Muted>
      </Card>
    );
  }

  const h = data.hold;
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={styles.label}>Payment</Text>
        {data.status === 'held' && <Badge label="Secured in escrow" tone="good" />}
        {data.status === 'captured' && <Badge label="Released" tone="good" />}
        {data.status === 'refunded' && <Badge label="Refunded" tone="warn" />}
      </View>
      {data.status === 'held' && h && <Muted>{money(h.held_minor)} held until the work is confirmed.</Muted>}
      {data.status === 'held' && status === 'disputed' && <Muted>On hold while our team reviews the dispute.</Muted>}
      {data.status === 'held' && status === 'completed' && data.autoReleaseAt && (
        <Muted>Releases automatically on {new Date(data.autoReleaseAt).toLocaleString()} unless you report a problem.</Muted>
      )}
      {data.status === 'held' && status === 'completed' && role === 'customer' && (
        <Button title="Confirm & release payment" loading={busy} onPress={confirm} />
      )}
      {data.status === 'held' && role === 'admin' && ['completed', 'disputed'].includes(status) && h && (
        <>
          <Field label="Settle: amount to release to the technician" value={settleAmount} onChangeText={setSettleAmount} keyboardType="decimal-pad" />
          <Muted>The rest is refunded to the customer. 0 refunds everything and cancels the job.</Muted>
          <Button
            title="Settle escrow"
            variant="secondary"
            loading={busy}
            onPress={() =>
              run(() => api(`/admin/jobs/${jobId}/escrow/settle`, { body: { captureMinor: toMinor(Number(settleAmount || 0), currency) } }))
            }
          />
        </>
      )}
      {data.status === 'captured' && h && (
        <>
          <Muted>Labor: {money(h.labor_minor)}</Muted>
          <Muted>Parts (at cost): {money(h.parts_base_minor)}</Muted>
          <Muted>Parts markup: {money(h.markup_minor)}</Muted>
          {role !== 'customer' && <Muted>Platform commission: −{money(h.commission_minor)}</Muted>}
          {role !== 'customer' && <Muted>Paid to technician: {money(h.technician_payout_minor)}</Muted>}
          <Text style={{ fontWeight: '600' }}>Captured {money(h.captured_minor)}</Text>
          {Number(h.refunded_minor) > 0 && <Muted>Refunded to customer: {money(h.refunded_minor)}</Muted>}
        </>
      )}
      {data.status === 'refunded' && h && <Muted>{money(h.held_minor)} was returned to the customer.</Muted>}
      <ErrorText error={error} />
    </Card>
  );
}
