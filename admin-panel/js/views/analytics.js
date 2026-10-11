import { api } from '../api.js';
import { compactMoney, empty, esc, html, humanize, int, money, pct, tag } from '../ui.js';
import { FEATURE_LABEL } from './overview.js';

const PERIODS = [7, 30, 90];

/**
 * Platform analytics (Section 19 / 20). Headline numbers are KPI tiles; comparisons are
 * single-series horizontal bars (one hue, sorted, value labelled) with a hover tooltip and a
 * table view. No dual axes: money and counts are always separate charts.
 */
export async function renderAnalytics(view, ctx) {
  const days = PERIODS.includes(Number(ctx.sub)) ? Number(ctx.sub) : 30;
  const [a, settings] = await Promise.all([api('/admin/analytics', { query: { days } }), api('/admin/settings')]);
  const features = settings.settings.features ?? {};
  // Module analytics only exist when the module is switched on; failures there shouldn't blank the page.
  const [con, sup, econ] = await Promise.all([
    features.construction ? api('/admin/construction/analytics', { query: { days } }).catch(() => null) : null,
    features.supplies ? api('/admin/supplies/analytics', { query: { days } }).catch(() => null) : null,
    features.walletBonus ? api('/admin/wallet-bonus/economics').catch(() => null) : null,
  ]);
  if (!ctx.isCurrent()) return;

  const gmv = a.gmvByChannel.reduce((s, r) => s + Number(r.gmv_minor), 0);
  const payments = a.gmvByChannel.reduce((s, r) => s + Number(r.payments), 0);
  const rev = a.revenue;
  const revenueRows = [
    { label: 'Labor commission', value: Number(rev.labor_commission_minor) },
    { label: 'Parts markup commission', value: Number(rev.markup_commission_minor) },
    { label: 'Profile boosts', value: Number(rev.boost_revenue_minor) },
    { label: 'Push alerts', value: Number(rev.push_alert_revenue_minor) },
    { label: 'Advertising', value: Number(rev.ad_revenue_minor) },
    ...(con ? [{ label: 'Site consultancy fees', value: Number(con.consultancy_fees_minor) }] : []),
    ...(sup ? [{ label: 'Supplies commission', value: Number(sup.commission_minor) }] : []),
  ];
  const revenueTotal = revenueRows.reduce((s, r) => s + r.value, 0);
  const r = a.rates;
  const per100 = (n) => (Number(r.completed_jobs) ? `${((Number(n) / Number(r.completed_jobs)) * 100).toFixed(1)} per 100 jobs` : 'no completed jobs');

  view.innerHTML = esc(html`
    <div class="page-head">
      <div><h1>Analytics</h1><div class="muted">Last ${days} days · amounts in naira</div></div>
      <div class="seg" role="group" aria-label="Period">${PERIODS.map((p) => html`<button data-act="period" data-days="${p}" aria-pressed="${p === days}">${p} days</button>`)}</div>
    </div>

    <div class="grid kpis" style="margin-bottom:12px">
      ${kpi('Gross volume (GMV)', compactMoney(gmv), `${int(payments)} payments`, money(gmv))}
      ${kpi('Platform revenue', compactMoney(revenueTotal), gmv ? `${((revenueTotal / gmv) * 100).toFixed(1)}% take rate` : '—', money(revenueTotal))}
      ${kpi('Completed jobs', int(r.completed_jobs), `${int(r.reviews)} reviews left`)}
      ${kpi('Monthly active customers', int(a.traction.monthly_active_customers), 'booked in the last 30 days')}
      ${kpi('Disputes', int(r.disputes), per100(r.disputes))}
    </div>

    <div class="grid cols-2" style="margin-bottom:12px">
      ${chartCard('revenue', 'Revenue by source', revenueRows, { fmt: compactMoney, full: money, unit: 'Revenue', note: 'Commission is recognised when escrow is released.' })}
      ${chartCard('channel', 'GMV by payment channel', a.gmvByChannel.map((c) => ({ label: `${humanize(c.channel)} · ${c.provider}`, value: Number(c.gmv_minor), extra: `${int(c.payments)} payments` })), { fmt: compactMoney, full: money, unit: 'GMV' })}
    </div>

    <div class="grid cols-2" style="margin-bottom:12px">
      ${chartCard('demand', 'Jobs by category', a.categoryDemand.map((c) => ({ label: c.name, value: Number(c.jobs) })), { fmt: int, full: (v) => `${int(v)} jobs`, unit: 'Jobs', limit: 10 })}
      <section class="card stack">
        <div class="card-head"><h2>Pricing & quality signals</h2></div>
        <div class="tiny faint">Per 100 completed jobs. Rising numbers mean prices or work quality need attention.</div>
        ${chartBars('rates', [
          { label: 'Marked-up part lines', value: Number(r.marked_up_lines) },
          { label: 'Cap exceptions requested', value: Number(r.cap_exceptions) },
          { label: 'Price challenges', value: Number(r.price_challenges) },
          { label: 'Disputes', value: Number(r.disputes) },
        ], { fmt: int, full: (v) => `${int(v)} (${per100(v)})`, unit: 'Count', sort: false })}
      </section>
    </div>

    <div class="grid kpis" style="margin-bottom:20px">
      ${kpi('Wallet top-ups', compactMoney(a.wallet.topups_minor), `${compactMoney(a.wallet.bonuses_minor)} bonus credited`, money(a.wallet.topups_minor))}
      ${kpi('Withdrawals', compactMoney(a.withdrawals.volume_minor), `${int(a.withdrawals.instant)} instant · ${int(a.withdrawals.standard)} standard`, money(a.withdrawals.volume_minor))}
      ${kpi('Instant-withdrawal fees', compactMoney(a.withdrawals.fees_minor), 'charged to technicians', money(a.withdrawals.fees_minor))}
      ${kpi('Ad impressions', int(a.ads.impressions), `${int(a.ads.clicks)} clicks · ${a.ads.ctrPct ?? 0}% CTR`)}
      ${kpi('Active campaigns', int(a.ads.active_campaigns), features.advertising ? 'advertising on' : 'advertising off')}
    </div>

    ${constructionSection(con, features)}
    ${suppliesSection(sup, a, features)}
    ${economicsSection(econ, features)}`);

  view.onclick = (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'period') location.hash = `#/analytics/${el.dataset.days}`;
    if (el.dataset.act === 'table') {
      const id = el.dataset.chart;
      const chart = view.querySelector(`[data-chart-bars="${id}"]`);
      const table = view.querySelector(`[data-chart-table="${id}"]`);
      const showTable = table.classList.contains('hidden');
      table.classList.toggle('hidden', !showTable);
      chart.classList.toggle('hidden', showTable);
      el.textContent = showTable ? 'Show chart' : 'Show table';
      el.setAttribute('aria-pressed', String(showTable));
    }
  };
}

