import { api, errorText } from './api.js';
import * as auth from './auth.js';
import { esc, html, toast } from './ui.js';
import { renderApprovals } from './views/approvals.js';
import { renderAnalytics } from './views/analytics.js';
import { renderBoq } from './views/boq.js';
import { renderDisputes } from './views/disputes.js';
import { renderLaunches } from './views/launches.js';
import { renderOverview } from './views/overview.js';

const app = document.getElementById('app');
let me = null;
let counts = null;

const NAV = [
  { id: 'overview', label: 'Overview', count: () => null },
  { id: 'approvals', label: 'Approvals', count: (c) => c.technicians + c.cap_exceptions + c.price_challenges + c.ads + c.products + c.reports + c.appeals + c.fault_reviews + c.multiplier_anomalies + c.certifications + c.portfolio },
  { id: 'disputes', label: 'Disputes', count: (c) => c.disputes + c.supply_disputes, hot: true },
  { id: 'boq', label: 'BOQ reviews', count: (c) => c.boq_reviews },
  { id: 'launches', label: 'Storefronts & launches', count: (c) => c.storefronts },
  { id: 'analytics', label: 'Analytics', count: () => null },
];

const VIEWS = { overview: renderOverview, approvals: renderApprovals, disputes: renderDisputes, boq: renderBoq, launches: renderLaunches, analytics: renderAnalytics };

function route() {
  const [page = 'overview', sub = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: VIEWS[page] ? page : 'overview', sub };
}

/** Refresh the sidebar counts (called after every action that changes a queue). */
export async function refreshCounts() {
  try {
    counts = await api('/admin/overview');
  } catch {
    return;
  }
  for (const n of NAV) {
    const el = document.querySelector(`[data-count="${n.id}"]`);
    if (!el) continue;
    const v = n.count(counts);
    el.textContent = v ?? '';
    el.className = `badge-count ${v && n.hot ? 'hot' : ''} ${v === null || v === 0 ? 'hidden' : ''}`;
  }
  return counts;
}
export const getCounts = () => counts;

function shell() {
  app.innerHTML = esc(html`
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <div class="brand"><span class="brand-mark">H</span>Handiwork-Deck <span class="tag good">Admin</span></div>
        <div class="nav stack tight">
          ${NAV.map((n) => html`<a href="#/${n.id}" data-nav="${n.id}"><span>${n.label}</span><span class="badge-count hidden" data-count="${n.id}"></span></a>`)}
        </div>
        <div class="sidebar-foot stack tight">
          <div class="small"><strong>${me.full_name}</strong></div>
          <div class="tiny faint">${auth.mode === 'dev' ? 'Development sign-in' : 'Signed in'}</div>
          <button class="small" data-signout>Sign out</button>
        </div>
      </nav>
      <main class="main" id="view" tabindex="-1"></main>
    </div>`);
  app.querySelector('[data-signout]').onclick = async () => {
    await auth.signOut();
    location.hash = '';
    start();
  };
}

let renderToken = 0;
async function render() {
  const { page, sub } = route();
  document.querySelectorAll('[data-nav]').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === page ? 'page' : 'false'));
  const view = document.getElementById('view');
  const token = ++renderToken;
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await VIEWS[page](view, { sub, refresh: () => render(), refreshCounts, isCurrent: () => token === renderToken });
  } catch (err) {
    if (token !== renderToken) return;
    view.innerHTML = esc(html`<div class="banner crit">Couldn't load this page: ${errorText(err)}</div>`);
  }
  document.title = `${NAV.find((n) => n.id === page)?.label ?? 'Admin'} · Handiwork-Deck Admin`;
}

function signInScreen(message = '') {
  const dev = auth.mode === 'dev';
  app.innerHTML = esc(html`
    <div class="signin">
      <div class="card stack">
        <div class="brand" style="padding:0"><span class="brand-mark">H</span>Handiwork-Deck Admin</div>
        ${message ? html`<div class="banner crit">${message}</div>` : ''}
        ${dev
          ? html`<div class="banner info">Development sign-in (AUTH_MODE=dev). The seeded admin is pre-filled.</div>
              <label class="field">Admin user id<input id="devId" value="00000000-0000-0000-0000-000000000001" /></label>
              <button class="primary" id="go">Sign in</button>`
          : html`<p class="muted">Sign in with the phone number on your admin account.</p>
              <label class="field" id="phoneField">Phone number<input id="phone" type="tel" value="+234" autocomplete="tel" /></label>
              <label class="field hidden" id="codeField">6-digit code<input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></label>
              <button class="primary" id="go">Send code</button>
              <div id="recaptcha"></div>`}
      </div>
    </div>`);
  const go = app.querySelector('#go');
  if (dev) {
    go.onclick = () => {
      auth.devSignIn(app.querySelector('#devId').value.trim());
      start();
    };
    return;
  }
  let confirmCode = null;
  go.onclick = async () => {
    go.disabled = true;
    try {
      if (!confirmCode) {
        confirmCode = await auth.startPhoneSignIn(app.querySelector('#phone').value.trim(), 'recaptcha');
        app.querySelector('#phoneField').classList.add('hidden');
        app.querySelector('#codeField').classList.remove('hidden');
        go.textContent = 'Verify';
        app.querySelector('#code').focus();
      } else {
        await confirmCode(app.querySelector('#code').value.trim());
        start();
      }
    } catch (err) {
      toast(errorText(err), 'crit');
    } finally {
      go.disabled = false;
    }
  };
}

async function start() {
  auth.setUnauthorizedHandler(() => signInScreen('Your session has expired. Please sign in again.'));
  if (!(await auth.ready())) return signInScreen();
  try {
    me = await api('/me');
  } catch (err) {
    return signInScreen(err.code === 'NOT_REGISTERED' ? 'This sign-in is not linked to an admin account.' : errorText(err));
  }
  if (me.role !== 'admin') {
    await auth.signOut();
    return signInScreen('This account does not have admin access.');
  }
  shell();
  await refreshCounts();
  await render();
}

window.addEventListener('hashchange', () => me && render());
start();

