import * as Linking from 'expo-linking';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { Button, Card, colors, ErrorText, Muted } from './ui';

/**
 * Section 8: real phone numbers are only released once the job is approved.
 * Before that the parties talk through masked in-app chat.
 */
export function ContactReveal({ jobId, unlocked }: { jobId: string; unlocked: boolean }) {
  const [contact, setContact] = useState<{ name: string; phone: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!unlocked) return <Muted>🔒 Phone numbers are shared once the job is approved. Until then, use the in-app chat.</Muted>;
  if (!contact) {
    return (
      <Button
        title="Show contact details"
        variant="secondary"
        onPress={async () => {
          try {
            setContact((await api<{ contact: { name: string; phone: string | null } }>(`/jobs/${jobId}/contact`)).contact);
          } catch (e) {
            setError(e instanceof ApiError && e.code === 'contact_locked' ? new Error(e.message) : e);
          }
        }}
      />
    );
  }
  return (
    <Card>
      <Text style={{ fontWeight: '600', color: colors.ink }}>{contact.name}</Text>
      {contact.phone ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Text style={{ flex: 1, color: colors.ink }}>{contact.phone}</Text>
          <Button title="Call" onPress={() => Linking.openURL(`tel:${contact.phone}`)} />
        </View>
      ) : (
        <Muted>No phone number on file.</Muted>
      )}
      <ErrorText error={error} />
    </Card>
  );
}
