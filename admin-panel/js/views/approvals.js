import { api, errorText } from '../api.js';
import { ago, confirmDialog, date, empty, esc, formDialog, html, humanize, int, link, money, pct, safeUrl, statusTag, tag, toast } from '../ui.js';
import { openJob } from './job.js';

const TABS = [
  { id: 'technicians', label: 'Technicians', count: (c) => c.technicians + c.certifications + c.portfolio },
  { id: 'demand-notices', label: 'Cap exceptions', count: (c) => c.cap_exceptions },
  { id: 'price-evidence', label: 'Price challenges', count: (c) => c.price_challenges },
  { id: 'ads', label: 'Ads', count: (c) => c.ads },
  { id: 'products', label: 'Supplies listings', count: (c) => c.products },
  { id: 'reports', label: 'Reports', count: (c) => c.reports },
  { id: 'appeals', label: 'Appeals', count: (c) => c.appeals },
  { id: 'fault-reviews', label: 'Fault reviews', count: (c) => c.fault_reviews },
  { id: 'rate-anomalies', label: 'Rate anomalies', count: (c) => c.multiplier_anomalies },
];

/** Run an action with feedback, then re-render the view and refresh sidebar counts. */
export async function run(ctx, fn, success) {
  try {
    await fn();
    if (success) toast(success);
    await ctx.refreshCounts();
    await ctx.refresh();
  } catch (err) {
    toast(errorText(err), 'crit');
  }
}

export async function renderApprovals(view, ctx) {
  const tab = TABS.find((t) => t.id === ctx.sub) ?? TABS[0];
  const counts = await ctx.refreshCounts();
  const body = await SECTIONS[tab.id](ctx);
  if (!ctx.isCurrent()) return;
  view.innerHTML = esc(html`
    <div class="page-head"><div><h1>Approvals</h1><div class="muted">Everything waiting for an admin decision.</div></div></div>
    <nav class="tabs" aria-label="Approval queues">
      ${TABS.map((t) => {
        const n = counts ? t.count(counts) : 0;
        return html`<a href="#/approvals/${t.id}" aria-current="${t.id === tab.id ? 'page' : 'false'}">${t.label}${n ? html` <span class="badge-count">${n}</span>` : ''}</a>`;
      })}
    </nav>
    <div id="section">${body.html}</div>`);
  view.onclick = (e) => {
    const el = e.target.closest('[data-act]');
    if (el) body.on(el.dataset.act, el.dataset, el);
  };
}

