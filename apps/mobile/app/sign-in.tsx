import { router } from 'expo-router';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, ErrorText, Field, Muted, Screen, Title } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { FIREBASE_ENABLED } from '@/lib/config';
import { firebaseAuth } from '@/lib/firebase';

export default function SignIn() {
  const { devSignIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devUid, setDevUid] = useState('');
  const [devPhone, setDevPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.replace('/');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>HANDIWORK-DECK</Title>
      <Muted>Trusted technicians and tradespeople for your home, office and site.</Muted>

      {FIREBASE_ENABLED ? (
        <Card>
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
          <Button title="Sign in" loading={busy} onPress={() => run(() => signInWithEmailAndPassword(firebaseAuth(), email.trim(), password))} />
          <Button
            title="Create account"
            variant="secondary"
            disabled={busy}
            onPress={() => run(() => createUserWithEmailAndPassword(firebaseAuth(), email.trim(), password))}
          />
        </Card>
      ) : (
        <Card>
          <Text style={{ fontWeight: '600' }}>Developer sign-in</Text>
          <Muted>Firebase isn't configured, so the app signs in with a dev identity. The API must run with AUTH_MODE=dev.</Muted>
          <Field label="User id" value={devUid} onChangeText={setDevUid} autoCapitalize="none" placeholder="e.g. customer-1" />
          <Field label="Phone (E.164, optional)" value={devPhone} onChangeText={setDevPhone} placeholder="+2348012345678" keyboardType="phone-pad" />
          <Button title="Continue" loading={busy} disabled={!devUid.trim()} onPress={() => run(() => devSignIn(devUid.trim(), devPhone.trim() || undefined))} />
        </Card>
      )}
      <ErrorText error={error} />
    </Screen>
  );
}
