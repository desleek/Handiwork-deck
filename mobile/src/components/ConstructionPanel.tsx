import { useMutation, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { api, ApiError } from '../api/client';
import { chooseChannel, completeCheckout } from '../lib/checkout';
import { bpsToPct, formatMoney, toMinor } from '../lib/money';
import { queryClient } from '../lib/offline';
import { useTheme } from '../theme';
import { Banner, Button, Card, Divider, Row, T, Tag, useChoiceSheet } from './ui';

const MILESTONE_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  pending: 'Awaiting funding',
  funded: 'Funded — in progress',
  awaiting_confirmation: 'Ready for sign-off',
  released: 'Paid',
  disputed: 'In dispute',
  refunded: 'Refunded',
};

/** Visit-time shortcuts — quicker than a date picker for the common cases. */
function visitOptions() {
  const at = (days: number, h: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  return [at(1, 9), at(1, 14), at(2, 9), at(2, 14), at(3, 10), at(7, 10)];
}

/**
 * Construction & plant erection flow (Section 17) inside the job screen:
 * site consultation → Bill of Quantities → milestone payments.
 */
export function ConstructionPanel({ jobId, viewer, jobStatus }: { jobId: string; viewer: 'customer' | 'technician' | 'admin'; jobStatus: string }) {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const { data } = useQuery({ queryKey: ['construction', jobId], queryFn: () => api(`/jobs/${jobId}/construction`) });
  const [fee, setFee] = useState('');
  const [visit, setVisit] = useState<Date | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const refresh = () => ['construction', 'job', 'jobs', 'wallet'].forEach((k) => queryClient.invalidateQueries({ queryKey: k === 'construction' || k === 'job' ? [k, jobId] : [k] }));
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api(`/jobs/${jobId}/construction${path}`, { body: body ?? {} }),
    onSuccess: refresh,
    onError: (e: ApiError) => Alert.alert('Not done', e.message),
  });
  const pay = async (path: string, label: string) => {
    const channel = await chooseChannel(sheet.open, label);
    if (!channel) return;
    try {
      const p = await api(`/jobs/${jobId}/construction${path}`, { body: { channel } });
      await completeCheckout(p);
    } catch (e: any) {
      Alert.alert('Payment not started', e.message);
    }
    refresh();
  };

  if (!data) return null;
  const c = data.consultation;
  const boq = data.boq;
  const isCustomer = viewer === 'customer';
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  return (
    <View style={{ gap: t.space(3) }}>
      {sheet.element}

      {/* ---------------------------------------------------------- Step 1: site consultation */}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">1 · Site consultation</T>
          {c ? <Tag label={c.status.replace(/_/g, ' ')} tone={c.status === 'visited' ? 'success' : 'neutral'} /> : null}
        </Row>
        {!c && isCustomer ? <T muted>Waiting for the technician to quote an inspection fee and visit time.</T> : null}
        {(!c || c.status === 'quoted') && !isCustomer && ['requested', 'accepted'].includes(jobStatus) ? (
          <View style={{ gap: t.space(2) }}>
            <T v="small" muted>
              Inspection & measurement fee, between {formatMoney(data.consultancyBand.minMinor)} and {formatMoney(data.consultancyBand.maxMinor)}.
            </T>
            <TextInput value={fee} onChangeText={setFee} keyboardType="numeric" placeholder={c ? `Current: ${formatMoney(c.fee_minor)}` : 'Fee (₦)'} placeholderTextColor={t.color.textMuted} style={input} />
            <T v="small" muted>Visit time</T>
            <Row style={{ flexWrap: 'wrap' }}>
              {visitOptions().map((d) => (
                <Pressable key={d.toISOString()} onPress={() => setVisit(d)} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 100, backgroundColor: visit?.getTime() === d.getTime() ? t.color.primary : t.color.surfaceAlt }}>
                  <T v="small" style={{ color: visit?.getTime() === d.getTime() ? t.color.primaryText : t.color.text }}>{d.toLocaleString([], { weekday: 'short', hour: 'numeric' })}</T>
                </Pressable>
              ))}
            </Row>
            <Button title={c ? 'Update quote' : 'Send quote'} disabled={!fee || !visit} loading={act.isPending} onPress={() => act.mutate({ path: '/consultation/quote', body: { feeMinor: toMinor(fee), proposedVisitAt: visit!.toISOString() } })} />
          </View>
        ) : null}
        {c ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <T muted>Fee</T>
              <T style={t.font.money}>{formatMoney(c.fee_minor)}</T>
            </Row>
            {c.visit_at ? <T muted>Visit: {new Date(c.visit_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</T> : null}
            {c.note ? <T v="small">{c.note}</T> : null}
          </>
        ) : null}
        {c?.status === 'quoted' && isCustomer ? (
          <>
            <T v="small" muted>Non-refundable once the visit happens. Refunded if the technician doesn't show up.</T>
            <Button title={`Pay ${formatMoney(c.fee_minor)} to book the visit`} onPress={() => pay('/consultation/pay', 'Pay the site visit fee with')} />
          </>
        ) : null}
        {c?.status === 'paid' && !isCustomer ? <Button title="Mark visit done" loading={act.isPending} onPress={() => act.mutate({ path: '/consultation/visited' })} /> : null}
        {c?.status === 'paid' && isCustomer ? (
          <Button
            title="Technician didn't come"
            kind="ghost"
            onPress={() =>
              Alert.alert('Report a no-show?', 'If the technician missed the agreed visit, your fee is refunded.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Report', style: 'destructive', onPress: () => act.mutate({ path: '/consultation/no-show' }) },
              ])
            }
          />
        ) : null}
        {c?.status === 'visited' && !boq && !isCustomer ? <Button title="Build the Bill of Quantities" onPress={() => router.push(`/job/${jobId}/boq`)} /> : null}
        {c?.status === 'visited' && !boq && isCustomer ? <T muted>Visit done. Your technician is preparing the Bill of Quantities.</T> : null}
      </Card>

      {/* ---------------------------------------------------------- Step 2–3: BOQ */}
      {boq ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading">2 · Bill of Quantities v{boq.version}</T>
            <Tag label={boq.status} tone={boq.status === 'approved' ? 'success' : boq.status === 'negotiating' ? 'warning' : 'neutral'} />
          </Row>
          {boq.status === 'draft' && !isCustomer ? <Banner text="Draft from an uploaded file — review it and submit to send it to the customer." /> : null}
          {boq.milestones.map((m: any) => (
            <View key={m.id} style={{ gap: 4 }}>
              <T v="small" muted>MILESTONE {m.position}: {m.title.toUpperCase()}</T>
              {boq.items
                .filter((i: any) => i.milestone_position === m.position)
                .map((i: any) => (
                  <View key={i.id} style={{ gap: 2 }}>
                    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <View style={{ flex: 1 }}>
                        <T>{i.description}</T>
                        <T v="tiny" muted>
                          {Number(i.quantity)} {i.unit} × {formatMoney(i.unit_rate_minor)} · {i.kind === 'labor' ? 'Labour' : `Materials${i.markup_bps ? ` + ${bpsToPct(i.markup_bps)} markup (${formatMoney(i.markup_minor)})` : ''}`}
                        </T>
                        {i.customer_comment ? <T v="tiny" style={{ color: t.color.promoted }}>Customer: {i.customer_comment}{i.proposed_rate_minor ? ` (proposes ${formatMoney(i.proposed_rate_minor)})` : ''}</T> : null}
                      </View>
                      <T style={t.font.money}>{formatMoney(i.line_total_minor)}</T>
                    </Row>
                    {isCustomer && boq.status === 'submitted' ? (
                      openComment === i.id ? (
                        <TextInput autoFocus value={comments[i.id] ?? ''} onChangeText={(v) => setComments((x) => ({ ...x, [i.id]: v }))} onBlur={() => setOpenComment(null)} placeholder="Comment or suggested rate…" placeholderTextColor={t.color.textMuted} style={input} />
                      ) : (
                        <Pressable onPress={() => setOpenComment(i.id)} hitSlop={6}>
                          <T v="tiny" style={{ color: t.color.link }}>{comments[i.id] ? `Your comment: ${comments[i.id]}` : 'Comment on this line'}</T>
                        </Pressable>
                      )
                    ) : null}
                  </View>
                ))}
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="small" muted>Milestone total</T>
                <T v="small" style={t.font.money}>{formatMoney(m.total_minor)}</T>
              </Row>
              <Divider />
            </View>
          ))}
          <Row style={{ justifyContent: 'space-between' }}><T muted>Labour</T><T style={t.font.money}>{formatMoney(boq.labor_total_minor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Materials (base cost)</T><T style={t.font.money}>{formatMoney(boq.materials_total_minor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Materials markup</T><T style={t.font.money}>{formatMoney(boq.markup_total_minor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="heading">Project total</T><T v="heading" style={t.font.money}>{formatMoney(boq.grand_total_minor)}</T></Row>
          {boq.notes ? <T v="small" muted>{boq.notes}</T> : null}

          {isCustomer && boq.status === 'submitted' ? (
            <View style={{ gap: t.space(2) }}>
              <Button title="Approve BOQ and milestones" loading={act.isPending} onPress={() => act.mutate({ path: '/boq/respond', body: { action: 'approve' } })} />
              <TextInput value={note} onChangeText={setNote} multiline placeholder="Overall note for the technician (optional)" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 60 }]} />
              <Button
                title="Request changes"
                kind="secondary"
                disabled={!note && Object.values(comments).every((v) => !v.trim())}
                onPress={() =>
                  act.mutate({
                    path: '/boq/respond',
                    body: {
                      action: 'negotiate',
                      note: note || undefined,
                      comments: Object.entries(comments)
                        .filter(([, v]) => v.trim().length >= 2)
                        .map(([itemId, comment]) => ({ itemId, comment: comment.trim(), proposedRateMinor: /^\s*₦?\s*[\d,]+\s*$/.test(comment) ? toMinor(comment) : undefined })),
                    },
                  })
                }
              />
              <Button
                title="Decline project"
                kind="ghost"
                onPress={() =>
                  Alert.alert('Decline this BOQ?', 'The project will close. The site visit fee is not refunded.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Decline', style: 'destructive', onPress: () => act.mutate({ path: '/boq/respond', body: { action: 'reject', note: note || undefined } }) },
                  ])
                }
              />
            </View>
          ) : null}
          {!isCustomer && boq.status === 'negotiating' ? (
            <>
              {boq.customer_note ? <Banner text={`Customer: ${boq.customer_note}`} /> : null}
              <Button title="Revise BOQ" onPress={() => router.push(`/job/${jobId}/boq`)} />
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- Step 4: milestones */}
      {boq?.status === 'approved' ? (
        <Card>
          <T v="heading">3 · Milestone payments</T>
          <T v="small" muted>Each milestone is paid into escrow before work starts and released when you sign it off.</T>
          {boq.milestones.map((m: any, idx: number) => {
            const prevDone = boq.milestones.slice(0, idx).every((p: any) => ['funded', 'awaiting_confirmation', 'released'].includes(p.status));
            return (
              <View key={m.id} style={{ gap: 6, paddingVertical: 4 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T style={{ flex: 1 }}>{m.position}. {m.title}</T>
                  <T style={t.font.money}>{formatMoney(m.total_minor)}</T>
                </Row>
                <Tag label={MILESTONE_LABEL[m.status] ?? m.status} tone={m.status === 'released' ? 'success' : m.status === 'disputed' ? 'danger' : 'neutral'} />
                {isCustomer && m.status === 'pending' && prevDone ? <Button title={`Fund ${formatMoney(m.total_minor)}`} onPress={() => pay(`/milestones/${m.id}/fund`, `Fund "${m.title}" with`)} /> : null}
                {isCustomer && m.status === 'awaiting_confirmation' ? (
                  <View style={{ gap: t.space(2) }}>
                    <Button title="Sign off & release payment" onPress={() => act.mutate({ path: `/milestones/${m.id}/confirm` })} />
                    <TextInput value={note} onChangeText={setNote} multiline placeholder="Not right? Describe the problem to open a dispute" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 60 }]} />
                    <Button title="Open dispute" kind="secondary" disabled={note.trim().length < 10} onPress={() => act.mutate({ path: `/milestones/${m.id}/dispute`, body: { reason: note.trim() } })} />
                  </View>
                ) : null}
                {!isCustomer && m.status === 'funded' ? <Button title="Mark milestone complete" kind="secondary" onPress={() => act.mutate({ path: `/milestones/${m.id}/complete` })} /> : null}
                {!isCustomer ? <T v="tiny" muted>You receive {formatMoney(m.technician_net_minor)} after platform fees on this milestone.</T> : null}
              </View>
            );
          })}
        </Card>
      ) : null}
    </View>
  );
}
