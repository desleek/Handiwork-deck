import type { JobStatus } from '@handiwork/shared';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { AdSlot } from '@/components/AdSlot';
import { LiveMap } from '@/components/LiveMap';
import { PaymentPicker } from '@/components/PaymentPicker';
import { QuoteBuilder } from '@/components/QuoteBuilder';
import { CustomerQuoteCard, TechnicianQuoteCard } from '@/components/QuoteCard';
import { ReviewForm } from '@/components/ReviewForm';
import { Badge, Button, colors, ErrorText, Loading, Muted, Screen, styles, Title } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney, STATUS_LABEL } from '@/lib/format';
import { startSharingLocation } from '@/lib/liveLocation';
import type { Quote } from '@/lib/quotes';
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
  booking_mode: 'open' | 'request' | 'instant';
  custom_service_name: string | null;
  awaiting_category_review: boolean;
  labor_only: boolean;
}
interface Detail {
  job: Job;
  quotes: Quote[];
  history: { to_status: JobStatus; note: string | null; created_at: string }[];
  review: { overall: number; comment: string } | null;
  whatsappLink: string | null;
}

export default function JobDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<Detail>(`/jobs/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [revising, setRevising] = useState(false);
  const stopSharing = useRef<(() => void) | null>(null);

  useEffect(() => () => stopSharing.current?.(), []);

  if (loading && !data) return <Loading />;
  if (!data || !user) return <Screen><ErrorText error={error} /></Screen>;
  const { job, quotes, whatsappLink } = data;
  const isCustomer = job.customer_id === user.id;
  const isTech = job.technician_id === user.id;
  const negotiating = job.status === 'open' || job.status === 'quoted';
  const myQuote = user.role === 'technician' ? quotes.find((q) => q.technician_id === user.id) : undefined;

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
  const chatWith = (technicianId: string, name: string) => router.push({ pathname: '/chat/[jobId]', params: { jobId: job.id, technicianId, name } });

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>{job.title}</Title>
        <Muted>#{job.ref}</Muted>
      </View>
      <View style={styles.row}>
        <Badge label={STATUS_LABEL[job.status]} tone={job.status === 'paid' ? 'good' : job.status === 'disputed' || job.status === 'cancelled' ? 'bad' : 'neutral'} />
        {job.booking_mode !== 'open' && <Badge label={job.booking_mode === 'instant' ? 'Instant booking' : 'Booking request'} />}
        {job.labor_only && <Badge label="Labor only — you supply materials" tone="warn" />}
      </View>
      {job.awaiting_category_review && (
        <Muted>“{job.custom_service_name}” is being reviewed by our team. Technicians will be notified once it's approved.</Muted>
      )}
      <Muted>{job.address}</Muted>
      {job.description ? <Text style={{ color: colors.ink }}>{job.description}</Text> : null}
      {job.budget_minor != null && <Text style={{ fontWeight: '600' }}>{formatMoney(job.budget_minor, job.currency)}</Text>}

      {(job.status === 'en_route' || job.status === 'in_progress') && isCustomer && <LiveMap jobId={job.id} job={job} />}

      {whatsappLink && <Button title="Message on WhatsApp" variant="whatsapp" onPress={() => Linking.openURL(whatsappLink)} />}
      {job.technician_id && (isCustomer || isTech) && (
        <Button title="Open chat" variant="secondary" onPress={() => chatWith(job.technician_id!, isCustomer ? 'Technician' : 'Customer')} />
      )}

      {/* ---------- customer: compare & negotiate itemized quotes ---------- */}
      {isCustomer && negotiating && (
        <>
          <Text style={styles.label}>Quotes</Text>
          {quotes.length === 0 && <Muted>Waiting for quotes…</Muted>}
          {quotes
            .filter((q) => q.status === 'pending' || q.status === 'countered')
            .map((q) => (
              <CustomerQuoteCard key={q.id} jobId={job.id} quote={q} open onChange={reload} />
            ))}
        </>
      )}
      {isCustomer && !negotiating && quotes.filter((q) => q.status === 'accepted').map((q) => <CustomerQuoteCard key={q.id} jobId={job.id} quote={q} open={false} onChange={reload} />)}

      {/* ---------- technician: quote / revise / respond to counters ---------- */}
      {user.role === 'technician' && negotiating && (!myQuote || revising) && (
        <QuoteBuilder
          jobId={job.id}
          currency={job.currency}
          existing={revising ? myQuote : undefined}
          onDone={() => {
            setRevising(false);
            void reload();
          }}
        />
      )}
      {myQuote && !revising && <TechnicianQuoteCard jobId={job.id} quote={myQuote} onRevise={() => setRevising(true)} onChange={reload} />}
      {user.role === 'technician' && negotiating && (
        <Button title="Ask the customer a question" variant="secondary" onPress={() => chatWith(user.id, 'Customer')} />
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
      {isTech && job.status === 'in_progress' && <Button title="Mark job completed" loading={busy === 'completed'} onPress={() => setStatus('completed')} />}

      {/* ---------- customer: pay & mandatory review ---------- */}
      {isCustomer && job.status === 'completed' && job.budget_minor != null && (
        <PaymentPicker jobId={job.id} amountMinor={job.budget_minor} currency={job.currency} onPaid={reload} />
      )}
      {isCustomer && (job.status === 'completed' || job.status === 'paid') && !data.review && <ReviewForm jobId={job.id} onDone={reload} />}
      {data.review && (
        <Muted>
          Your review: ★ {Number(data.review.overall).toFixed(1)} — “{data.review.comment}”
        </Muted>
      )}

      {/* ---------- cancel / dispute ---------- */}
      {((isCustomer && ['open', 'quoted', 'assigned'].includes(job.status)) || (isTech && job.status === 'assigned')) && (
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