// ---------------------------------------------------------------- building blocks

function kpi(label, value, sub = '', title = '') {
  return html`<div class="kpi"${title ? html` title="${title}"` : ''}><div class="label">${label}</div><div class="value">${value}</div>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>`;
}

/** Card with a single-series bar chart plus a table view of the same data. */
function chartCard(id, title, rows, opts) {
  return html`<section class="card stack">
    <div class="card-head"><h2>${title}</h2>${rows.length ? html`<button class="ghost small" data-act="table" data-chart="${id}" aria-pressed="false">Show table</button>` : ''}</div>
    ${opts.note ? html`<div class="tiny faint">${opts.note}</div>` : ''}
    ${chartBars(id, rows, opts)}
  </section>`;
}

function chartBars(id, rows, { fmt, full, unit, limit, sort = true }) {
  let data = rows.filter((x) => Number.isFinite(x.value));
  if (sort) data = [...data].sort((x, y) => y.value - x.value);
  // Long tails fold into "Other" rather than shrinking every bar.
  if (limit && data.length > limit) {
    const rest = data.slice(limit - 1);
    data = [...data.slice(0, limit - 1), { label: `Other (${rest.length})`, value: rest.reduce((s, x) => s + x.value, 0) }];
  }
  if (!data.length || data.every((x) => !x.value)) return empty('No data in this period');
  const max = Math.max(...data.map((x) => x.value), 1);
  const total = data.reduce((s, x) => s + x.value, 0);
  const share = (v) => (total ? `${((v / total) * 100).toFixed(0)}%` : '');
  return html`
    <div class="bars" data-chart-bars="${id}" role="img" aria-label="${unit} by category, bar chart">
      ${data.map((x) => html`<div class="bar-row" data-tip="${x.label}: ${full(x.value)}${x.extra ? ` · ${x.extra}` : ''}${sort ? ` · ${share(x.value)} of total` : ''}">
        <span class="lbl" title="${x.label}">${x.label}</span>
        <span class="track"><span class="fill" style="width:${((x.value / max) * 100).toFixed(2)}%"></span></span>
        <span class="val">${fmt(x.value)}</span>
      </div>`)}
    </div>
    <div class="table-wrap hidden" data-chart-table="${id}"><table class="small">
      <thead><tr><th>Item</th><th class="right">${unit}</th>${sort ? html`<th class="right">Share</th>` : ''}</tr></thead>
      <tbody>${data.map((x) => html`<tr><td>${x.label}${x.extra ? html` <span class="faint">· ${x.extra}</span>` : ''}</td><td class="right num">${full(x.value)}</td>${sort ? html`<td class="right num">${share(x.value)}</td>` : ''}</tr>`)}</tbody>
    </table></div>`;
}

