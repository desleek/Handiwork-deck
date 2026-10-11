import { api, errorText } from '../api.js';
import { ago, closeDrawer, date, dateTime, empty, esc, formDialog, html, humanize, money, tag, toast } from '../ui.js';
import { openJob } from './job.js';

const TABS = [
  { id: 'jobs', label: 'Jobs & milestones' },
  { id: 'visits', label: 'Site visits' },
  { id: 'supplies', label: 'Supplies orders' },
];

const TYPE_LABEL = { job: 'Job (line items)', milestone: 'Construction milestone', consultation: 'Site visit no-show' };

/**
 * One place for every dispute type. Each opens a case drawer with the full job context (chat log,
 * quote / BOQ, payments, audit trail) and a resolution form for that type.
 */
export async function renderDisputes(view, ctx) {
  const tab = TABS.find((t) => t.id === ctx.sub) ?? TABS[0];
  const [disputes, orders] = await Promise.all([api('/admin/disputes'), api('/admin/supplies/orders', { query: { status: 'disputed' } })]);
  if (!ctx.isCurrent()) return;
  const jobDisputes = disputes.filter((d) => d.dispute_type !== 'consultation');
  const visitDisputes = disputes.filter((d) => d.dispute_type === 'consultation');
  const counts = { jobs: jobDisputes.length, visits: visitDisputes.length, supplies: orders.length };

  const disputeTable = (rows) =>
    rows.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>Case</th><th>Raised by</th><th>Reason</th><th class="right">At stake</th><th>Age</th><th></th></tr></thead>
          <tbody>${rows.map((d) => html`<tr>
            <td><strong>#${d.short_code}</strong> ${tag(TYPE_LABEL[d.dispute_type])}<div class="small muted">${d.customer_name} ↔ ${d.technician_name}</div>
              ${d.milestone_title ? html`<div class="small">Milestone ${d.milestone_position}: ${d.milestone_title}</div>` : ''}
              ${d.line_description ? html`<div class="small">Line: ${d.line_description} (${money(d.line_total_minor)})</div>` : ''}</td>
            <td>${d.raised_by_name}<div class="tiny faint">${humanize(d.raised_by_role)}</div></td>
            <td style="max-width:340px">${d.reason}</td>
            <td class="right num"><strong>${money(d.held_minor ?? d.milestone_total_minor ?? d.consultation_fee_minor)}</strong></td>
            <td class="num">${ago(d.created_at)}</td>
            <td><button class="primary small" data-act="open" data-id="${d.id}">Open case</button></td>
          </tr>`)}</tbody></table></div>`
      : empty('No open disputes here', 'Disputes raised by customers or technicians appear here.');

  const body =
    tab.id === 'supplies'
      ? orders.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Order</th><th>Buyer ↔ Seller</th><th>Items</th><th class="right">Total</th><th>Dispute</th><th></th></tr></thead>
            <tbody>${orders.map((o) => html`<tr>
              <td><strong>#${o.short_code}</strong><div class="tiny faint">${date(o.created_at)} · ${humanize(o.fulfilment)}</div></td>
              <td>${o.buyer_name} ↔ ${o.seller_name}</td>
              <td class="small">${(o.items ?? []).map((i) => html`<div>${i.quantity} × ${i.name}</div>`)}</td>
              <td class="right num"><strong>${money(o.total_minor)}</strong><div class="tiny faint">fee ${money(o.commission_minor)}</div></td>
              <td class="small" style="max-width:300px">${(o.note ?? '').split('\n').filter((l) => l.startsWith('Dispute:')).map((l) => html`<div>${l.replace('Dispute: ', '')}</div>`)}</td>
              <td><button class="primary small" data-act="order" data-id="${o.id}">Resolve…</button></td>
            </tr>`)}</tbody></table></div>`
        : empty('No disputed orders', 'Supplies orders the buyer has disputed appear here.')
      : disputeTable(tab.id === 'visits' ? visitDisputes : jobDisputes);

  view.innerHTML = esc(html`
    <div class="page-head"><div><h1>Disputes</h1><div class="muted">Money stays in escrow until you decide.</div></div></div>
    <nav class="tabs" aria-label="Dispute types">${TABS.map((t) => html`<a href="#/disputes/${t.id}" aria-current="${t.id === tab.id ? 'page' : 'false'}">${t.label}${counts[t.id] ? html` <span class="badge-count hot">${counts[t.id]}</span>` : ''}</a>`)}</nav>
    ${body}`);

  const done = async (msg) => {
    toast(msg);
    closeDrawer();
    await ctx.refreshCounts();
    await ctx.refresh();
  };

  view.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'open') {
      const d = disputes.find((x) => x.id === el.dataset.id);
      await openCase(d, done);
    }
    if (el.dataset.act === 'order') {
      const o = orders.find((x) => x.id === el.dataset.id);
      const v = await formDialog({
        title: `Resolve order #${o.short_code}`,
        intro: `${money(o.total_minor)} is held. ${o.buyer_name} vs ${o.seller_name}.`,
        fields: [
          { name: 'outcome', label: 'Outcome', type: 'select', value: 'refund', options: [
            { value: 'refund', label: 'Full refund to buyer' },
            { value: 'partial', label: 'Partial refund, rest to seller' },
            { value: 'release', label: 'Release payment to seller' },
          ] },
          { name: 'refund', label: 'Refund amount (partial only)', type: 'money' },
          { name: 'note', label: 'Resolution note', type: 'textarea', required: true, min: 5 },
        ],
        confirm: 'Resolve',
      });
      if (!v) return;
      if (v.outcome === 'partial' && !v.refund) return toast('Enter the refund amount for a partial refund', 'crit');
      try {
        await api(`/admin/supplies/orders/${o.id}/resolve`, { body: { outcome: v.outcome, refundMinor: v.outcome === 'partial' ? v.refund : undefined, note: v.note } });
        await done('Order dispute resolved');
      } catch (err) {
        toast(errorText(err), 'crit');
      }
    }
  };
}