// ============================================================================ sections
const SECTIONS = {
  // ---------------------------------------------------------------- technician verification
  async technicians(ctx) {
    const rows = await api('/admin/technicians', { query: { status: 'pending' } });
    const withPendingMedia = (await api('/admin/technicians', { query: { status: 'verified' } })).filter(
      (t) => (t.certifications ?? []).some((c) => c.status === 'pending') || (t.portfolio ?? []).some((p) => p.moderation_status === 'pending'),
    );
    const all = [...rows, ...withPendingMedia];
    const card = (t) => html`
      <div class="card stack">
        <div class="row spread">
          <div><h3>${t.full_name}</h3><div class="small muted">${t.phone_e164 ?? ''} ${t.email ? `· ${t.email}` : ''} · joined ${date(t.created_at)}</div></div>
          ${statusTag(t.verification_status)}
        </div>
        <div class="row wrap">
          ${t.id_document_url ? link(t.id_document_url, 'View ID document ↗') : tag('No ID uploaded', 'warn')}
          ${t.rating_avg ? html`<span class="small muted">· ${Number(t.rating_avg).toFixed(2)}★ (${t.rating_count})</span>` : ''}
        </div>
        ${(t.certifications ?? []).length
          ? html`<div class="stack tight"><h3>Certifications</h3>${t.certifications.map((c) => html`
              <div class="row spread"><span>${link(c.file_url, c.title)} ${c.issuer ? html`<span class="muted small">— ${c.issuer}</span>` : ''}</span>
                <span class="row">${statusTag(c.status)}${c.status === 'pending' ? html`
                  <button class="small" data-act="cert" data-id="${c.id}" data-decision="verified">Approve</button>
                  <button class="small" data-act="cert" data-id="${c.id}" data-decision="rejected">Reject</button>` : ''}</span></div>`)}</div>`
          : ''}
        ${(t.portfolio ?? []).length
          ? html`<div class="stack tight"><h3>Portfolio</h3><div class="thumbs">${t.portfolio.map((p) => html`
              <figure><a href="${safeUrl(p.url)}" target="_blank" rel="noopener"><img src="${safeUrl(p.url)}" alt="Portfolio image ${p.position}" loading="lazy" /></a>
                ${p.moderation_status === 'pending'
                  ? html`<span class="row"><button class="small" data-act="photo" data-id="${p.id}" data-decision="approved">✓</button><button class="small" data-act="photo" data-id="${p.id}" data-decision="rejected">✕</button></span>`
                  : statusTag(p.moderation_status)}</figure>`)}</div></div>`
          : ''}
        ${t.verification_status === 'pending'
          ? html`<div class="row"><button class="primary" data-act="verify" data-id="${t.id}" data-name="${t.full_name}">Verify technician</button>
              <button data-act="reject" data-id="${t.id}" data-name="${t.full_name}">Reject…</button></div>`
          : ''}
      </div>`;
    return {
      html: all.length ? html`${all.map(card)}` : empty('No technicians waiting', 'New sign-ups and new documents appear here.'),
      on: async (act, d) => {
        if (act === 'verify') return run(ctx, () => api(`/admin/technicians/${d.id}/verification`, { body: { decision: 'verified' } }), `${d.name} verified`);
        if (act === 'reject') {
          const v = await formDialog({ title: `Reject ${d.name}?`, intro: 'They will be told what to fix and can resubmit.', fields: [{ name: 'note', label: 'What needs fixing', type: 'textarea', required: true, min: 5 }], confirm: 'Reject', tone: 'danger' });
          if (v) return run(ctx, () => api(`/admin/technicians/${d.id}/verification`, { body: { decision: 'rejected', note: v.note } }), 'Rejected');
        }
        if (act === 'cert') return run(ctx, () => api(`/admin/certifications/${d.id}`, { body: { decision: d.decision } }), 'Certification updated');
        if (act === 'photo') return run(ctx, () => api(`/admin/portfolio/${d.id}/moderate`, { body: { decision: d.decision } }), 'Photo updated');
      },
    };
  },

  // ---------------------------------------------------------------- Demand Notices (Section 5a)
  async 'demand-notices'(ctx) {
    const rows = await api('/admin/cap-exceptions');
    return {
      html: rows.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Job</th><th>Technician</th><th>Part</th><th class="right">Base cost</th><th class="right">Requested markup</th><th>Reason & evidence</th><th></th></tr></thead>
            <tbody>${rows.map((r) => html`<tr>
              <td><button class="ghost" data-act="job" data-id="${r.job_id}">#${r.short_code}</button><div class="tiny faint">${ago(r.created_at)}</div></td>
              <td>${r.technician_name}</td>
              <td>${r.description}<div class="tiny faint">qty ${Number(r.quantity)}</div></td>
              <td class="right num">${money(r.unit_cost_minor * Number(r.quantity))}</td>
              <td class="right num"><strong>${pct(r.requested_markup_bps)}</strong><div class="tiny faint">≈ ${money(Math.round((r.unit_cost_minor * Number(r.quantity) * r.requested_markup_bps) / 10000))}</div></td>
              <td style="max-width:320px">${r.reason}<div class="row wrap tiny">${(r.evidence_urls ?? []).map((u, i) => link(u, `Evidence ${i + 1} ↗`))}</div></td>
              <td><div class="stack tight">
                <button class="primary small" data-act="approve" data-id="${r.id}" data-bps="${r.requested_markup_bps}">Approve…</button>
                <button class="small" data-act="decline" data-id="${r.id}">Decline…</button></div></td>
            </tr>`)}</tbody></table></div>`
        : empty('No cap exceptions waiting', 'Quotes with a parts markup above the cap appear here with the supplier evidence.'),
      on: async (act, d) => {
        if (act === 'job') return openJob(d.id);
        if (act === 'approve') {
          const v = await formDialog({
            title: 'Approve markup exception',
            intro: `Allows ${pct(d.bps)} markup on this line of this quote only.`,
            fields: [
              { name: 'note', label: 'Note to technician (optional)', type: 'textarea' },
              { name: 'permanent', label: 'Also grant this technician a permanent higher cap', type: 'checkbox' },
              { name: 'permanentPct', label: 'Permanent cap (%)', type: 'number', min: 0, hint: 'Only used if the box above is ticked' },
            ],
            confirm: 'Approve',
          });
          if (v) return run(ctx, () => api(`/admin/cap-exceptions/${d.id}/decide`, { body: { approve: true, note: v.note || undefined, grantPermanentBps: v.permanent && v.permanentPct ? Math.round(v.permanentPct * 100) : undefined } }), 'Exception approved');
        }
        if (act === 'decline') {
          const v = await formDialog({ title: 'Decline markup exception', intro: 'The technician will be asked to revise the quote.', fields: [{ name: 'note', label: 'Reason', type: 'textarea', required: true, min: 5 }], confirm: 'Decline', tone: 'danger' });
          if (v) return run(ctx, () => api(`/admin/cap-exceptions/${d.id}/decide`, { body: { approve: false, note: v.note } }), 'Exception declined');
        }
      },
    };
  },

  // ---------------------------------------------------------------- price challenges (6c)
  async 'price-evidence'(ctx) {
    const rows = (await api('/admin/price-challenges')).filter((r) => r.status !== 'open' || Number(r.hours_open) > 6);
    return {
      html: rows.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th></th><th>Job</th><th>Part</th><th class="right">Quoted</th><th class="right">Customer found</th><th>Seller & evidence</th><th>Open for</th><th></th></tr></thead>
            <tbody>${rows.map((r) => html`<tr>
              <td>${r.is_fast_track ? tag('⚡ Fast Track', 'urgent') : ''} ${statusTag(r.status)}</td>
              <td><button class="ghost" data-act="job" data-id="${r.job_id}">#${r.short_code}</button></td>
              <td>${r.description}</td>
              <td class="right num">${money(r.unit_cost_minor)}</td>
              <td class="right num"><strong>${money(r.claimed_unit_cost_minor)}</strong><div class="tiny faint">−${Math.round((1 - r.claimed_unit_cost_minor / r.unit_cost_minor) * 100)}%</div></td>
              <td>${r.seller_name ?? html`<em>${r.unlisted_seller_name}</em> ${tag('unlisted', 'warn')}`}<div>${link(r.evidence_url, 'Evidence ↗')}</div></td>
              <td class="num">${Math.round(Number(r.hours_open))}h</td>
              <td><div class="stack tight">
                ${r.status === 'pending_evidence_review'
                  ? html`<button class="primary small" data-act="accept" data-id="${r.id}">Accept evidence</button><button class="small" data-act="reject" data-id="${r.id}">Reject…</button>`
                  : html`<button class="small" data-act="nudge" data-id="${r.id}">Nudge technician…</button>`}
              </div></td></tr>`)}</tbody></table></div>
            <p class="small muted">Escalated challenges resolve automatically at the final deadline (Hour 72, or Hour 24 for Fast Track). Accepting unlisted-seller evidence adds the seller to the registry as provisionally verified.</p>`
        : empty('Nothing escalated', 'Escalated challenges and evidence from unlisted sellers appear here. Fast Track cases are listed first.'),
      on: async (act, d) => {
        if (act === 'job') return openJob(d.id);
        if (act === 'accept') return run(ctx, () => api(`/admin/price-challenges/${d.id}/evidence`, { body: { accept: true } }), 'Evidence accepted — technician notified');
        if (act === 'reject') {
          const v = await formDialog({ title: 'Reject price evidence', fields: [{ name: 'note', label: 'Reason (shown to the customer)', type: 'textarea', required: true, min: 5 }], confirm: 'Reject', tone: 'danger' });
          if (v) return run(ctx, () => api(`/admin/price-challenges/${d.id}/evidence`, { body: { accept: false, note: v.note } }), 'Evidence rejected');
        }
        if (act === 'nudge') {
          const v = await formDialog({
            title: 'Nudge the technician',
            fields: [
              { name: 'whatsapp', label: 'WhatsApp', type: 'checkbox', value: true },
              { name: 'email', label: 'Email', type: 'checkbox', value: true },
              { name: 'push', label: 'Push notification', type: 'checkbox', value: true },
            ],
            confirm: 'Send',
          });
          const channels = v ? ['whatsapp', 'email', 'push'].filter((c) => v[c]) : [];
          if (channels.length) return run(ctx, () => api(`/admin/price-challenges/${d.id}/nudge`, { body: { channels } }), 'Technician nudged');
        }
      },
    };
  },

  // ---------------------------------------------------------------- ads (Section 12)
  async ads(ctx) {
    const rows = await api('/admin/ads', { query: { status: 'pending_review' } });
    return {
      html: rows.length
        ? html`${rows.map((c) => {
            const cr = (c.creatives ?? [])[0] ?? {};
            return html`<div class="card stack">
              <div class="row spread"><div><h3>${c.name}</h3><div class="small muted">${c.company_name ?? c.advertiser_name ?? 'Admin-managed'} · ${humanize(c.placement)} · ${date(c.starts_at)} → ${date(c.ends_at)} (${c.days ?? '—'} days)</div></div>
                <div class="right"><div class="num"><strong>${money(c.price_minor)}</strong></div><div class="tiny faint">submitted ${ago(c.submitted_at ?? c.created_at)}</div></div></div>
              <div class="creative"><img src="${safeUrl(cr.image_url)}" alt="Ad image" /><div class="stack tight"><strong>${cr.title}</strong><span class="muted">${cr.body ?? ''}</span>${cr.click_url ? link(cr.click_url, cr.click_url) : ''}</div></div>
              <div class="row"><button class="primary" data-act="approve" data-id="${c.id}">Approve…</button><button data-act="reject" data-id="${c.id}">Reject…</button></div>
            </div>`;
          })}`
        : empty('No ad submissions', 'Advertiser campaigns waiting for review appear here.'),
      on: async (act, d) => {
        if (act === 'approve') {
          const v = await formDialog({ title: 'Approve campaign', intro: 'It goes live on its start date once paid.', fields: [{ name: 'waiveFee', label: 'Waive the fee (goes live without payment)', type: 'checkbox' }], confirm: 'Approve' });
          if (v) return run(ctx, () => api(`/admin/ads/${d.id}/review`, { body: { approve: true, waiveFee: v.waiveFee } }), 'Campaign approved');
        }
        if (act === 'reject') {
          const v = await formDialog({ title: 'Reject campaign', fields: [{ name: 'reason', label: 'Reason (sent to the advertiser)', type: 'textarea', required: true, min: 5 }], confirm: 'Reject', tone: 'danger' });
          if (v) return run(ctx, () => api(`/admin/ads/${d.id}/review`, { body: { approve: false, reason: v.reason } }), 'Campaign rejected');
        }
      },
    };
  },

  // ---------------------------------------------------------------- supplies listings (Section 13)
  async products(ctx) {
    const rows = await api('/admin/supplies/products', { query: { status: 'pending' } });
    return {
      html: rows.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Product</th><th>Seller</th><th class="right">Price</th><th>Bulk tiers</th><th></th></tr></thead>
            <tbody>${rows.map((p) => html`<tr>
              <td><div class="row" style="align-items:flex-start"><div class="thumbs">${(p.image_urls ?? []).slice(0, 2).map((u) => html`<img src="${safeUrl(u)}" alt="" style="width:64px;height:48px" />`)}</div>
                <div><strong>${p.name}</strong><div class="small muted" style="max-width:360px">${p.description ?? ''}</div></div></div></td>
              <td>${p.seller_name}</td>
              <td class="right num">${money(p.price_minor)} <span class="faint">/ ${p.unit}</span></td>
              <td class="small">${(p.bulk_tiers ?? []).map((t) => html`<div>${t.minQty}+ → ${money(t.unitPriceMinor)}${t.audience === 'technician' ? ' (pros)' : ''}</div>`)}</td>
              <td><div class="stack tight"><button class="primary small" data-act="ok" data-id="${p.id}">Approve</button><button class="small" data-act="no" data-id="${p.id}">Reject</button></div></td>
            </tr>`)}</tbody></table></div>`
        : empty('No listings waiting', 'New and edited supplies listings appear here before buyers can see them.'),
      on: (act, d) => run(ctx, () => api(`/admin/supplies/products/${d.id}/moderate`, { body: { decision: act === 'ok' ? 'approved' : 'rejected' } }), act === 'ok' ? 'Listing approved' : 'Listing rejected'),
    };
  },

  // ---------------------------------------------------------------- reports
  async reports(ctx) {
    const rows = await api('/admin/reports');
    return {
      html: rows.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Reported</th><th>Content</th><th>Reason</th><th>By</th><th></th></tr></thead>
            <tbody>${rows.map((r) => html`<tr>
              <td>${tag(humanize(r.target_type))}<div class="tiny faint">${ago(r.created_at)}</div></td>
              <td style="max-width:360px">${r.preview_url ? html`<img src="${safeUrl(r.preview_url)}" alt="" style="width:96px;height:72px;object-fit:cover;border-radius:6px" />` : r.preview_text ? html`“${r.preview_text}”` : html`<span class="faint">(removed)</span>`}</td>
              <td>${r.reason}</td>
              <td class="small">${r.reporter_name}</td>
              <td><div class="stack tight">
                ${r.target_type === 'review' || r.target_type === 'portfolio_image' ? html`<button class="danger small" data-act="remove" data-id="${r.id}" data-type="${r.target_type}" data-target="${r.target_id}">Remove content</button>` : html`<button class="small" data-act="actioned" data-id="${r.id}">Mark handled</button>`}
                <button class="small" data-act="dismiss" data-id="${r.id}">Dismiss</button></div></td>
            </tr>`)}</tbody></table></div>`
        : empty('No reports', 'Reviews, portfolio photos, messages and ads reported by users appear here.'),
      on: async (act, d) => {
        if (act === 'dismiss') return run(ctx, () => api(`/admin/reports/${d.id}`, { body: { status: 'dismissed' } }), 'Report dismissed');
        if (act === 'actioned') return run(ctx, () => api(`/admin/reports/${d.id}`, { body: { status: 'actioned' } }), 'Marked handled');
        if (act === 'remove') {
          if (!(await confirmDialog('Remove this content?', d.type === 'review' ? 'The review is hidden and the technician’s rating recalculated.' : 'The photo is removed from the public profile.', 'Remove', 'danger'))) return;
          return run(
            ctx,
            async () => {
              if (d.type === 'review') await api(`/admin/reviews/${d.target}/moderate`, { body: { decision: 'rejected' } });
              else await api(`/admin/portfolio/${d.target}/moderate`, { body: { decision: 'rejected' } });
              await api(`/admin/reports/${d.id}`, { body: { status: 'actioned' } });
            },
            'Content removed',
          );
        }
      },
    };
  },

  // ---------------------------------------------------------------- appeals (Section 18)
  async appeals(ctx) {
    const rows = await api('/admin/appeals');
    return {
      html: rows.length
        ? html`${rows.map((a) => html`<div class="card stack">
            <div class="row spread"><div><h3>${a.full_name}</h3><div class="small muted">${humanize(a.role)} · Tier ${a.tier} ${a.tier === 2 ? 'suspension' : 'restriction'} since ${date(a.starts_at)}</div></div>${tag(`${(a.strikes ?? []).length} strike${(a.strikes ?? []).length === 1 ? '' : 's'}`, 'warn')}</div>
            <blockquote class="muted" style="margin:0;border-left:3px solid var(--border);padding-left:12px">${a.statement}</blockquote>
            <div class="small">${(a.strikes ?? []).map((s) => html`<div>${date(s.created_at)} — ${s.party} at fault${s.reason ? `: ${s.reason}` : ''} ${s.voided ? tag('voided') : html`<button class="ghost small" data-act="job" data-id="${s.job_id}">view job</button>`}</div>`)}</div>
            <div class="row"><button class="primary" data-act="overturn" data-id="${a.id}">Overturn…</button><button data-act="uphold" data-id="${a.id}">Uphold…</button></div>
          </div>`)}`
        : empty('No appeals', 'Users appealing a restriction or suspension appear here with their full strike history.'),
      on: async (act, d) => {
        if (act === 'job') return openJob(d.id);
        const v = await formDialog({ title: act === 'overturn' ? 'Overturn — lift the restriction' : 'Uphold the restriction', fields: [{ name: 'note', label: 'Decision note (sent to the user)', type: 'textarea', required: true, min: 3 }], confirm: act === 'overturn' ? 'Overturn' : 'Uphold', tone: act === 'overturn' ? 'primary' : 'danger' });
        if (v) return run(ctx, () => api(`/admin/appeals/${d.id}`, { body: { decision: act === 'overturn' ? 'overturned' : 'upheld', note: v.note } }), 'Appeal decided');
      },
    };
  },

  // ---------------------------------------------------------------- ambiguous incomplete transactions
  async 'fault-reviews'(ctx) {
    const rows = await api('/admin/fault-reviews');
    return {
      html: rows.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Job</th><th>Stalled at</th><th>Last events</th><th>Who was at fault?</th></tr></thead>
            <tbody>${rows.map((f) => html`<tr>
              <td><button class="ghost" data-act="job" data-id="${f.job_id}">#${f.short_code}</button><div class="tiny faint">${ago(f.created_at)}</div></td>
              <td>${statusTag(f.status)}<div class="small muted">${f.action_required_reason ?? ''}</div></td>
              <td class="small">${(f.history ?? []).slice(-3).map((e) => html`<div>${date(e.created_at)} · ${humanize(e.type)}</div>`)}</td>
              <td><div class="row wrap">
                <button class="small" data-act="decide" data-id="${f.id}" data-outcome="customer_fault">Customer</button>
                <button class="small" data-act="decide" data-id="${f.id}" data-outcome="technician_fault">Technician</button>
                <button class="small" data-act="decide" data-id="${f.id}" data-outcome="no_fault">No one</button></div></td>
            </tr>`)}</tbody></table></div>`
        : empty('No ambiguous stalls', 'Jobs that timed out without a clear party to blame land here.'),
      on: async (act, d) => {
        if (act === 'job') return openJob(d.id);
        const v = await formDialog({ title: `Record: ${humanize(d.outcome)}`, intro: d.outcome === 'no_fault' ? 'The job closes with no strike.' : 'A strike is recorded and penalty tiers are applied.', fields: [{ name: 'note', label: 'Note', type: 'textarea' }], confirm: 'Record' });
        if (v) return run(ctx, () => api(`/admin/fault-reviews/${d.id}`, { body: { outcome: d.outcome, note: v.note || undefined } }), 'Recorded');
      },
    };
  },

  // ---------------------------------------------------------------- performance multiplier (7a)
  async 'rate-anomalies'(ctx) {
    const rows = await api('/admin/multiplier-anomalies');
    return {
      html: html`<div class="row spread" style="margin-bottom:12px"><p class="muted small" style="margin:0">Large swings in a technician's labor rate are held at the old value until you confirm or override them.</p>
          <button data-act="recalc">Recalculate all now</button></div>
        ${rows.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>Technician</th><th class="right">Rolling rating</th><th class="right">Current</th><th class="right">Proposed</th><th>Computed</th><th></th></tr></thead>
              <tbody>${rows.map((m) => html`<tr>
                <td>${m.full_name}</td>
                <td class="right num">${m.rating_avg ? Number(m.rating_avg).toFixed(2) + '★' : '—'}</td>
                <td class="right num">${m.from_bps > 0 ? '+' : ''}${pct(m.from_bps)}</td>
                <td class="right num"><strong>${m.to_bps > 0 ? '+' : ''}${pct(m.to_bps)}</strong></td>
                <td class="small">${date(m.computed_at)}</td>
                <td><div class="row"><button class="primary small" data-act="confirm" data-id="${m.id}">Apply</button><button class="small" data-act="override" data-id="${m.id}">Override…</button></div></td>
              </tr>`)}</tbody></table></div>`
          : empty('No anomalies', 'Labor-rate changes that look unusual are held here.')}`,
      on: async (act, d) => {
        if (act === 'recalc') return run(ctx, async () => {
          const r = await api('/admin/multiplier/recalculate', { body: {} });
          toast(r.skipped ? 'Performance rates are switched off' : `Recalculated ${int(r.recalculated)} technicians`);
        });
        if (act === 'confirm') {
          const v = await formDialog({ title: 'Apply the new rate', fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true, value: 'Reviewed — consistent with recent ratings' }], confirm: 'Apply' });
          if (v) return run(ctx, () => api(`/admin/multiplier-anomalies/${d.id}`, { body: { action: 'confirm', reason: v.reason } }), 'Applied');
        }
        if (act === 'override') {
          const v = await formDialog({ title: 'Override labor rate', fields: [{ name: 'pct', label: 'Labor adjustment (%)', type: 'number', required: true, hint: 'e.g. 5 for +5%, -5 for −5%' }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, min: 3 }], confirm: 'Override' });
          if (v) return run(ctx, () => api(`/admin/multiplier-anomalies/${d.id}`, { body: { action: 'override', overrideBps: Math.round(v.pct * 100), reason: v.reason } }), 'Overridden');
        }
      },
    };
  },
};