function offCard(title, key) {
  return html`<section class="card" style="margin-bottom:12px"><div class="card-head"><h2>${title}</h2>${tag('Off')}</div>
    <div class="muted small">${FEATURE_LABEL[key] ?? key} is switched off. Turn it on from <a href="#/launches">Storefronts & launches</a> to start collecting these numbers.</div></section>`;
}

function constructionSection(c, features) {
  if (!features.construction) return offCard('Construction', 'construction');
  if (!c) return html`<section class="card" style="margin-bottom:12px"><h2>Construction</h2><div class="banner warn">Construction analytics couldn't be loaded.</div></section>`;
  const funnel = [
    { label: 'Site visits quoted', value: Number(c.consultations_quoted) },
    { label: 'Visit fee paid', value: Number(c.consultations_paid) },
    { label: 'Visit completed', value: Number(c.consultations_visited) },
    { label: 'Project approved', value: Number(c.projects_approved) },
  ];
  const mile = [
    { label: 'Agreed', value: Number(c.milestones_agreed) },
    { label: 'Released', value: Number(c.milestones_released) },
    { label: 'Disputed', value: Number(c.milestones_disputed) },
  ];
  const uploadFailPct = Number(c.uploads) ? ((Number(c.upload_failures) / Number(c.uploads)) * 100).toFixed(0) : null;
  return html`<h2 class="section-title">Construction</h2>
    <div class="grid kpis" style="margin-bottom:12px">
      ${kpi('Consultancy → project', `${c.consultancyToConversionPct ?? 0}%`, 'paid visits that became approved projects')}
      ${kpi('Avg project value', compactMoney(c.avg_project_value_minor), `${int(c.projects_approved)} approved`, money(c.avg_project_value_minor))}
      ${kpi('Milestone completion', `${c.milestoneCompletionPct ?? 0}%`, 'released of agreed')}
      ${kpi('BOQ uploads', int(c.uploads), uploadFailPct === null ? 'none yet' : `${int(c.upload_failures)} unreadable (${uploadFailPct}%)`)}
    </div>
    <div class="grid cols-2" style="margin-bottom:20px">
      <section class="card stack"><div class="card-head"><h2>Consultation funnel</h2><button class="ghost small" data-act="table" data-chart="funnel" aria-pressed="false">Show table</button></div>
        ${chartBars('funnel', funnel, { fmt: int, full: (v) => `${int(v)} (${funnel[0].value ? ((v / funnel[0].value) * 100).toFixed(0) : 0}% of quoted)`, unit: 'Jobs', sort: false })}</section>
      <section class="card stack"><div class="card-head"><h2>Milestones</h2><button class="ghost small" data-act="table" data-chart="milestones" aria-pressed="false">Show table</button></div>
        ${chartBars('milestones', mile, { fmt: int, full: (v) => `${int(v)} milestones`, unit: 'Milestones', sort: false })}</section>
    </div>`;
}

