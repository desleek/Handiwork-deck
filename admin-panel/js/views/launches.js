import { api, ApiError, errorText } from '../api.js';
import { confirmDialog, empty, esc, formDialog, html, int, money, statusTag, tag, toast } from '../ui.js';
import { FEATURE_LABEL } from './overview.js';

/**
 * Storefront launches (Section 13) and feature switches (Section 21 phasing).
 * The Supplies marketplace is gated on admin-defined traction milestones.
 */
export async function renderLaunches(view, ctx) {
  const [g, fronts, advertisers, settings, sellers] = await Promise.all([
    api('/admin/supplies/greenlight'),
    api('/admin/supplies/storefronts'),
    api('/admin/advertisers'),
    api('/admin/settings'),
    api('/admin/sellers', { query: { status: 'verified' } }),
  ]);
  if (!ctx.isCurrent()) return;
  const features = settings.settings.features;
  const pending = fronts.filter((f) => f.storefront_status === 'pending');
  const others = fronts.filter((f) => f.storefront_status !== 'pending');
  const ownerName = (id) => advertisers.find((a) => a.id === id)?.company_name ?? advertisers.find((a) => a.id === id)?.full_name ?? null;

  const storefrontRow = (f) => html`<tr>
    <td><strong>${f.name}</strong><div class="tiny faint">${f.verification_status} seller</div></td>
    <td>${f.owner_user_id ? ownerName(f.owner_user_id) ?? 'Linked' : tag('No login linked', 'warn')}</td>
    <td class="small">${f.pickup_address ?? '—'}<div class="faint">${f.offers_delivery ? `Delivers · ${money(f.delivery_fee_minor)}` : 'Pickup only'}</div></td>
    <td class="right num">${int(f.products)}</td>
    <td>${f.rating_avg ? `${Number(f.rating_avg).toFixed(1)}★ (${f.rating_count})` : html`<span class="faint">—</span>`}</td>
    <td>${statusTag(f.storefront_status)}</td>
    <td><div class="row">
      ${f.storefront_status !== 'live' ? html`<button class="primary small" data-act="live" data-id="${f.id}" data-name="${f.name}" data-owner="${f.owner_user_id ?? ''}">Go live…</button>` : ''}
      ${f.storefront_status === 'live' ? html`<button class="small" data-act="suspend" data-id="${f.id}" data-name="${f.name}">Suspend…</button>` : ''}
    </div></td></tr>`;

  view.innerHTML = esc(html`
    <div class="page-head"><div><h1>Storefronts & launches</h1><div class="muted">Open seller storefronts and switch platform features on when they're ready.</div></div>
      <button class="primary" data-act="new-seller">Create seller login…</button></div>

    <div class="grid cols-2" style="margin-bottom:12px">
      <section class="card stack">
        <div class="card-head"><h2>Supplies marketplace greenlight</h2>${features.supplies ? tag('Live', 'good') : g.met ? tag('Ready to launch', 'good') : tag('Not yet', 'warn')}</div>
        ${g.items.map((i) => html`<div class="stack tight">
          <div class="row spread small"><span>${i.label}</span><span class="num">${int(i.value)} / ${int(i.target)} ${i.met ? tag('✓ met', 'good') : ''}</span></div>
          <div class="progress ${i.met ? 'met' : ''}" role="progressbar" aria-valuenow="${i.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${i.label}"><span style="width:${i.pct}%"></span></div>
        </div>`)}
        <div class="small muted">${int(g.waitlist)} people on the Supplies waitlist. Targets are the <code>suppliesGreenlight</code> setting.</div>
        ${!features.supplies ? html`<div><button class="${g.met ? 'primary' : ''}" data-act="launch-supplies">${g.met ? 'Launch Supplies marketplace' : 'Launch anyway…'}</button></div>` : ''}
      </section>

      <section class="card stack">
        <div class="card-head"><h2>Feature switches</h2></div>
        ${Object.entries(features).map(([k, on]) => html`<div class="row spread">
          <span>${FEATURE_LABEL[k] ?? k}</span>
          <button class="small ${on ? '' : 'primary'}" data-act="toggle" data-key="${k}" data-on="${on}">${on ? 'Turn off' : 'Turn on'}</button>
        </div>`)}
        <div class="tiny faint">Changes take effect within 30 seconds and are recorded in the admin audit log.</div>
      </section>
    </div>

    <section class="card" style="margin-bottom:12px">
      <div class="card-head"><h2>Waiting to launch</h2>${pending.length ? tag(String(pending.length), 'warn') : ''}</div>
      ${pending.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Seller</th><th>Login</th><th>Pickup / delivery</th><th class="right">Products</th><th>Rating</th><th>Status</th><th></th></tr></thead><tbody>${pending.map(storefrontRow)}</tbody></table></div>`
        : empty('No storefront requests', 'Sellers request a storefront from the app once their pickup details are set.')}
    </section>

    <section class="card">
      <div class="card-head"><h2>All storefronts</h2></div>
      ${others.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Seller</th><th>Login</th><th>Pickup / delivery</th><th class="right">Products</th><th>Rating</th><th>Status</th><th></th></tr></thead><tbody>${others.map(storefrontRow)}</tbody></table></div>`
        : empty('No storefronts yet')}
    </section>`);

  const reload = async (msg) => {
    toast(msg);
    await ctx.refreshCounts();
    await ctx.refresh();
  };

  async function setFeature(key, on, override) {
    const value = { ...features, [key]: on };
    const body = { value, reason: override?.reason ?? `${on ? 'Enabled' : 'Disabled'} ${FEATURE_LABEL[key] ?? key} from admin panel` };
    if (override) body.overrideGreenlight = true;
    await api('/admin/settings/features', { method: 'PUT', body });
  }

  view.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const d = el.dataset;
    try {
      if (d.act === 'toggle') {
        const on = d.on !== 'true';
        if (!(await confirmDialog(`${on ? 'Turn on' : 'Turn off'} ${FEATURE_LABEL[d.key] ?? d.key}?`, on ? 'Customers and technicians will see it within a minute.' : 'It disappears from the apps. Work already in progress is not affected.', on ? 'Turn on' : 'Turn off', on ? 'primary' : 'danger'))) return;
        try {
          await setFeature(d.key, on);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'GREENLIGHT_NOT_MET') return launchOverride();
          throw err;
        }
        return reload('Feature updated');
      }
      if (d.act === 'launch-supplies') {
        if (!g.met) return launchOverride();
        if (!(await confirmDialog('Launch the Supplies marketplace?', 'Buyers can start ordering from live storefronts immediately.', 'Launch'))) return;
        await setFeature('supplies', true);
        return reload('Supplies marketplace launched');
      }
      if (d.act === 'live') {
        const options = advertisers.map((a) => ({ value: a.id, label: `${a.company_name ?? a.full_name}${a.seller_name && a.seller_name !== d.name ? ` (linked to ${a.seller_name})` : ''}` }));
        const v = await formDialog({
          title: `Open ${d.name}'s storefront`,
          intro: 'Only fully verified sellers can go live. Pick the login that will manage orders and receive payouts.',
          fields: options.length
            ? [{ name: 'owner', label: 'Seller login', type: 'select', value: d.owner || options[0].value, options }]
            : [],
          confirm: 'Go live',
        });
        if (!v) return;
        if (!v.owner && !d.owner) return toast('Create a seller login first', 'crit');
        await api(`/admin/supplies/storefronts/${d.id}`, { body: { status: 'live', ownerUserId: v.owner || undefined } });
        return reload(`${d.name} is live`);
      }
      if (d.act === 'suspend') {
        const v = await formDialog({ title: `Suspend ${d.name}?`, intro: 'Their products disappear from the marketplace. Open orders can still be completed.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, min: 5 }], confirm: 'Suspend', tone: 'danger' });
        if (!v) return;
        await api(`/admin/supplies/storefronts/${d.id}`, { body: { status: 'suspended', reason: v.reason } });
        return reload(`${d.name} suspended`);
      }
      if (d.act === 'new-seller') {
        const v = await formDialog({
          title: 'Create a seller login',
          intro: 'The seller signs in to the app with this phone number to claim the account.',
          fields: [
            { name: 'companyName', label: 'Business name', required: true },
            { name: 'contactPhone', label: 'Phone (international format)', required: true, placeholder: '+2348031234567' },
            { name: 'contactEmail', label: 'Email (optional)' },
            { name: 'sellerId', label: 'Verified seller in the registry', type: 'select', value: '', options: [{ value: '', label: '— none —' }, ...sellers.filter((s) => !s.owner_user_id).map((s) => ({ value: s.id, label: s.name }))] },
          ],
          confirm: 'Create',
        });
        if (!v) return;
        if (!/^\+[1-9]\d{7,14}$/.test(v.contactPhone)) return toast('Use international format, e.g. +2348031234567', 'crit');
        await api('/admin/advertisers', { body: { companyName: v.companyName, contactPhone: v.contactPhone, contactEmail: v.contactEmail || undefined, sellerId: v.sellerId || undefined } });
        return reload('Seller login created');
      }
    } catch (err) {
      toast(errorText(err), 'crit');
    }
  };

  async function launchOverride() {
    const v = await formDialog({
      title: 'Launch before the milestones are met?',
      intro: html`Not met yet: ${g.items.filter((i) => !i.met).map((i) => `${i.label} (${int(i.value)} of ${int(i.target)})`).join(', ')}.`,
      fields: [{ name: 'reason', label: 'Why launch now? (recorded in the audit log)', type: 'textarea', required: true, min: 10 }],
      confirm: 'Launch anyway',
      tone: 'danger',
    });
    if (!v) return;
    try {
      await setFeature('supplies', true, { reason: v.reason });
      await reload('Supplies marketplace launched');
    } catch (err) {
      toast(errorText(err), 'crit');
    }
  }
}
