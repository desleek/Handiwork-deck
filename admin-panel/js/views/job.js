import { api, errorText } from '../api.js';
import { dateTime, empty, esc, html, humanize, money, openDrawer, pct, statusTag, toast } from '../ui.js';

/**
 * Job context drawer: everything needed to decide a case — parties, status, money held,
 * the itemized quote or BOQ milestones, chat log (the dispute evidence), and the audit trail.
 * `extra` renders above the context (e.g. a dispute resolution form); `onAction` handles its clicks.
 */
export async function openJob(jobId, { extra = '', title, onAction } = {}) {
  const drawer = openDrawer(title ?? 'Job', html`<div class="loading">Loading…</div>`, onAction);
  let d;
  try {
    d = await api(`/admin/jobs/${jobId}`);
  } catch (err) {
    toast(errorText(err), 'crit');
    drawer.querySelector('.drawer-body').innerHTML = esc(html`<div class="banner crit">${errorText(err)}</div>`);
    return;
  }
  const j = d.job;
  const q = (d.quotes ?? []).find((x) => ['approved', 'submitted', 'pending_exception'].includes(x.status)) ?? d.quotes?.[0];
  const held = (d.payments ?? []).filter((p) => p.status === 'held').reduce((s, p) => s + Number(p.amount_minor), 0);

  drawer.querySelector('.drawer-head h2').textContent = `${title ?? 'Job'} · #${j.short_code}`;
  drawer.querySelector('.drawer-body').innerHTML = esc(html`
    ${extra}
    <section class="card">
      <div class="card-head"><h3>${j.category} · ${humanize(j.kind)}</h3>${statusTag(j.status)}</div>
      <dl class="kv small">
        <dt>Customer</dt><dd>${j.customer_name} <span class="faint">${j.customer_phone ?? ''}</span></dd>
        <dt>Technician</dt><dd>${j.technician_name} <span class="faint">${j.technician_phone ?? ''}</span></dd>
        <dt>Waiting on</dt><dd>${humanize(j.action_required_from)}${j.action_required_reason ? ` — ${j.action_required_reason}` : ''} <span class="faint">(since ${dateTime(j.action_required_since)})</span></dd>
        <dt>Address</dt><dd>${j.address}</dd>
        <dt>Description</dt><dd>${j.description}</dd>
        <dt>Held in escrow</dt><dd class="num"><strong>${money(held)}</strong></dd>
      </dl>
    </section>

    ${q
      ? html`<section class="card">
          <div class="card-head"><h3>Quote v${q.version}</h3>${statusTag(q.status)}</div>
          <div class="table-wrap"><table class="small">
            <thead><tr><th>Line</th><th class="right">Qty</th><th class="right">Unit</th><th class="right">Markup</th><th class="right">Total</th></tr></thead>
            <tbody>${(q.items ?? []).map((i) => html`<tr>
              <td>${i.kind === 'labor' ? '🛠 ' : ''}${i.description}</td><td class="right num">${Number(i.quantity)}</td>
              <td class="right num">${money(i.unit_cost_minor)}</td><td class="right num">${i.kind === 'part' ? `${pct(i.markup_bps)} · ${money(i.markup_minor)}` : '—'}</td>
              <td class="right num">${money(i.line_total_minor)}</td></tr>`)}</tbody>
          </table></div>
          <dl class="kv small" style="margin-top:10px">
            <dt>Labor</dt><dd class="num">${money(q.labor_total_minor)}</dd>
            <dt>Parts (base)</dt><dd class="num">${money(q.parts_base_total_minor)}</dd>
            <dt>Markup</dt><dd class="num">${money(q.markup_total_minor)}</dd>
            <dt>Customer total</dt><dd class="num"><strong>${money(q.customer_total_minor)}</strong></dd>
            <dt>Platform commission</dt><dd class="num">${money(q.platform_commission_minor)}</dd>
          </dl>
        </section>`
      : ''}

    ${d.consultation
      ? html`<section class="card"><div class="card-head"><h3>Site consultation</h3>${statusTag(d.consultation.status)}</div>
          <dl class="kv small"><dt>Fee</dt><dd class="num">${money(d.consultation.fee_minor)}</dd><dt>Agreed visit</dt><dd>${dateTime(d.consultation.visit_at)}</dd>
          <dt>Marked visited</dt><dd>${dateTime(d.consultation.visited_at)}</dd><dt>No-show reported</dt><dd>${dateTime(d.consultation.no_show_reported_at)}</dd></dl></section>`
      : ''}

    ${(d.milestones ?? []).length
      ? html`<section class="card"><div class="card-head"><h3>Milestones</h3></div><div class="table-wrap"><table class="small">
          <thead><tr><th>#</th><th>Milestone</th><th class="right">Labor</th><th class="right">Materials</th><th class="right">Total</th><th>Status</th></tr></thead>
          <tbody>${d.milestones.map((m) => html`<tr><td>${m.position}</td><td>${m.title}</td><td class="right num">${money(m.labor_minor)}</td>
            <td class="right num">${money(Number(m.parts_base_minor) + Number(m.markup_minor))}</td><td class="right num">${money(m.total_minor)}</td><td>${statusTag(m.status)}</td></tr>`)}</tbody>
        </table></div></section>`
      : ''}

    <section class="card"><div class="card-head"><h3>Payments</h3></div>
      ${(d.payments ?? []).length
        ? html`<div class="table-wrap"><table class="small"><thead><tr><th>Purpose</th><th>Channel</th><th class="right">Amount</th><th>Status</th><th>When</th></tr></thead>
            <tbody>${d.payments.map((p) => html`<tr><td>${humanize(p.purpose)}</td><td>${humanize(p.channel)} · ${p.provider}</td><td class="right num">${money(p.amount_minor)}</td><td>${statusTag(p.status)}</td><td>${dateTime(p.created_at)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="muted small">No payments yet.</div>`}
    </section>

    <section class="card"><div class="card-head"><h3>Chat log</h3><span class="tiny faint">${(d.messages ?? []).length} messages</span></div>
      ${(d.messages ?? []).length
        ? html`<div class="chat">${d.messages.map((m) => html`<div class="msg ${m.sender_role === 'technician' ? 'tech' : ''}">
            <div class="tiny faint">${m.sender_name ?? 'System'} · ${dateTime(m.created_at)}${m.channel === 'whatsapp' ? ' · via WhatsApp' : ''}${m.redacted ? ' · contact details hidden' : ''}</div>${m.body}</div>`)}</div>`
        : empty('No messages')}
    </section>

    <section class="card"><div class="card-head"><h3>Audit trail</h3></div>
      <ol class="timeline">${(d.events ?? []).map((e) => html`<li><span class="faint">${dateTime(e.created_at)}</span><span><strong>${humanize(e.type)}</strong>${e.actor_name ? html` <span class="muted">by ${e.actor_name}</span>` : ''}</span></li>`)}</ol>
    </section>`);
  return d;
}