function suppliesSection(s, a, features) {
  if (!features.supplies) {
    return html`<section class="card" style="margin-bottom:12px"><div class="card-head"><h2>Supplies marketplace</h2>${tag('Not launched')}</div>
      <div class="grid kpis">${kpi('Verified sellers', int(a.traction.verified_sellers))}${kpi('Waitlist', int(a.traction.supplies_waitlist), 'people waiting for launch')}${kpi('Completed jobs (30d)', int(a.traction.completed_jobs_30d))}</div>
      <div class="muted small" style="margin-top:8px">Launch readiness is tracked on <a href="#/launches">Storefronts & launches</a>.</div></section>`;
  }
  if (!s) return html`<section class="card" style="margin-bottom:12px"><h2>Supplies marketplace</h2><div class="banner warn">Supplies analytics couldn't be loaded.</div></section>`;
  const linkedPct = Number(s.orders) ? ((Number(s.orders_linked_to_jobs) / Number(s.orders)) * 100).toFixed(0) : 0;
  return html`<h2 class="section-title">Supplies marketplace</h2>
    <div class="grid kpis" style="margin-bottom:20px">
      ${kpi('Orders', int(s.orders), `${int(s.buyers)} buyers`)}
      ${kpi('Supplies GMV', compactMoney(s.gmv_minor), `${compactMoney(s.commission_minor)} commission`, money(s.gmv_minor))}
      ${kpi('Bulk discounts given', compactMoney(s.bulk_discounts_minor), '', money(s.bulk_discounts_minor))}
      ${kpi('Fulfilled', int(Number(s.delivered) + Number(s.picked_up)), `${int(s.delivered)} delivered · ${int(s.picked_up)} picked up`)}
      ${kpi('Bought for a job', `${linkedPct}%`, `${int(s.orders_linked_to_jobs)} orders linked to a job`)}
      ${kpi('Open disputes', int(s.open_disputes), Number(s.open_disputes) ? html`<a href="#/disputes/supplies">Review</a>` : 'none')}
    </div>`;
}

function economicsSection(e, features) {
  if (!features.walletBonus) return offCard('Wallet bonus economics', 'walletBonus');
  if (!e) return html`<section class="card"><h2>Wallet bonus economics</h2><div class="banner warn">Couldn't be loaded.</div></section>`;
  const r = e.realised90d ?? {};
  return html`<h2 class="section-title">Wallet bonus economics</h2>
    <section class="card stack" style="margin-bottom:12px">
      <div class="small muted">Does each top-up bonus pay for itself? A tier is funded when the per-job fees the platform avoids (wallet payments skip the ${humanize(e.provider)} card fee) cover the bonus it gives away.
        Average job ${money(e.averageJob.avgJobMinor)} (${e.averageJob.source === 'actual' ? `from ${int(e.averageJob.sample)} recent jobs` : e.averageJob.source === 'override' ? 'override' : 'configured estimate'}).</div>
      <div class="table-wrap"><table class="small">
        <thead><tr><th class="right">Top-up</th><th class="right">Bonus</th><th class="right">Top-up fee</th><th class="right">Jobs funded</th><th class="right">Fees avoided</th><th class="right">Margin</th><th class="right">Break-even bonus</th><th>Verdict</th></tr></thead>
        <tbody>${e.tiers.map((t) => html`<tr>
          <td class="right num">${money(t.topupMinor)}</td>
          <td class="right num">${money(t.bonusMinor)} <span class="faint">(${pct(t.bonusBps)})</span></td>
          <td class="right num">${money(t.topupFeeMinor)}</td>
          <td class="right num">${Number(t.jobsFunded).toFixed(1)}</td>
          <td class="right num">${money(t.avoidedJobFeesMinor)}</td>
          <td class="right num">${money(t.marginMinor)}</td>
          <td class="right num">${pct(t.breakEvenBps)}</td>
          <td>${t.funded ? tag('✓ Pays for itself', 'good') : tag('⚠ Costs money', 'warn')}</td>
        </tr>`)}</tbody></table></div>
      ${r.marginMinor !== undefined ? html`<div class="small">Realised over the last 90 days: margin <strong class="num">${money(r.marginMinor)}</strong>${r.bonusesMinor !== undefined ? html` on ${money(r.bonusesMinor)} of bonuses` : ''}.</div>` : ''}
    </section>
    ${(e.instantWithdrawals ?? []).length
      ? html`<section class="card stack"><div class="card-head"><h2>Instant withdrawal pricing</h2></div>
          <div class="table-wrap"><table class="small"><thead><tr><th class="right">Amount</th><th class="right">Technician pays</th><th class="right">Provider cost</th><th class="right">Margin</th></tr></thead>
          <tbody>${e.instantWithdrawals.map((w) => html`<tr><td class="right num">${money(w.amountMinor)}</td><td class="right num">${money(w.userFeeMinor)}</td><td class="right num">${money(w.providerCostMinor)}</td>
            <td class="right num">${Number(w.marginMinor) < 0 ? tag(`⚠ ${money(w.marginMinor)}`, 'crit') : money(w.marginMinor)}</td></tr>`)}</tbody></table></div></section>`
      : ''}`;
}
