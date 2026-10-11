import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Switch, TextInput } from 'react-native';
import { api, ApiError } from '../api/client';
import { useAuth, useMe } from '../lib/auth';
import { queryClient } from '../lib/offline';
import { useTheme } from '../theme';
import { Banner, Button, Card, Row, Screen, T } from './ui';

/** Account: notification preferences, payout account, appeals, and the store-mandated delete flow. */
export function AccountView() {
  const t = useTheme();
  const me = useMe();
  const auth = useAuth();
  const [promo, setPromo] = useState(true);
  const [bank, setBank] = useState({ bankCode: '', bankName: '', accountNumber: '' });
  const [appeal, setAppeal] = useState('');
  const banks = useQuery({ queryKey: ['banks'], queryFn: () => api<any[]>('/wallet/bank-accounts') });
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  const addBank = useMutation({
    mutationFn: () => api('/wallet/bank-accounts', { body: bank }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['banks'] }),
    onError: (e: ApiError) => Alert.alert('Could not add account', e.message),
  });

  const restriction = me.restrictions[0];

  return (
    <Screen>
      <Card>
        <T v="heading">{me.full_name}</T>
        <T muted>{me.role === 'technician' ? 'Technician' : 'Customer'}{me.completion_badge ? ' · Reliable customer badge' : ''}</T>
      </Card>

      {restriction ? (
        <Card>
          <Banner tone="danger" text={me.status === 'suspended' ? 'Your account is suspended after repeated incomplete transactions.' : `Some actions are paused until ${restriction.endsAt ? new Date(restriction.endsAt).toLocaleDateString() : 'further notice'}. Jobs in progress are not affected.`} />
          <TextInput value={appeal} onChangeText={setAppeal} multiline placeholder="Explain what happened (appeal)" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 80 }]} />
          <Button title="Submit appeal" kind="secondary" disabled={appeal.length < 20} onPress={() => api('/me/appeals', { body: { restrictionId: restriction.id, statement: appeal } }).then(() => Alert.alert('Appeal sent')).catch((e) => Alert.alert(e.message))} />
        </Card>
      ) : null}

      <Card>
        <T v="heading">Notifications</T>
        <Row style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }}>Availability alerts from nearby pros</T>
          <Switch value={promo} onValueChange={(v) => { setPromo(v); api('/me/notification-prefs', { method: 'PUT', body: { promotionalAlerts: v } }); }} />
        </Row>
        <T v="small" muted>Job updates, messages and escalations are always on so you never miss something you need to act on.</T>
      </Card>

      <Card>
        <T v="heading">Payout account</T>
        {(banks.data ?? []).map((b) => <T key={b.id}>{b.bank_name} ••{b.account_last4} · {b.account_name}</T>)}
        <TextInput value={bank.bankName} onChangeText={(v) => setBank({ ...bank, bankName: v })} placeholder="Bank name" placeholderTextColor={t.color.textMuted} style={input} />
        <Row>
          <TextInput value={bank.bankCode} onChangeText={(v) => setBank({ ...bank, bankCode: v })} placeholder="Bank code" keyboardType="numeric" placeholderTextColor={t.color.textMuted} style={[input, { width: 110 }]} />
          <TextInput value={bank.accountNumber} onChangeText={(v) => setBank({ ...bank, accountNumber: v })} placeholder="10-digit account no." keyboardType="numeric" maxLength={10} placeholderTextColor={t.color.textMuted} style={[input, { flex: 1 }]} />
        </Row>
        <Button title="Add account" kind="secondary" loading={addBank.isPending} disabled={bank.accountNumber.length !== 10 || !bank.bankCode} onPress={() => addBank.mutate()} />
      </Card>

      <Button title="Sign out" kind="secondary" onPress={() => auth.signOut()} />
      <Button
        title="Delete my account"
        kind="ghost"
        onPress={() =>
          Alert.alert('Delete account?', 'Your profile and personal details will be removed. Completed job and payment records are kept anonymised for legal reasons.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: async () => {
                try {
                  await api('/me', { method: 'DELETE' });
                  await auth.signOut();
                } catch (e: any) {
                  Alert.alert('Cannot delete yet', e.message);
                }
              },
            },
          ])
        }
      />
    </Screen>
  );
}
