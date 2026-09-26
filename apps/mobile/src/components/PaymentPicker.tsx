import { type PaymentMethod } from '@handiwork/shared';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { formatMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { Button, Card, Chip, ErrorText, Muted, styles } from './ui';

interface Option {
  method: PaymentMethod;
  label: string;
  providers: string[];
  balanceMinor?: number;
}

const PROVIDER_LABEL: Record<string, string> = { paystack: 'Paystack', flutterwave: 'Flutterwave', stripe: 'Stripe', mock: 'Test gateway' };

/**
 * Section 11: card, bank transfer (virtual account), USSD, or wallet — with a
 * choice of Paystack / Flutterwave where both can take the method. The same
 * picker pays jobs into escrow and technician promotions.
 */
export function PaymentPicker({
  endpoint,
  amountMinor,
  currency,
  onPaid,
  title,
  buttonTitle = 'Pay now',
  extraBody,
}: {
  endpoint: string;
  amountMinor: number;
  currency: string;
  onPaid: () => void;
  title?: string;
  buttonTitle?: string;
  extraBody?: Record<string, unknown>;
}) {
  const { data } = useApi<{ methods: Option[] }>(`/payments/options?currency=${currency}`);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const option = data?.methods.find((m) => m.method === method);
  const walletShort = option?.method === 'wallet' && (option.balanceMinor ?? 0) < amountMinor;

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ checkoutUrl?: string | null; status?: string }>(endpoint, {
        body: { ...extraBody, method, provider: provider ?? undefined },
      });
      if (res.checkoutUrl) await WebBrowser.openAuthSessionAsync(res.checkoutUrl, `${API_URL}/v1/payments/return`);
      onPaid();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text style={styles.label}>{title ?? `Pay ${formatMoney(amountMinor, currency)}`}</Text>
      <View style={styles.row}>
        {data?.methods.map((m) => (
          <Chip
            key={m.method}
            label={m.method === 'wallet' ? `${m.label} (${formatMoney(m.balanceMinor ?? 0, currency)})` : m.label}
            selected={method === m.method}
            onPress={() => {
              setMethod(m.method);
              setProvider(null);
            }}
          />
        ))}
      </View>
      {option && option.providers.length > 1 && (
        <>
          <Muted>Pay with</Muted>
          <View style={styles.row}>
            {option.providers.map((p) => (
              <Chip key={p} label={PROVIDER_LABEL[p] ?? p} selected={provider === p} onPress={() => setProvider(p)} />
            ))}
          </View>
        </>
      )}
      {option?.method === 'bank_transfer' && <Muted>You'll get a one-time account number to transfer to.</Muted>}
      {option?.method === 'ussd' && <Muted>You'll get a USSD code to dial from your bank phone number.</Muted>}
      {walletShort && <Muted>Not enough in your wallet — top up from your profile, or pick another method.</Muted>}
      <Button title={buttonTitle} loading={busy} disabled={!method || walletShort} onPress={pay} />
      <ErrorText error={error} />
    </Card>
  );
}
