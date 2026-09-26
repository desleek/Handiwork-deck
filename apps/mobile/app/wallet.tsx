import { toMinor } from '@handiwork/shared';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { API_URL } from '@/lib/config';
import { formatMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Wallet {
  balances: { currency: string; balance_minor: number }[];
  entries: { id: number; currency: string; amount_minor: number; kind: string; memo: string | null; created_at: string; job_ref: string | null }[];
}

const KIND_LABEL: Record<string, string> = {
  topup: 'Top-up',
  job_payment: 'Job payment',
  job_earning: 'Job earning',
  refund: 'Refund',
  withdrawal: 'Withdrawal',
  adjustment: 'Adjustment',
  promotion: 'Promotion',
  fee: 'Fee',
};

interface VirtualAccount {
  provider: string;
  account_number: string;
  account_name: string | null;
  bank_name: string | null;
}

/** Section 11: a dedicated account number — any transfer into it tops up the wallet. */
function VirtualAccountCard() {
  const { data, reload } = useApi<{ account: VirtualAccount | null; available: boolean }>('/wallet/virtual-account?currency=NGN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!data || (!data.account && !data.available)) return null;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/wallet/virtual-account', { body: { currency: 'NGN' } });
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Text style={styles.label}>Your transfer account</Text>
      {data.account ? (
        <>
          <Text selectable style={{ fontSize: 20, fontWeight: '800', color: colors.ink, letterSpacing: 1 }}>
            {data.account.account_number}
          </Text>
          <Muted>
            {data.account.bank_name ?? 'Partner bank'}
            {data.account.account_name ? ` · ${data.account.account_name}` : ''}
          </Muted>
          <Muted>Transfer any amount from your bank app — it lands in your wallet automatically.</Muted>
        </>
      ) : (
        <>
          <Muted>Get a permanent account number just for you. Transfers into it top up your wallet.</Muted>
          <Button title="Get my account number" variant="secondary" loading={busy} onPress={create} />
        </>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

export default function WalletScreen() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<Wallet>('/wallet');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [method, setMethod] = useState<'card' | 'bank_transfer' | 'ussd'>('bank_transfer');
  const [busy, setBusy] = useState(false);
  const [topupError, setTopupError] = useState<unknown>(null);

  if (loading && !data) return <Loading />;

  const topUp = async () => {
    setBusy(true);
    setTopupError(null);
    try {
      const r = await api<{ checkoutUrl: string | null }>('/wallet/topups', {
        body: { amountMinor: toMinor(Number(amount), currency), currency, method },
      });
      if (r.checkoutUrl) await WebBrowser.openAuthSessionAsync(r.checkoutUrl, `${API_URL}/v1/payments/return`);
      setAmount('');
      await reload();
    } catch (e) {
      setTopupError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ErrorText error={error} />
      <View style={styles.row}>
        {(data?.balances.length ? data.balances : [{ currency: 'NGN', balance_minor: 0 }]).map((b) => (
          <Card key={b.currency} style={{ minWidth: '47%' }}>
            <Muted>{b.currency} balance</Muted>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.ink }}>{formatMoney(b.balance_minor, b.currency)}</Text>
          </Card>
        ))}
      </View>

      {user?.role === 'customer' && (
        <Card>
          <Text style={styles.label}>Top up</Text>
          <View style={styles.row}>
            {['NGN', 'GHS', 'KES'].map((c) => (
              <Chip key={c} label={c} selected={currency === c} onPress={() => setCurrency(c)} />
            ))}
          </View>
          <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <View style={styles.row}>
            <Chip label="Bank transfer" selected={method === 'bank_transfer'} onPress={() => setMethod('bank_transfer')} />
            <Chip label="Card" selected={method === 'card'} onPress={() => setMethod('card')} />
            <Chip label="USSD" selected={method === 'ussd'} onPress={() => setMethod('ussd')} />
          </View>
          <Button title="Top up" loading={busy} disabled={!(Number(amount) > 0)} onPress={topUp} />
          <ErrorText error={topupError} />
        </Card>
      )}
      {user?.role === 'customer' && <VirtualAccountCard />}
      {user?.role === 'technician' && <Muted>Your share of each job lands here when the customer's escrow is released.</Muted>}

      <Text style={styles.label}>Activity</Text>
      {data?.entries.length === 0 && <Muted>No wallet activity yet.</Muted>}
      {data?.entries.map((e) => (
        <View key={e.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.line }}>
          <View>
            <Text style={{ color: colors.ink }}>
              {KIND_LABEL[e.kind] ?? e.kind}
              {e.job_ref ? ` · #${e.job_ref}` : ''}
            </Text>
            <Muted>{new Date(e.created_at).toLocaleString()}</Muted>
          </View>
          <Text style={{ fontWeight: '700', color: e.amount_minor > 0 ? colors.success : colors.ink }}>
            {e.amount_minor > 0 ? '+' : ''}
            {formatMoney(e.amount_minor, e.currency)}
          </Text>
        </View>
      ))}
    </Screen>
  );
}