async function openCase(d, done) {
  const resolution = {
    job: html`
      <section class="card stack">
        <h3>Resolve</h3>
        <div class="muted small">Full refund cancels the job. Release pays the technician through the normal split. A split refunds part and releases the rest.</div>
        <label class="field">Outcome<select name="outcome">
          <option value="resolved_technician">Release to technician</option>
          <option value="split">Split — partial refund to customer</option>
          <option value="resolved_customer">Full refund to customer</option></select></label>
        <label class="field">Refund amount (₦, split only)<input name="refund" type="number" min="0" step="any" /></label>
        <label class="field">Resolution (shared with both parties)<textarea name="note"></textarea></label>
        <div class="row"><button class="primary" data-resolve>Resolve dispute</button></div>
      </section>`,
    milestone: html`
      <section class="card stack">
        <h3>Resolve milestone ${d.milestone_position}: ${d.milestone_title}</h3>
        <div class="muted small">${money(d.held_minor ?? d.milestone_total_minor)} is held for this milestone.</div>
        <label class="field">Outcome<select name="outcome">
          <option value="release">Release to technician</option>
          <option value="partial">Partial refund, rest to technician</option>
          <option value="refund">Full refund to customer</option></select></label>
        <label class="field">Refund amount (₦, partial only)<input name="refund" type="number" min="0" step="any" /></label>
        <label class="check"><input type="checkbox" name="endProject" /> End the project (full refund only — cancels unfunded milestones)</label>
        <label class="field">Resolution note<textarea name="note"></textarea></label>
        <div class="row"><button class="primary" data-resolve>Resolve milestone</button></div>
      </section>`,
    consultation: html`
      <section class="card stack">
        <h3>Site visit dispute</h3>
        <dl class="kv small"><dt>Agreed visit</dt><dd>${dateTime(d.visit_at)}</dd><dt>Technician marked visited</dt><dd>${dateTime(d.visited_at)}</dd><dt>Customer reported no-show</dt><dd>${dateTime(d.no_show_reported_at)}</dd><dt>Fee</dt><dd class="num">${money(d.consultation_fee_minor)}</dd></dl>
        <label class="field">Decision<select name="outcome">
          <option value="release">Visit happened — pay the technician (BOQ continues)</option>
          <option value="refund">No-show — refund the customer (job closes)</option></select></label>
        <label class="field">Resolution note<textarea name="note"></textarea></label>
        <div class="row"><button class="primary" data-resolve>Resolve</button></div>
      </section>`,
  }[d.dispute_type];

  const caseHtml = html`<div class="banner"><strong>${TYPE_LABEL[d.dispute_type]}</strong> raised by ${d.raised_by_name} ${ago(d.created_at)}: “${d.reason}”</div>${resolution}`;
  await openJob(d.job_id, {
    title: 'Dispute',
    extra: caseHtml,
    onAction: async (e) => {
      if (!e.target.closest('[data-resolve]')) return;
      const root = e.target.closest('.drawer');
      const val = (n) => root.querySelector(`[name="${n}"]`);
      const outcome = val('outcome').value;
      const note = val('note').value.trim();
      const refund = val('refund')?.value ? Math.round(Number(val('refund').value) * 100) : undefined;
      if (note.length < 5) return toast('Write a resolution note (at least 5 characters)', 'crit');
      try {
        if (d.dispute_type === 'job') {
          if (outcome === 'split' && !refund) return toast('Enter the refund amount for a split', 'crit');
          await api(`/admin/disputes/${d.id}/resolve`, { body: { outcome, refundMinor: outcome === 'split' ? refund : 0, resolution: note } });
        } else if (d.dispute_type === 'milestone') {
          if (outcome === 'partial' && !refund) return toast('Enter the refund amount for a partial refund', 'crit');
          await api(`/admin/construction/milestones/${d.milestone_id}/resolve`, { body: { outcome, refundMinor: outcome === 'partial' ? refund : undefined, endProject: outcome === 'refund' && val('endProject').checked, note } });
        } else {
          await api(`/admin/construction/consultations/${d.job_id}/resolve`, { body: { refund: outcome === 'refund', note } });
        }
        await done('Dispute resolved');
      } catch (err) {
        toast(errorText(err), 'crit');
      }
    },
  });
}

