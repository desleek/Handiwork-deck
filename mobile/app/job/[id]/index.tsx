import { useMutation, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, TextInput, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { api, ApiError } from '../../../src/api/client';
import type { JobDetail } from '../../../src/api/types';
import { ConstructionPanel } from '../../../src/components/ConstructionPanel';
import { PriceBreakdown } from '../../../src/components/PriceBreakdown';
import { Stars } from '../../../src/components/StarInput';
import { Banner, Button, Card, Loading, Note, Row, Screen, ScreenHeader, T, Tag, useChoiceSheet } from '../../../src/components/ui';
import { formatMoney, toMinor } from '../../../src/lib/money';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

const STATUS_LABEL: Record<string, string> = {
  requested: 'Waiting for technician',
  accepted: 'Quote on the way',
  quoted: 'Quote ready',
  negotiating: 'Negotiating',
  approved: 'Awaiting payment',
  funded: 'Paid — scheduled',
  en_route: 'Technician en route',
  in_progress: 'In progress',
  awaiting_confirmation: 'Confirm completion',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
  incomplete: 'Closed — incomplete',
  disputed: 'In dispute',
};

export default function JobScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sheet = useChoiceSheet();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const { data: job, isLoading, refetch } = useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetail>(`/jobs/${id}`),
    refetchInterval: (q) => (['funded', 'en_route'].includes(q.state.data?.status ?? '') ? 15_000 : 60_000),
  });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api(`/jobs/${id}${path}`, { body: body ?? {} }),
    onSuccess: () => {
      setAmount('');
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e: ApiError) => Alert.alert('Could not complete that', e.message),
  });
  const run = (path: string, body?: unknown) => act.mutate({ path, body });
  // "Approve & pay" is one tap for the customer: approve the quote, then go straight to payment.
  const approveAndPay = useMutation({
    mutationFn: () => api(`/jobs/${id}/approve`, { body: {} }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['job', id] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      router.push(`/job/${id}/pay`);
    },
    onError: (e: ApiError) => Alert.alert('Could not approve the quote', e.message),
  });

  if (isLoading || !job) return <Loading />;
  const isCustomer = job.viewer === 'customer';
  const myTurn = job.action_required_from === job.viewer;
  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  const pendingLaborOnly = job.laborOnlyRequests.find((r) => r.status === 'pending');
  const openChallenge = job.priceChallenges.find((c) => ['open', 'escalated', 'pending_evidence_review'].includes(c.status));
  const negotiation = job.laborNegotiation && ['pending', 'countered'].includes(job.laborNegotiation.status) ? job.laborNegotiation : null;
  const reviewingQuote = isCustomer && job.kind !== 'construction' && job.status === 'quoted' && job.quote?.status === 'submitted';

  const moreOptions = async () => {
    const opts = [!job.quote!.laborOnly ? 'I will supply parts (labor-only)' : null, 'Offer a different labor price', 'Decline and cancel booking'].filter(Boolean) as string[];
    const i = await sheet.open('Other ways to respond', opts, opts.length - 1);
    if (i === null) return;
    const choice = opts[i];
    if (choice.startsWith('I will supply')) run('/labor-only');
    else if (choice.startsWith('Offer')) setNote('negotiate');
    else run('/cancel', { reason: 'Customer declined the quote' });
  };

  const footer = reviewingQuote ? (
    <>
      <Button title={`Approve & pay ${formatMoney(job.quote!.totals.totalMinor)}`} loading={approveAndPay.isPending} onPress={() => approveAndPay.mutate()} />
      <Row gap={2.5}>
        <Button style={{ flex: 1 }} size="md" kind="outline" icon="chat-outline" title="Ask a question" onPress={() => router.push(`/job/${id}/chat`)} />
        <Button style={{ flex: 1 }} size="md" kind="outline" title="Other options" onPress={moreOptions} />
      </Row>
    </>
  ) : isCustomer && job.kind !== 'construction' && job.status === 'approved' ? (
    <Button title={`Pay ${formatMoney(job.quote?.totals.totalMinor)} securely`} icon="lock-outline" onPress={() => router.push(`/job/${id}/pay`)} />
  ) : undefined;

  return (
    <Screen
      edges={['top', 'bottom']}
      header={
        <ScreenHeader
          title={isCustomer && job.quote && ['quoted', 'negotiating'].includes(job.status) ? `Quote from ${job.technician.name.split(' ')[0]}` : job.category.name}
          subtitle={`Job #${job.short_code} · ${job.category.name}`}
          right={myTurn ? <Tag label="Your turn" tone="warning" /> : undefined}
        />
      }
      footer={footer}
    >
      {sheet.element}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Tag label={STATUS_LABEL[job.status] ?? job.status} tone={job.status === 'completed' ? 'success' : job.status === 'disputed' ? 'danger' : 'neutral'} />
          {job.is_fast_track ? <Tag label="Fast Track" tone="warning" icon="flash" /> : null}
        </Row>
        <T>{job.description}</T>
        <T v="small" muted>{job.address}</T>
        {job.action_required_reason && job.action_required_from !== 'none' ? (
          <T v="small" style={{ color: myTurn ? t.color.primary : t.color.textMuted }}>
            {myTurn ? 'Your turn: ' : `Waiting on ${job.action_required_from}: `}
            {job.action_required_reason}
          </T>
        ) : null}
      </Card>

      {/* Counterpart + released contacts (Section 8) */}
      <Card>
        {isCustomer ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading">{job.technician.name}</T>
            <Stars value={job.technician.ratingAvg} count={job.technician.ratingCount} />
          </Row>
        ) : (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="heading">{job.customer.name}</T>
              {job.customer.completionBadge ? <Tag label="Reliable customer" tone="success" /> : null}
            </Row>
            {job.customer.record && job.customer.record.ratings > 0 ? (
              <T v="small" muted>
                Agreement record ({job.customer.record.ratings}): on-site {job.customer.record.on_site} · access {job.customer.record.access} · paid on-platform {job.customer.record.paid_on_platform} · respectful {job.customer.record.respectful}
              </T>
            ) : (
              <T v="small" muted>No agreement ratings yet</T>
            )}
          </>
        )}
        {(isCustomer ? job.technician.phone : job.customer.phone) ? (
          <Button title="Call" kind="secondary" onPress={() => Linking.openURL(`tel:${isCustomer ? job.technician.phone : job.customer.phone}`)} />
        ) : (
          <T v="tiny" muted>Phone numbers unlock once the job is paid.</T>
        )}
        <Button title="Messages" kind="ghost" icon="chat-outline" onPress={() => router.push(`/job/${id}/chat`)} />
      </Card>

      {/* Live en-route tracking (Section 9) */}
      {isCustomer && job.technician.liveLocation ? (
        <MapView
          style={{ height: 200, borderRadius: t.radius.md }}
          region={{ latitude: job.technician.liveLocation.lat, longitude: job.technician.liveLocation.lng, latitudeDelta: 0.04, longitudeDelta: 0.04 }}
        >
          <Marker coordinate={{ latitude: job.technician.liveLocation.lat, longitude: job.technician.liveLocation.lng }} title={job.technician.name} />
        </MapView>
      ) : null}

      {job.kind === 'construction' ? (
        <>
          <ConstructionPanel jobId={id} viewer={job.viewer} jobStatus={job.status} />
          {isCustomer && job.status === 'completed' && !job.reviewSubmitted ? <Button title="Rate this project" onPress={() => router.push(`/job/${id}/rate`)} /> : null}
          {!isCustomer && job.status === 'completed' ? (
            <Button title="Rate this customer" kind="secondary" onPress={() => router.push({ pathname: '/job/[id]/rate', params: { id, as: 'technician' } })} />
          ) : null}
          {!isCustomer && job.status === 'requested' ? <Button title="Decline" kind="ghost" onPress={() => run('/decline', {})} /> : null}
        </>
      ) : (
        <>
        {job.quote ? (
          <PriceBreakdown
            quote={job.quote}
            viewer={job.viewer}
            awaitingApproval={reviewingQuote}
            onChallenge={isCustomer && ['quoted', 'negotiating'].includes(job.status) ? (lineId) => router.push({ pathname: '/job/[id]/challenge', params: { id, lineId } }) : undefined}
          />
        ) : null}
        {job.quote?.status === 'pending_exception' ? (
          <Banner text={isCustomer ? 'A parts markup above the usual cap is being reviewed by Handiwork-Deck. You will be notified when the quote is ready.' : 'Your cap exception request is with an admin.'} />
        ) : null}

        {/* ------------------------------ Customer actions ------------------------------ */}
        {reviewingQuote ? (
          <Note title="You're covered." text="When you pay, the money is held by Handiwork-Deck and only released after you confirm the job is done." />
        ) : null}
        {reviewingQuote && note === 'negotiate' ? (
          <Card tone="selected">
            <T v="heading">Offer a different labor price</T>
            <T v="small" muted>Labor is currently {formatMoney(job.quote!.totals.laborMinor)}. This offer only applies to this job.</T>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="Your labor offer (₦)" placeholderTextColor={t.color.textMuted} style={input} accessibilityLabel="Your labor offer in naira" />
            <Button title="Send offer" disabled={!amount} onPress={() => run('/labor-negotiation', { proposedLaborMinor: toMinor(amount) })} />
          </Card>
        ) : null}

        {isCustomer && negotiation?.status === 'countered' ? (
          <Card>
            <T v="heading">Technician countered</T>
            <T>Labor: {formatMoney(negotiation.counter_labor_minor)} (you offered {formatMoney(negotiation.proposed_labor_minor)}, standard {formatMoney(negotiation.standard_labor_minor)})</T>
            <Row>
              <View style={{ flex: 1 }}><Button title="Accept" onPress={() => run('/labor-negotiation/counter-response', { accept: true })} /></View>
              <View style={{ flex: 1 }}><Button title="Keep standard" kind="secondary" onPress={() => run('/labor-negotiation/counter-response', { accept: false })} /></View>
            </Row>
          </Card>
        ) : null}

        {isCustomer && openChallenge ? (
          <Card>
            <T v="heading">Price challenge {openChallenge.status === 'pending_evidence_review' ? 'under review' : 'sent'}</T>
            <T v="small" muted>
              {openChallenge.is_fast_track ? 'Fast Track: the technician must respond within 2 hours.' : 'The technician is expected to respond within 6 hours.'} If they don't, it is escalated automatically.
            </T>
            <Button title="Withdraw challenge" kind="ghost" onPress={() => run(`/price-challenges/${openChallenge.id}/withdraw`)} />
          </Card>
        ) : null}


        {isCustomer && job.status === 'awaiting_confirmation' ? (
          <Card>
            <T v="heading">Is the job done?</T>
            <Button title="Yes — release payment" onPress={() => run('/confirm')} loading={act.isPending} />
            <TextInput value={note} onChangeText={setNote} placeholder="If not, what's left to do?" placeholderTextColor={t.color.textMuted} style={input} />
            <Row>
              <View style={{ flex: 1 }}><Button title="Not finished" kind="secondary" disabled={note.length < 10} onPress={() => run('/reject-completion', { reason: note })} /></View>
              <View style={{ flex: 1 }}><Button title="Open dispute" kind="danger" disabled={note.length < 10} onPress={() => run('/reject-completion', { reason: note, dispute: true })} /></View>
            </Row>
          </Card>
        ) : null}

        {isCustomer && job.status === 'completed' && !job.reviewSubmitted ? <Button title="Rate this job" onPress={() => router.push(`/job/${id}/rate`)} /> : null}

        {/* ------------------------------ Technician actions ------------------------------ */}
        {!isCustomer && job.status === 'requested' ? (
          <Row>
            <View style={{ flex: 1 }}><Button title="Accept" onPress={() => run('/accept')} loading={act.isPending} /></View>
            <View style={{ flex: 1 }}><Button title="Decline" kind="secondary" onPress={() => run('/decline', {})} /></View>
          </Row>
        ) : null}

        {!isCustomer && (job.status === 'accepted' || (['quoted', 'negotiating'].includes(job.status) && job.action_required_reason?.startsWith('Revise'))) ? (
          <Button title={job.quote ? 'Revise quote' : 'Build quote'} onPress={() => router.push(`/job/${id}/quote`)} />
        ) : null}

        {!isCustomer && pendingLaborOnly ? (
          <Card>
            <T v="heading">Labor-only request</T>
            <T v="small" muted>
              {pendingLaborOnly.stance_at_request === 'decline_from_inception'
                ? 'You declared "decline from inception" for this category — declining has no rating impact.'
                : 'You accept labor-only work in this category. Declining counts toward your 90-day rejection limit.'}
            </T>
            <Row>
              <View style={{ flex: 1 }}><Button title="Accept" onPress={() => run('/labor-only/respond', { accept: true })} /></View>
              <View style={{ flex: 1 }}><Button title="Decline" kind="secondary" onPress={() => run('/labor-only/respond', { accept: false })} /></View>
            </Row>
          </Card>
        ) : null}

        {!isCustomer && openChallenge && openChallenge.status !== 'pending_evidence_review' ? (
          <Card style={openChallenge.is_fast_track ? { borderWidth: 2, borderColor: t.color.accent } : undefined}>
            <T v="heading">{openChallenge.is_fast_track ? '⚡ Urgent price challenge' : 'Price challenge'}</T>
            <T>
              The customer found this part for {formatMoney(openChallenge.claimed_unit_cost_minor)} at {openChallenge.seller_name ?? openChallenge.unlisted_seller_name}.
            </T>
            <Button title="Match the price" onPress={() => run(`/price-challenges/${openChallenge.id}/respond`, { response: 'match' })} />
            <TextInput value={note} onChangeText={setNote} multiline placeholder="Or explain the difference (quality, warranty, availability…)" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 70 }]} />
            <Row>
              <View style={{ flex: 1 }}><Button title="Explain" kind="secondary" disabled={note.length < 10} onPress={() => run(`/price-challenges/${openChallenge.id}/respond`, { response: 'explain', note })} /></View>
              <View style={{ flex: 1 }}><Button title="Hold firm" kind="secondary" disabled={note.length < 10} onPress={() => run(`/price-challenges/${openChallenge.id}/respond`, { response: 'hold', note })} /></View>
            </Row>
          </Card>
        ) : null}

        {!isCustomer && negotiation?.status === 'pending' ? (
          <Card>
            <T v="heading">Labor offer</T>
            <T>Customer offers {formatMoney(negotiation.proposed_labor_minor)} for labor (your rate: {formatMoney(negotiation.standard_labor_minor)}). This only affects this job.</T>
            <Button title="Accept offer" onPress={() => run('/labor-negotiation/respond', { action: 'accept' })} />
            <TextInput value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="Counter amount (₦)" placeholderTextColor={t.color.textMuted} style={input} />
            <Row>
              <View style={{ flex: 1 }}><Button title="Counter" kind="secondary" disabled={!amount} onPress={() => run('/labor-negotiation/respond', { action: 'counter', counterLaborMinor: toMinor(amount) })} /></View>
              <View style={{ flex: 1 }}><Button title="Keep my rate" kind="secondary" onPress={() => run('/labor-negotiation/respond', { action: 'decline' })} /></View>
            </Row>
          </Card>
        ) : null}

        {!isCustomer && job.status === 'funded' ? <Button title="I'm on my way" onPress={() => run('/en-route')} /> : null}
        {!isCustomer && job.status === 'en_route' ? <Button title="Start job" onPress={() => run('/start')} /> : null}
        {!isCustomer && job.status === 'in_progress' ? <Button title="Mark complete" onPress={() => run('/complete')} /> : null}
        {!isCustomer && job.status === 'completed' ? (
          <Button title="Rate this customer" kind="secondary" onPress={() => router.push({ pathname: '/job/[id]/rate', params: { id, as: 'technician' } })} />
        ) : null}
        </>
      )}

      <Button title="Refresh" kind="ghost" size="md" icon="refresh" onPress={() => refetch()} />
    </Screen>
  );
}
