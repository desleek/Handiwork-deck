// Small rendering toolkit: escaped HTML templates, formatting, dialogs, drawers, toasts.
// No framework — every view renders an HTML string and handles clicks by delegation.

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

/** Mark a string as trusted HTML (only for markup we built ourselves). */
export const raw = (s) => new Raw(s);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Tagged template: every interpolated value is escaped unless it is itself html`` or raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += esc(vals[i]);
  });
  return new Raw(out);
}

/** Only allow http(s) links from data (evidence, documents, images). */
export function safeUrl(u) {
  try {
    const url = new URL(String(u), location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}

// ---------------------------------------------------------------- formatting
const ngn = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const ngn2 = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });
export const money = (minor) => (minor === null || minor === undefined ? '—' : (Number(minor) % 100 ? ngn2 : ngn).format(Number(minor) / 100));
export const compactMoney = (minor) => {
  const n = Number(minor ?? 0) / 100;
  if (Math.abs(n) >= 1e9) return `₦${(n / 1e9).toFixed(1)}bn`;
  if (Math.abs(n) >= 1e6) return `₦${(n / 1e6).toFixed(1)}m`;
  if (Math.abs(n) >= 1e4) return `₦${(n / 1e3).toFixed(0)}k`;
  return ngn.format(n);
};
export const pct = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 1 : 0)}%`;
export const int = (n) => new Intl.NumberFormat('en-NG').format(Number(n ?? 0));
export const date = (d) => (d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (d) => (d ? new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
export function ago(d) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const toMinor = (naira) => Math.round(Number(String(naira).replace(/[^0-9.]/g, '')) * 100);
export const humanize = (s) => String(s ?? '').replace(/_/g, ' ');

// ---------------------------------------------------------------- fragments
export const tag = (label, tone = '') => html`<span class="tag ${tone}">${label}</span>`;
export const empty = (title, body = '') => html`<div class="empty"><strong>${title}</strong>${body}</div>`;
export const loading = () => html`<div class="loading">Loading…</div>`;
export const link = (href, label) => html`<a href="${safeUrl(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

export function statusTag(status) {
  const s = String(status ?? '');
  const tone = /approved|verified|live|released|completed|resolved|paid|active|good/.test(s)
    ? 'good'
    : /reject|declin|fail|suspend|disput|refund|escalat|crit/.test(s)
      ? 'crit'
      : /pending|review|draft|needs|warn|open/.test(s)
        ? 'warn'
        : '';
  return tag(humanize(s), tone);
}

// ---------------------------------------------------------------- toasts
export function toast(message, tone = '') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), tone === 'crit' ? 7000 : 3500);
}

// ---------------------------------------------------------------- dialog form
/**
 * Modal form. fields: [{ name, label, type: text|textarea|number|money|select|checkbox, required, value, options, min, hint }]
 * Resolves with { name: value } or null if cancelled. Money fields return minor units.
 */
export function formDialog({ title, intro = '', fields = [], confirm = 'Confirm', tone = 'primary' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const fieldHtml = fields.map((f) => {
      const id = `f-${f.name}`;
      const req = f.required ? 'required' : '';
      if (f.type === 'checkbox') {
        return html`<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? raw('checked') : ''} /> ${f.label}</label>`;
      }
      let control;
      if (f.type === 'textarea') control = html`<textarea id="${id}" name="${f.name}" ${raw(req)} minlength="${f.min ?? 0}">${f.value ?? ''}</textarea>`;
      else if (f.type === 'select') {
        control = html`<select id="${id}" name="${f.name}" ${raw(req)}>${f.options.map((o) => html`<option value="${o.value}" ${o.value === f.value ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
      } else {
        const type = f.type === 'money' || f.type === 'number' ? 'number' : 'text';
        control = html`<input id="${id}" name="${f.name}" type="${type}" ${raw(req)} value="${f.value ?? ''}" step="any" ${f.min !== undefined && type === 'number' ? raw(`min="${f.min}"`) : ''} placeholder="${f.placeholder ?? ''}" />`;
      }
      return html`<label class="field" for="${id}">${f.label}${f.type === 'money' ? ' (₦)' : ''}${control}${f.hint ? html`<span class="tiny faint">${f.hint}</span>` : ''}</label>`;
    });
    dlg.innerHTML = esc(html`
      <form method="dialog">
        <div class="dialog-body">
          <h2>${title}</h2>
          ${intro ? html`<div class="muted">${intro}</div>` : ''}
          ${fieldHtml}
          <div class="banner crit hidden" data-error></div>
        </div>
        <div class="dialog-foot">
          <button type="button" data-cancel>Cancel</button>
          <button type="submit" class="${tone}">${confirm}</button>
        </div>
      </form>`);
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.querySelector('[data-cancel]').onclick = () => done(null);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const el = form.elements[f.name];
        if (f.type === 'checkbox') out[f.name] = el.checked;
        else if (f.type === 'money') out[f.name] = el.value === '' ? undefined : toMinor(el.value);
        else if (f.type === 'number') out[f.name] = el.value === '' ? undefined : Number(el.value);
        else out[f.name] = el.value.trim();
        if (f.required && (out[f.name] === '' || out[f.name] === undefined)) {
          const err = dlg.querySelector('[data-error]');
          err.textContent = `${f.label} is required`;
          err.classList.remove('hidden');
          return;
        }
        if (f.min && f.type === 'textarea' && out[f.name].length < f.min) {
          const err = dlg.querySelector('[data-error]');
          err.textContent = `${f.label} needs at least ${f.min} characters`;
          err.classList.remove('hidden');
          return;
        }
      }
      done(out);
    };
    dlg.showModal();
    dlg.querySelector('input, textarea, select')?.focus();
  });
}

export const confirmDialog = (title, intro, confirm = 'Confirm', tone = 'primary') => formDialog({ title, intro, confirm, tone }).then((v) => v !== null);

// ---------------------------------------------------------------- drawer
let drawerEl = null;
export function openDrawer(title, bodyHtml, onClick) {
  closeDrawer();
  const scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  drawerEl = document.createElement('aside');
  drawerEl.className = 'drawer';
  drawerEl.setAttribute('role', 'dialog');
  drawerEl.setAttribute('aria-modal', 'true');
  drawerEl.innerHTML = esc(html`<div class="drawer-head"><h2>${title}</h2><button class="ghost" data-close aria-label="Close">Close ✕</button></div><div class="drawer-body">${bodyHtml}</div>`);
  drawerEl._scrim = scrim;
  scrim.onclick = closeDrawer;
  drawerEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeDrawer();
    onClick?.(e);
  });
  document.body.append(scrim, drawerEl);
  drawerEl.querySelector('[data-close]').focus();
  return drawerEl;
}
export function closeDrawer() {
  if (!drawerEl) return;
  drawerEl._scrim.remove();
  drawerEl.remove();
  drawerEl = null;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerEl && !document.querySelector('dialog[open]')) closeDrawer();
});

// ---------------------------------------------------------------- tooltip (charts)
const tip = () => document.getElementById('tooltip');
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  const el = tip();
  if (!el) return;
  if (!t) {
    el.hidden = true;
    return;
  }
  el.textContent = t.getAttribute('data-tip');
  el.hidden = false;
  el.style.left = `${Math.min(e.clientX + 14, innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${e.clientY + 14}px`;
});
