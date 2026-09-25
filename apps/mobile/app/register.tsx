import { CUSTOMER_TYPES, type CustomerType } from '@handiwork/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Button, Card, Chip, ErrorText, Field, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { View } from 'react-native';

const ROLES = [
  { key: 'customer', label: 'I need a technician', hint: 'Homeowners, offices and SMEs booking jobs' },
  { key: 'technician', label: "I'm a technician / tradesperson", hint: 'Household, office, construction or plant-erection work' },
  { key: 'advertiser', label: 'I sell spare parts', hint: 'Advertise parts and brands to customers and technicians' },
] as const;

const CUSTOMER_LABEL: Record<CustomerType, string> = { homeowner: 'Homeowner', office: 'Office', sme: 'Business (SME)' };

export default function Register() {
  const { refresh, signOut } = useAuth();
  const [role, setRole] = useState<(typeof ROLES)[number]['key']>('customer');
  const [customerType, setCustomerType] = useState<CustomerType>('homeowner');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const needsCompany = role === 'advertiser' || (role === 'customer' && customerType !== 'homeowner');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/register', {
        body: {
          role,
          fullName: fullName.trim(),
          phone: phone.trim() || undefined,
          customerType: role === 'customer' ? customerType : undefined,
          companyName: needsCompany && companyName.trim() ? companyName.trim() : undefined,
        },
      });
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {ROLES.map((r) => (
        <Card key={r.key} onPress={() => setRole(r.key)} style={role === r.key ? { borderColor: '#E8591A', borderWidth: 2 } : undefined}>
          <Muted>{r.hint}</Muted>
          <Chip label={r.label} selected={role === r.key} onPress={() => setRole(r.key)} />
        </Card>
      ))}

      {role === 'customer' && (
        <View style={styles.row}>
          {CUSTOMER_TYPES.map((t) => (
            <Chip key={t} label={CUSTOMER_LABEL[t]} selected={customerType === t} onPress={() => setCustomerType(t)} />
          ))}
        </View>
      )}

      <Field label="Full name" value={fullName} onChangeText={setFullName} />
      <Field
        label="WhatsApp number"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        placeholder="+2348012345678"
      />
      <Muted>Messages about your jobs are relayed through our WhatsApp number — the other party never sees yours.</Muted>
      {needsCompany && <Field label="Company name" value={companyName} onChangeText={setCompanyName} />}

      <Button title="Create account" loading={busy} disabled={fullName.trim().length < 2} onPress={submit} />
      <Button title="Sign out" variant="secondary" onPress={signOut} />
      <ErrorText error={error} />
    </Screen>
  );
}
