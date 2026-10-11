import { useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, T } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { useTheme } from '../../src/theme';

export default function SignIn() {
  const t = useTheme();
  const auth = useAuth();
  const [phone, setPhone] = useState('+234');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState<((c: string) => Promise<void>) | null>(null);
  const [devId, setDevId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3.5), color: t.color.text, fontSize: 17, borderWidth: 1, borderColor: t.color.border };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: t.space(6), gap: t.space(4) }}>
        <View style={{ gap: t.space(1) }}>
          <T v="title" style={{ fontSize: 30 }}>Handiwork-Deck</T>
          <T muted>Trusted local technicians and tradespeople, with transparent itemized pricing.</T>
        </View>

        {error ? <Banner tone="danger" text={error} /> : null}

        {auth.mode === 'dev' ? (
          <>
            <Banner tone="info" text="Development sign-in. Paste a user ID (UUID) — new IDs go on to registration." />
            <TextInput value={devId} onChangeText={setDevId} placeholder="00000000-0000-0000-0000-000000000002" placeholderTextColor={t.color.textMuted} autoCapitalize="none" style={input} />
            <Button title="Continue" loading={busy} disabled={devId.length < 36} onPress={() => run(() => auth.devSignIn(devId.trim()))} />
          </>
        ) : !confirm ? (
          <>
            <T v="heading">Your phone number</T>
            <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" style={input} />
            <Button title="Send code" loading={busy} disabled={!/^\+\d{10,15}$/.test(phone)} onPress={() =>
                run(async () => {
                  const confirmCode = await auth.startPhoneSignIn(phone);
                  setConfirm(() => confirmCode); // functional form: store the function itself
                })
              }
            />
          </>
        ) : (
          <>
            <T v="heading">Enter the 6-digit code</T>
            <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6} style={input} />
            <Button title="Verify" loading={busy} disabled={code.length !== 6} onPress={() => run(() => confirm(code))} />
            <Button title="Use a different number" kind="ghost" onPress={() => setConfirm(null)} />
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
