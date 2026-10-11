import { api } from '../api.js';
import { ago, empty, esc, formDialog, html, humanize, int, statusTag, tag } from '../ui.js';
import { run } from './approvals.js';
import { openJob } from './job.js';

/**
 * BOQ upload reviews (Section 17): uploaded Bills of Quantities the parser flagged or couldn't read.
 * Technicians must confirm every imported line before the customer sees it; this queue lets admins
 * spot problem files (and parser weaknesses) and help the technician fix them.
 */
export async function renderBoq(view, ctx) {
  const rows = await api('/admin/construction/boq-parse-queue');
  if (!ctx.isCurrent()) return;
  const failed = rows.filter((r) => r.parse_status === 'failed').length;

  view.innerHTML = esc(html`
    <div class="page-head">
      <div><h1>BOQ upload reviews</h1><div class="muted">${rows.length ? `${int(rows.length)} upload${rows.length === 1 ? '' : 's'} need attention${failed ? ` · ${failed} couldn't be read` : ''}` : 'Nothing flagged'}</div></div>
    </div>
    <div class="banner info" style="margin-bottom:16px">Customers never see an uploaded BOQ until the technician has confirmed every line. Word and PDF imports are best-effort and always need that check.</div>
    ${rows.length
      ? rows.map((b) => html`<section class="card stack">
          <div class="row spread">
            <div><h3>Job #${b.short_code} · BOQ v${b.version}</h3><div class="small muted">${b.technician_name} · ${humanize(b.source)} upload · ${ago(b.created_at)}</div></div>
            <div class="row">${statusTag(b.parse_status)} ${tag(`${int(b.lines)} lines`)} ${b.flagged_lines ? tag(`${int(b.flagged_lines)} flagged`, 'warn') : ''}</div>
          </div>
          ${(b.parse_warnings ?? []).length ? html`<ul class="small" style="margin:0;padding-left:18px">${b.parse_warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
          ${(b.flags ?? []).length
            ? html`<div class="table-wrap"><table class="small">
                <thead><tr><th>Line</th><th>File row</th><th>Description</th><th>What to check</th></tr></thead>
                <tbody>${b.flags.map((f) => html`<tr><td>${f.position}</td><td>${f.source_row ?? '—'}</td><td>${f.description}</td><td>${f.flag}</td></tr>`)}</tbody></table></div>`
            : ''}
          <div class="row">
            <button data-act="job" data-id="${b.job_id}">Open job</button>
            <button data-act="dismiss" data-id="${b.id}">Mark reviewed…</button>
          </div>
        </section>`)
      : empty('No flagged uploads', 'Uploads with arithmetic mismatches, missing values, or files that could not be read appear here.')}`);

  view.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'job') return openJob(el.dataset.id);
    if (el.dataset.act === 'dismiss') {
      const v = await formDialog({ title: 'Mark this upload reviewed', intro: 'Removes it from this queue. The technician still has to confirm the lines before submitting.', fields: [{ name: 'note', label: 'Note (optional, kept with the BOQ)', type: 'textarea' }], confirm: 'Mark reviewed' });
      if (v) await run(ctx, () => api(`/admin/construction/boq-parse-queue/${el.dataset.id}/dismiss`, { body: { note: v.note || undefined } }), 'Marked reviewed');
    }
  };
}
