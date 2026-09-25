import { type JobStatus, toMinor } from '@handiwork/shared';
import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { AdSlot } from '@/components/AdSlot';
import { LiveMap } from '@/components/LiveMap';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles, Title } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { API_URL } from '@/lib/config';
import { formatMoney, STATUS_LABEL } from '@/lib/format';
import { startSharingLocation } from '@/lib/liveLocation';
import { useApi } from '@/lib/useApi';

interface Job {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  address: string;
  lat: number;
  lng: number;
  status: JobStatus;
  customer_id: string;
  technician_id: string | null;
  category_id: number;
  budget_minor: number | null;
  currency: string;
}
interface Quote {
  id: string;
  technician_id: string;
  technician_name: string;
  amount_minor: number;
  currency: string;
  message: string | null;
  eta_minutes: number | null;
  status: string;
  rating_avg: number;
  rating_count: number;
}
interface Detail {
  job: Job;
  quotes: Quote[];
  history: { to_status: JobStatus; created_at: string }[];
  whatsappLink: string | null;
}

export default function JobDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<Detail>(`/jobs/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const stopSharing = useRef<(() => void) | null>(null);

  useEffect(() => () => stopSharing.current?.(), []);

  if (loading && !data) return <Loading />;
  if (!data || !user) return <Screen><ErrorText error={error} /></Screen>;
  const { job, quotes, whatsappLink } = data;
  const isCustomer = job.customer_id === user.id;
  const isTech = job.technician_id === user.id;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  };
  const setStatus = (status: string) => act(status, () => api(`/jobs/${job.id}/status`, { body: { status } }));

  const pay = () =>
    act('pay', async () => {
      const res = await api<{ checkoutUrl: string | null }>(`/jobs/${job.id}/payments`, { method: 'POST' });
      if (!res.checkoutUrl) throw new Error('Payment provider did not return a checkout link');
      // Closes automatically when the provider redirects to our return URL.
      await WebBrowser.openAuthSessionAsync(res.checkoutUrl, `${API_URL}/v1/payments/return`);
    });

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>{job.title}</Title>
        <Muted>#{job.ref}</Muted>
      </View>
      <Badge label={STATUS_LABEL[job.status]} tone={job.status === 'paid' ? 'good' : job.status === 'disputed' || job.status === 'cancelled' ? 'bad' : 'neutral'} />
      <Muted>{job.address}</Muted>
      {job.description ? <Text style={{ color: colors.ink }}>{job.description}</Text> : null}
      {job.budget_minor != null && <Text style={{ fontWeight: '600' }}>{formatMoney(job.budget_minor, job.currency)}</Text>}

      {(job.status === 'en_route' || job.status === 'in_progress') && isCustomer && <LiveMap jobId={job.id} job={job} />}

      {whatsappLink && (
        <Button title="Message on WhatsApp" variant="whatsapp" onPress={() => Linking.openURL(whatsappLink)} />
      )}

      {/* ---------- customer: quotes ---------- */}
      {isCustomer && (job.status === 'open' || job.status === 'quoted') && (
        <>
          <Text style={styles.label}>Quotes</Text>
          {quotes.length === 0 && <Muted>Waiting for quotes from nearby technicians…</Muted>}
          {quotes.map((q) => (
            <Card key={q.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '600' }}>{q.technician_name}</Text>
                <Text style={{ fontWeight: '700' }}>{formatMoney(q.amount_minor, q.currency)}</Text>
              </View>
              <Muted>
                ★ {Number(q.rating_avg).toFixed(1)} ({q.rating_count}){q.eta_minutes ? ` · ETA ${q.eta_minutes} min` : ''}
              </Muted>
              {q.message ? <Text>{q.message}</Text> : null}
              <Button title="Accept quote" loading={busy === q.id} onPress={() => act(q.id, () => api(`/jobs/${job.id}/quotes/${q.id}/accept`, { method: 'POST' }))} />
            </Card>
          ))}
        </>
      )}

      {/* ---------- technician: quote on an open job ---------- */}
      {user.role === 'technician' && !isTech && (job.status === 'open' || job.status === 'quoted') && (
        <QuoteForm jobId={job.id} currency={job.currency} existing={quotes[0]} onDone={reload} />
      )}

      {/* ---------- technician: progress the job ---------- */}
      {isTech && job.status === 'assigned' && (
        <Button
          title="I'm on my way"
          loading={busy === 'en_route'}
          onPress={() =>
            act('en_route', async () => {
              await api(`/jobs/${job.id}/status`, { body: { status: 'en_route' } });
              stopSharing.current = await startSharingLocation(job.id);
            })
          }
        />
      )}
      {isTech && job.status === 'en_route' && (
        <Button
          title="I've arrived — start work"
          loading={busy === 'in_progress'}
          onPress={() => {
            stopSharing.current?.();
            void setStatus('in_progress');
          }}
        />
      )}
      {isTech && job.status === 'in_progress' && (
        <Button title="Mark job completed" loading={busy === 'completed'} onPress={() => setStatus('completed')} />
      )}

      {/* ---------- customer: pay & review ---------- */}
      {isCustomer && job.status === 'completed' && (
        <Button title={`Pay ${formatMoney(job.budget_minor, job.currency)}`} loading={busy === 'pay'} onPress={pay} />
      )}
      {isCustomer && (job.status === 'completed' || job.status === 'paid') && <ReviewForm jobId={job.id} />}

      {/* ---------- cancel / dispute ---------- */}
      {(isCustomer || isTech) && ['open', 'quoted', 'assigned'].includes(job.status) && (isCustomer || job.status === 'assigned') && (
        <Button
          title="Cancel job"
          variant="secondary"
          onPress={() =>
            Alert.alert('Cancel this job?', undefined, [
              { text: 'Keep it' },
              { text: 'Cancel job', style: 'destructive', onPress: () => void setStatus('cancelled') },
            ])
          }
        />
      )}
      {(isCustomer || isTech) && ['assigned', 'en_route', 'in_progress', 'completed', 'paid'].includes(job.status) && (
        <Button title="Report a problem" variant="secondary" onPress={() => setStatus('disputed')} />
      )}

      <ErrorText error={actionError} />
      <AdSlot categoryId={job.category_id} />

      <Text style={styles.label}>Timeline</Text>
      {data.history.map((h, i) => (
        <Muted key={i}>
          {new Date(h.created_at).toLocaleString()} — {STATUS_LABEL[h.to_status]}
        </Muted>
      ))}
    </Screen>
  );
}

function QuoteForm({ jobId, currency, existing, onDone }: { jobId: string; currency: string; existing?: Quote; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [eta, setEta] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (existing) {
    return (
      <Card>
        <Text style={{ fontWeight: '600' }}>Your quote: {formatMoney(existing.amount_minor, existing.currency)}</Text>
        <Muted>Status: {existing.status}</Muted>
      </Card>
    );
  }
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/jobs/${jobId}/quotes`, {
        body: { amountMinor: toMinor(Number(amount), currency), etaMinutes: eta ? Number(eta) : undefined, message: message.trim() || undefined },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Text style={{ fontWeight: '600' }}>Send a quote</Text>
      <Field label={`Price (${currency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <Field label="Can arrive in (minutes)" value={eta} onChangeText={setEta} keyboardType="number-pad" />
      <Field label="Message" value={message} onChangeText={setMessage} multiline />
      <Button title="Send quote" loading={busy} disabled={!(Number(amount) > 0)} onPress={submit} />
      <ErrorText error={error} />
    </Card>
  );
}

function ReviewForm({ jobId }: { jobId: string }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (done) return <Muted>Thanks for your review!</Muted>;
  return (
    <Card>
      <Text style={{ fontWeight: '600' }}>Rate your technician</Text>
      <View style={styles.row}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Chip key={n} label={'★'.repeat(n)} selected={rating === n} onPress={() => setRating(n)} />
        ))}
      </View>
      <Field label="Comment" value={comment} onChangeText={setComment} multiline />
      <Button
        title="Submit review"
        disabled={!rating}
        onPress={async () => {
          try {
            await api(`/jobs/${jobId}/review`, { body: { rating, comment: comment.trim() || undefined } });
            setDone(true);
          } catch (e) {
            setError(e);
          }
        }}
      />
      <ErrorText error={error} />
    </Card>
  );
}
