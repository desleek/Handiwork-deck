import { api } from '../api.js';
import { compactMoney, esc, html, int, money, tag } from '../ui.js';

const QUEUES = [
  { key: 'disputes', label: 'Open disputes', href: '#/disputes', sum: (c) => c.disputes + c.supply_disputes, urgent: true },
  { key: 'fast_track', label: 'Fast Track price challenges', href: '#/approvals/price-evidence', urgent: true },
  { key: 'technicians', label: 'Technicians to verify', href: '#/approvals/technicians' },
  { key: 'cap_exceptions', label: 'Markup cap exceptions', href: '#/approvals/demand-notices' },
  { key: 'price_challenges', label: 'Price challenges (escalated / evidence)', href: '#/approvals/price-evidence' },
  { key: 'boq_reviews', label: 'BOQ uploads to check', href: '#/boq' },
  { key: 'storefronts', label: 'Storefronts waiting to launch', href: '#/launches' },
  { key: 'ads', label: 'Ad submissions', href: '#/approvals/ads' },
  { key: 'products', label: 'Supplies listings', href: '#/approvals/products' },
  { key: 'reports', label: 'Reported content', href: '#/approvals/reports' },
  { key: 'appeals', label: 'Account appeals', href: '#/approvals/appeals' },
  { key: 'fault_reviews', label: 'Incomplete-job fault reviews', href: '#/approvals/fault-reviews' },
  { key: 'multiplier_anomalies', label: 'Labor rate anomalies', href: '#/approvals/rate-anomalies' },
];

export async function renderOverview(view, ctx) {
  const [c, a] = await Promise.all([ctx.refreshCounts(), api('/admin/analytics', { query: { days: 30 } })]);
  if (!ctx.isCurrent()) return;
  const revenue = a.revenue ?? {};
  const totalRevenue = ['labor_commission_minor', 'markup_commission_minor', 'boost_revenue_minor', 'push_alert_revenue_minor', 'ad_revenue_minor'].reduce((s, k) => s + Number(revenue[k] ?? 0), 0);
  const gmv = (a.gmvByChannel ?? []).reduce((s, r) => s + Number(r.gmv_minor), 0);
  const queues = QUEUES.map((q) => ({ ...q, n: q.sum ? q.sum(c) : c[q.key] })).sort((x, y) => (y.n > 0) - (x.n > 0) || (y.urgent ? 1 : 0) - (x.urgent ? 1 : 0));
  const waiting = queues.reduce((s, q) => s + (q.key === 'fast_track' ? 0 : q.n), 0);

  view.innerHTML = esc(html`
    <div class="page-head">
      <div><h1>Overview</h1><div class="muted">${waiting ? `${int(waiting)} item${waiting === 1 ? '' : 's'} waiting for review` : 'All queues are clear'}</div></div>
    </div>
    <div class="grid kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="label">Job GMV · 30 days</div><div class="value">${compactMoney(gmv)}</div></div>
      <div class="kpi"><div class="label">Platform revenue · 30 days</div><div class="value">${compactMoney(totalRevenue)}</div><div class="sub">Job fees, boosts & ads · <a href="#/analytics">full breakdown</a></div></div>
      <div class="kpi"><div class="label">Held in escrow now</div><div class="value">${compactMoney(c.escrow_minor)}</div><div class="sub">${money(c.escrow_minor)}</div></div>
      <div class="kpi"><div class="label">Open jobs</div><div class="value">${int(c.open_jobs)}</div></div>
      <div class="kpi"><div class="label">Completed · 30 days</div><div class="value">${int(a.rates?.completed_jobs)}</div></div>
    </div>
    <div class="grid cols-2">
      <section class="card">
        <div class="card-head"><h2>Review queues</h2></div>
        <div class="table-wrap" style="border:0">
          <table>
            <tbody>
              ${queues.map((q) => html`<tr>
                <td><a href="${q.href}">${q.label}</a></td>
                <td class="right">${q.n > 0 ? tag(int(q.n), q.urgent ? 'urgent' : 'warn') : html`<span class="faint">0</span>`}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Features</h2><a href="#/launches">Manage</a></div>
        <div class="stack tight">
          ${Object.entries(c.features).map(([k, v]) => html`<div class="row spread"><span>${FEATURE_LABEL[k] ?? k}</span>${v ? tag('On', 'good') : tag('Off')}</div>`)}
        </div>
      </section>
    </div>`);
}

export const FEATURE_LABEL = {
  advertising: 'Advertising (Deals & sponsored)',
  performanceMultiplier: 'Performance-based labor rate',
  boosts: 'Technician boosts & alerts',
  walletBonus: 'Wallet top-up bonus',
  construction: 'Construction & plant erection',
  supplies: 'Supplies marketplace',
};
