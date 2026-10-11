import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, TextInput } from 'react-native';
import { api, ApiError } from '../../../src/api/client';
import { StarInput } from '../../../src/components/StarInput';
import { Button, Card, Row, Screen, T } from '../../../src/components/ui';
import { useAuth } from '../../../src/lib/auth';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

const CUSTOMER_FIELDS = [
  ['competence', 'Competence'],
  ['punctuality', 'Punctuality'],
  ['professionalism', 'Professionalism'],
  ['courtesy', 'Courtesy'],
  ['delivery_timeline', 'Delivery timeline'],
  ['pricing_fairness', 'Transparent, fair pricing'],
  ['quality_of_work', 'Quality of work'],
] as const;

const TECH_FIELDS = [
  ['on_site_as_scheduled', 'On site as scheduled'],
  ['granted_access', 'Granted access'],
  ['paid_through_platform', 'Paid through the platform'],
  ['respectful_conduct', 'Respectful conduct'],
] as const;

/**
 * Mandatory post-job rating (Section 7). Designed to be fast: "Set all" fills every category in
 * one tap, then the customer adjusts any that differ and writes a short review.
 */
export default function Rate() {
  const t = useTheme();
  const auth = useAuth();
  const { id, as } = useLocalSearchParams<{ id: string; as?: string }>();
  const asTech = as === 'technician';
  const fields: readonly (readonly [string, string])[] = asTech ? TECH_FIELDS : CUSTOMER_FIELDS;
  const [scores, setScores] = useState<Record<string, number>>({});
  const [review, setReview] = useState('');
  const complete = fields.every(([k]) => scores[k]);

  const submit = useMutation({
    mutationFn: () =>
      api(`/jobs/${id}/${asTech ? 'customer-rating' : 'rating'}`, { body: asTech ? { ...scores, comment: review || undefined } : { ...scores, review } }),
    onSuccess: async () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      await auth.refresh(); // lifts the booking block
      router.back();
    },
    onError: (e: ApiError) => Alert.alert('Could not submit', e.message),
  });

  return (
    <Screen>
      <T v="title">{asTech ? 'How was this customer?' : 'How did it go?'}</T>
      <T muted>{asTech ? 'Other technicians see this before accepting their bookings.' : 'Your review helps neighbours choose — and is required before your next booking.'}</T>
      <Card>
        <Row style={{ justifyContent: 'flex-end' }}>
          {[5, 4, 3].map((n) => (
            <Button key={n} kind="ghost" title={`All ${n}★`} onPress={() => setScores(Object.fromEntries(fields.map(([k]) => [k, n])))} />
          ))}
        </Row>
        {fields.map(([k, label]) => (
          <StarInput key={k} label={label} value={scores[k] ?? 0} onChange={(v) => setScores((s) => ({ ...s, [k]: v }))} />
        ))}
      </Card>
      <TextInput
        value={review}
        onChangeText={setReview}
        multiline
        placeholder={asTech ? 'Anything other technicians should know? (optional)' : 'What did they do well? Anything to improve?'}
        placeholderTextColor={t.color.textMuted}
        style={{ minHeight: 100, textAlignVertical: 'top', backgroundColor: t.color.surface, borderRadius: t.radius.md, padding: t.space(3), color: t.color.text, fontSize: 16 }}
      />
      {!asTech && review.length > 0 && review.length < 10 ? <T v="small" muted>A few more words, please (10+ characters).</T> : null}
      <Button title="Submit" loading={submit.isPending} disabled={!complete || (!asTech && review.trim().length < 10)} onPress={() => submit.mutate()} />
    </Screen>
  );
}
