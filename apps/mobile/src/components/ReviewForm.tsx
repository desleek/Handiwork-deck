import { REVIEW_CATEGORIES, REVIEW_CATEGORY_LABEL, REVIEW_MIN_COMMENT_LENGTH, type ReviewCategory } from '@handiwork/shared';
import { useState } from 'react';
import { Text } from 'react-native';
import { api } from '@/lib/api';
import { StarPicker } from './Stars';
import { Button, Card, ErrorText, Field, Muted, styles } from './ui';

/** Mandatory multi-category review; new bookings are blocked until it's submitted. */
export function ReviewForm({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const [scores, setScores] = useState<Partial<Record<ReviewCategory, number>>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const complete = REVIEW_CATEGORIES.every((c) => scores[c]) && comment.trim().length >= REVIEW_MIN_COMMENT_LENGTH;

  return (
    <Card style={{ borderColor: '#F59E0B', borderWidth: 1.5 }}>
      <Text style={styles.label}>Rate this job</Text>
      <Muted>Required before your next booking. Score every category and tell others how it went.</Muted>
      {REVIEW_CATEGORIES.map((c) => (
        <StarPicker key={c} label={REVIEW_CATEGORY_LABEL[c]} value={scores[c] ?? 0} onChange={(n) => setScores((s) => ({ ...s, [c]: n }))} />
      ))}
      <Field label="Your review" value={comment} onChangeText={setComment} multiline placeholder="What was done, how it went…" />
      {comment.trim().length > 0 && comment.trim().length < REVIEW_MIN_COMMENT_LENGTH && <Muted>At least {REVIEW_MIN_COMMENT_LENGTH} characters.</Muted>}
      <Button
        title="Submit review"
        loading={busy}
        disabled={!complete}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/jobs/${jobId}/review`, { body: { scores, comment: comment.trim() } });
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
