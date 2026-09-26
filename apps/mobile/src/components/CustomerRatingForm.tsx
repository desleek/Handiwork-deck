import { CUSTOMER_RATING_LABEL, requiredCustomerRatingCategories } from '@handiwork/shared';
import { useState } from 'react';
import { Text } from 'react-native';
import { api } from '@/lib/api';
import { StarPicker } from './Stars';
import { Button, Card, ErrorText, Field, Muted, styles } from './ui';

/** Section 4: the technician rates the customer on how well they kept to the agreement. */
export function CustomerRatingForm({ jobId, laborOnly, onDone }: { jobId: string; laborOnly: boolean; onDone: () => void }) {
  const cats = requiredCustomerRatingCategories(laborOnly);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Card>
      <Text style={styles.label}>Rate the customer</Text>
      <Muted>How well did they keep to what was agreed? Other technicians see the average.</Muted>
      {cats.map((c) => (
        <StarPicker key={c} label={CUSTOMER_RATING_LABEL[c]} value={scores[c] ?? 0} onChange={(n) => setScores((s) => ({ ...s, [c]: n }))} />
      ))}
      <Field label="Comment (optional)" value={comment} onChangeText={setComment} multiline />
      <Button
        title="Submit rating"
        loading={busy}
        disabled={!cats.every((c) => scores[c])}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/jobs/${jobId}/customer-rating`, { body: { scores, comment: comment.trim() || undefined } });
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
      <ErrorText error={error} />
    </Card>
  );
}
