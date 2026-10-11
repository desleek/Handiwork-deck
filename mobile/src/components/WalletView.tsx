import { useMutation, useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { api, ApiError } from '../api/client';
import { bpsToPct, formatMoney, toMinor } from '../lib/money';
import { queryClient } from '../lib/offline';
import { useTheme } from '../theme';
import { Banner, Button, Card, Divider, Row, Screen, T, useChoiceSheet } from './ui';

const LEDGER_LABEL: Record<string, string> = {
  topup: 'Top-up',
  topup_bonus: 'Top-up bonus',
  job_payment: 'Job payment',
  earning: 'Earnings',
  refund: 'Refund',
  withdrawal: 'Withdrawal',
  withdrawal_fee: 'Withdrawal fee',
  withdrawal_reversal: 'Withdrawal returned',
  boost_purchase: 'Promotion',
  adjustment: 'Adjustment',
};

/** Wallet (Section 15): balance, bonus window, top-ups, transparent withdrawals, full ledger. */
export function WalletView() {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const [amount, setAmount] = useState('');
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: () => api('/wallet') });
  const ledger = useQuery({ queryKey: ['ledger'], queryFn: () => api<any[]>('/wallet/ledger') });
  const banks = useQuery({ queryKey: ['banks'], queryFn: () => api<any[]>('/wallet/bank-accounts'), enabled: !!wallet.data?.withdrawals.enabled });
  const refresh = () => ['wallet', 'ledger'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border, fontSize: 18 };

  const topup = useMutation({
    mutationFn: (channel: string) => api('/wallet/topups', { body: { amountMinor: toMinor(amount), channel } }),
    onSuccess: async (p) => {
      if (p.checkout?.authorizationUrl) await WebBrowser.openAuthSessionAsync(p.checkout.authorizationUrl, 'handiwork://payment-complete');
      else if (p.checkout?.virtualAccount) Alert.alert('Transfer to', `${p.checkout.virtualAccount.accountNumber}\n${p.checkout.virtualAccount.bankName}`);
      else if (p.checkout?.ussd) Alert.alert('Dial', p.checkout.ussd.code);
      setTimeout(refresh, 3000);
    },
    onError: (e: ApiError) => Alert.alert('Top-up failed', e.message),
  });

  const withdraw = async () => {
    const minor = toMinor(amount);
    const bank = banks.data?.find((b) => b.is_default) ?? banks.data?.[0];
    if (!bank) return Alert.alert('Add a bank account first');
    try {
      const q = await api(`/wallet/withdrawals/quote`, { query: { amountMinor: minor } });
      const i = await sheet.open('How fast?', [
        `Standard — free, ${q.standard.eta.toLowerCase()} · you get ${formatMoney(q.standard.receiveMinor)}`,
        `Instant — ${formatMoney(q.instant.feeMinor)} fee, ${q.instant.eta.toLowerCase()} · you get ${formatMoney(q.instant.receiveMinor)}`,
      ]);
      if (i === null) return;
      await api('/wallet/withdrawals', { body: { amountMinor: minor, speed: i === 0 ? 'standard' : 'instant', bankAccountId: bank.id } });
      setAmount('');
      refresh();
    } catch (e: any) {
      Alert.alert('Withdrawal failed', e.message);
    }
  };

  const w = wallet.data;
  return (
    <Screen>
      {sheet.element}
      <Card>
        <T muted>Balance</T>
        <T v="title" style={[t.font.money, { fontSize: 32 }]}>{formatMoney(w?.balanceMinor)}</T>
        {w?.topupBonus ? (
          <T v="small" style={{ color: t.color.primary }}>
            Top-up bonus active until {new Date(w.topupBonus.activeUntil).toLocaleDateString()}: up to {bpsToPct(Math.max(...w.topupBonus.tiers.map((x: any) => x.bonusBps)))} back
          </T>
        ) : null}
      </Card>

      <Card>
        <TextInput value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="Amount (₦)" placeholderTextColor={t.color.textMuted} style={input} />
        <Row>
          <View style={{ flex: 1 }}>
            <Button
              title="Top up"
              disabled={!amount}
              loading={topup.isPending}
              onPress={async () => {
                const opts = ['Card', 'Bank transfer', 'USSD'];
                const i = await sheet.open('Top up with', opts);
                if (i !== null) topup.mutate(['card', 'bank_transfer', 'ussd'][i]);
              }}
            />
          </View>
          {w?.withdrawals.enabled ? (
            <View style={{ flex: 1 }}>
              <Button title="Withdraw" kind="secondary" disabled={!amount} onPress={withdraw} />
            </View>
          ) : null}
        </Row>
        {w?.withdrawals.enabled && banks.data?.length === 0 ? <Banner text="Add a bank account in Account → Payout account to withdraw." /> : null}
      </Card>

      <T v="heading">History</T>
      <Card>
        {(ledger.data ?? []).length === 0 ? <T muted>No transactions yet.</T> : null}
        {(ledger.data ?? []).map((e, i) => (
          <View key={e.id}>
            {i > 0 ? <Divider /> : null}
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <T>{LEDGER_LABEL[e.type] ?? e.type}</T>
                <T v="tiny" muted numberOfLines={1}>{e.description} · {new Date(e.created_at).toLocaleDateString()}</T>
              </View>
              <T style={[t.font.money, { color: e.amount_minor >= 0 ? t.color.primary : t.color.text }]}>
                {e.amount_minor >= 0 ? '+' : '−'}{formatMoney(Math.abs(e.amount_minor))}
              </T>
            </Row>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
