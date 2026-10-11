import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { api } from '../../src/api/client';
import { Banner, Button, Card, PlatformIcon, Row, Screen, T } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { useTheme } from '../../src/theme';

export default function Register() {
  const t = useTheme();
  const auth = useAuth();
  const [role, setRole] = useState<'customer' | 'technician'>('customer');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('+234');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3.5), color: t.color.text, fontSize: 16, borderWidth: 1, borderColor: t.color.border };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/me/register', { body: { role, fullName, phoneE164: phone, email: email || undefined } });
      await auth.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const RoleCard = ({ value, title, body, icon }: { value: typeof role; title: string; body: string; icon: string }) => (
    <Pressable onPress={() => setRole(value)} style={{ flex: 1 }}>
      <Card style={{ borderWidth: 2, borderColor: role === value ? t.color.primary : 'transparent' }}>
        <PlatformIcon name={icon} color={t.color.primary} />
        <T v="heading">{title}</T>
        <T v="small" muted>{body}</T>
      </Card>
    </Pressable>
  );

  return (
    <Screen>
      <T v="title">Create your account</T>
      <Row style={{ alignItems: 'stretch' }}>
        <RoleCard value="customer" title="I need a pro" body="Homes, offices and businesses" icon="magnify" />
        <RoleCard value="technician" title="I'm a pro" body="Get jobs near you" icon="briefcase-outline" />
      </Row>
      {error ? <Banner tone="danger" text={error} /> : null}
      <View style={{ gap: t.space(2) }}>
        <T v="small" muted>Full name</T>
        <TextInput value={fullName} onChangeText={setFullName} textContentType="name" autoComplete="name" style={input} />
        <T v="small" muted>Phone (kept private until a job is confirmed)</T>
        <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={input} />
        <T v="small" muted>Email (optional)</T>
        <TextInput value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" style={input} />
      </View>
      <Button title="Continue" loading={busy} disabled={fullName.trim().length < 2} onPress={submit} />
    </Screen>
  );
}
