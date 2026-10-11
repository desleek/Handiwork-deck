/**
 * Bill of Quantities upload parsing (Section 17, Step 2).
 *
 *  - Excel (.xlsx) and CSV: the reliable primary path.
 *  - Word (.docx) and PDF: best-effort, and ALWAYS routed through a mandatory technician review
 *    before the BOQ can reach the customer, so a parsing error never becomes a wrong price.
 *
 * Every parser produces a grid of cells; one shared step finds the header row, maps columns,
 * and turns rows into structured BOQ lines with per-row warnings.
 */
import { inflateSync } from 'node:zlib';
import { readZip } from '../lib/zip.ts';

export type BoqSource = 'excel' | 'csv' | 'word' | 'pdf';
export type Grid = string[][];

export interface ParsedBoqLine {
  kind: 'labor' | 'part';
  description: string;
  unit: string;
  quantity: number;
  unitRateMinor: number;
  markupBps: number;
  sourceRow: number;
  section: string | null;
  flag: string | null;
}

export interface ParsedBoq {
  source: BoqSource;
  lines: ParsedBoqLine[];
  warnings: string[];
  /** True for Word/PDF always, and for Excel/CSV when any line was flagged. */
  needsReview: boolean;
  /** Grand total stated in the file (if found), for a cross-check against the parsed lines. */
  statedTotalMinor: number | null;
}

// ------------------------------------------------------------------------------- XML helpers
const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)![0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ------------------------------------------------------------------------------- XLSX
export function xlsxToGrid(buf: Buffer): Grid {
  const files = readZip(buf, (n) => n.startsWith('xl/'));
  const shared: string[] = [];
  const sst = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decodeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  // First sheet in workbook order.
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const firstRid = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const target = firstRid ? rels.match(new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${firstRid}"`)) : null;
  const sheetPath = target ? 'xl/' + (target[1] ?? target[2]).replace(/^\/?xl\//, '').replace(/^\//, '') : [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  const xml = sheetPath ? files.get(sheetPath)?.toString('utf8') : undefined;
  if (!xml) throw new Error('No worksheet found in the Excel file');

  const grid: Grid = [];
  for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const r = Number(row.match(/\br="(\d+)"/)?.[1] ?? grid.length + 1) - 1;
    const cells: string[] = [];
    for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!ref) continue;
      const t = c.match(/\bt="(\w+)"/)?.[1];
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text = '';
      if (t === 's' && v !== undefined) text = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') text = decodeXml((c.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? ''));
      else if (v !== undefined) text = decodeXml(v);
      cells[colIndex(ref)] = text;
    }
    grid[r] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(grid, (r) => r ?? []);
}

// ------------------------------------------------------------------------------- CSV
export function csvToGrid(text: string): Grid {
  const rows: Grid = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

// ------------------------------------------------------------------------------- DOCX
/** Word: take the table that best looks like a BOQ (most rows with numbers). */
export function docxToGrid(buf: Buffer): Grid {
  const doc = readZip(buf, (n) => n === 'word/document.xml').get('word/document.xml')?.toString('utf8');
  if (!doc) throw new Error('Not a Word document');
  const tables = (doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []).map((tbl) =>
    (tbl.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []).map((tr) =>
      (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) =>
        decodeXml((tc.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim(),
      ),
    ),
  );
  if (tables.length === 0) throw new Error('No table found in the Word document');
  const score = (g: Grid) => g.filter((r) => r.some((c) => /\d/.test(c))).length;
  return tables.sort((a, b) => score(b) - score(a))[0];
}

// ------------------------------------------------------------------------------- PDF (best effort)
interface Run {
  x: number;
  y: number;
  text: string;
  page: number;
}

/** ASCII85 (used by many PDF generators on top of Flate). */
function ascii85Decode(input: Buffer): Buffer {
  const text = input.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of text) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

function pdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) =>
      /^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e,
    );
}

/**
 * Extracts positioned text runs from uncompressed or Flate-compressed content streams and rebuilds
 * table rows by grouping runs on the same baseline. Handles Tj, TJ, ', Td, TD, Tm, T*, TL. Fonts with
 * custom encodings (CID/Identity-H) won't decode — those files fall back to manual entry.
 */
export function pdfToGrid(buf: Buffer): Grid {
  const raw = buf.toString('latin1');
  const runs: Run[] = [];
  // Dictionary of each stream object: from "N G obj <<" to the ">>" right before "stream", never crossing "endobj".
  const streamRe = /\d+\s+\d+\s+obj\s*<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let page = 0;
  while ((m = streamRe.exec(raw))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const lenMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    const end = lenMatch ? start + Number(lenMatch[1]) : raw.indexOf('endstream', start);
    if (end <= start) continue;
    let data: Buffer = buf.subarray(start, end);
    // Apply filters in order; anything other than ASCII85/Flate (e.g. image codecs) is skipped.
    const filters = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1].match(/\/\w+/g) ?? []).map((f) => f.slice(1));
    let ok = true;
    for (const f of filters) {
      try {
        if (f === 'ASCII85Decode' || f === 'A85') data = ascii85Decode(data);
        else if (f === 'FlateDecode' || f === 'Fl') data = inflateSync(data);
        else ok = false;
      } catch {
        ok = false;
      }
      if (!ok) break;
    }
    if (!ok) continue;
    const content = data.toString('latin1');
    if (!/\bBT\b/.test(content)) continue;
    page++;
    let tx = 0, ty = 0, lx = 0, ly = 0, leading = 0;
    const tokens = content.match(/\((?:\\.|[^\\)])*\)|\[[\s\S]*?\]\s*TJ|-?\d*\.?\d+|\/[^\s/<>[\]()]+|[A-Za-z*'"]+/g) ?? [];
    const stack: string[] = [];
    for (const tok of tokens) {
      if (/^-?\d*\.?\d+$/.test(tok) || tok.startsWith('/')) { stack.push(tok); continue; }
      if (tok.startsWith('(')) { stack.push(tok); continue; }
      if (tok.endsWith('TJ') && tok.startsWith('[')) {
        const parts = tok.slice(1, tok.lastIndexOf(']')).match(/\((?:\\.|[^\\)])*\)/g) ?? [];
        const text = parts.map((p) => pdfString(p.slice(1, -1))).join('');
        if (text.trim()) runs.push({ x: tx, y: ty, text, page });
        stack.length = 0;
        continue;
      }
      const num = (i: number) => Number(stack[stack.length - i]);
      switch (tok) {
        case 'BT': tx = ty = lx = ly = 0; break;
        case 'Tm': lx = tx = num(2); ly = ty = num(1); break;
        case 'Td': lx += num(2); ly += num(1); tx = lx; ty = ly; break;
        case 'TD': lx += num(2); ly += num(1); leading = -num(1); tx = lx; ty = ly; break;
        case 'TL': leading = num(1); break;
        case 'T*': ly -= leading; tx = lx; ty = ly; break;
        case 'Tj':
        case "'": {
          if (tok === "'") { ly -= leading; tx = lx; ty = ly; }
          const s = stack[stack.length - 1];
          if (s?.startsWith('(')) {
            const text = pdfString(s.slice(1, -1));
            if (text.trim()) runs.push({ x: tx, y: ty, text, page });
          }
          break;
        }
      }
      stack.length = 0;
    }
  }
  if (runs.length === 0) throw new Error('No readable text in the PDF (it may be scanned or use embedded fonts)');

  // Group runs into rows by page + baseline (2pt tolerance), then into columns by x.
  runs.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const rows: Run[][] = [];
  for (const r of runs) {
    const last = rows[rows.length - 1];
    if (last && last[0].page === r.page && Math.abs(last[0].y - r.y) <= 2) last.push(r);
    else rows.push([r]);
  }
  // Column anchors from the row with the most runs (usually the header).
  const widest = rows.reduce((a, b) => (b.length > a.length ? b : a));
  const anchors = widest.map((r) => r.x).sort((a, b) => a - b);
  return rows.map((row) => {
    const cells: string[] = new Array(anchors.length).fill('');
    for (const r of row) {
      let best = 0;
      for (let i = 0; i < anchors.length; i++) if (Math.abs(anchors[i] - r.x) < Math.abs(anchors[best] - r.x)) best = i;
      cells[best] = (cells[best] ? cells[best] + ' ' : '') + r.text.trim();
    }
    return cells;
  });
}

// ------------------------------------------------------------------------------- grid → BOQ
const HEADER = {
  ref: /^(item|ref\.?|s\/?n|no\.?|#)$/i, // item code column ("A", "1.2"); used as description only if none exists
  description: /desc|particular|item of work|work item|details|scope/i,
  unit: /^units?$|uom|unit of measure/i,
  qty: /qty|quant/i,
  rate: /rate|unit\s*(price|cost)|price\s*\/\s*unit|cost\s*\/\s*unit/i,
  amount: /amount|^total|line total|value|sum/i,
  type: /^type$|category|class|labou?r\s*\/\s*mat/i,
  markup: /mark-?up/i,
};
const LABOR_WORDS = /\b(labou?r|workmanship|wages?|manpower|artisans?|skilled|unskilled|erection labou?r|fixing charge|installation labou?r)\b/i;
const TOTAL_ROW = /\b(sub-?\s*total|grand total|total carried|carried (forward|to)|brought forward|^total\b|vat\b|contingenc)/i;

export function parseMoney(s: string | undefined): number | null {
  if (s === undefined) return null;
  const cleaned = String(s).replace(/[₦,\s]|NGN|N(?=\d)/gi, '').replace(/^\((.*)\)$/, '-$1');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function gridToBoq(grid: Grid, source: BoqSource): ParsedBoq {
  const warnings: string[] = [];
  let headerIdx = -1;
  let cols: Partial<Record<keyof typeof HEADER, number>> = {};
  for (let r = 0; r < Math.min(grid.length, 25) && headerIdx < 0; r++) {
    const row = grid[r] ?? [];
    const found: typeof cols = {};
    row.forEach((cell, c) => {
      const v = String(cell ?? '').trim();
      if (!v) return;
      for (const [k, re] of Object.entries(HEADER) as [keyof typeof HEADER, RegExp][]) {
        if (found[k] === undefined && re.test(v)) {
          found[k] = c;
          break;
        }
      }
    });
    if (found.description === undefined && found.ref !== undefined) found.description = found.ref;
    if (found.description !== undefined && (found.qty !== undefined || found.rate !== undefined)) {
      headerIdx = r;
      cols = found;
    }
  }
  if (headerIdx < 0) {
    throw new Error('Could not find a header row (expected columns like Description, Unit, Qty, Rate, Amount)');
  }
  if (cols.unit === undefined) warnings.push('No Unit column found; units default to "item" and must be checked.');

  const lines: ParsedBoqLine[] = [];
  let section: string | null = null;
  let statedTotal: number | null = null;

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const get = (k: keyof typeof HEADER) => (cols[k] === undefined ? '' : String(row[cols[k]!] ?? '').trim());
    const description = get('description');
    if (!row.some((c) => String(c ?? '').trim())) continue;
    const qty = parseMoney(get('qty'));
    let rate = parseMoney(get('rate'));
    const amount = parseMoney(get('amount'));

    if (TOTAL_ROW.test(description) || (!description && amount !== null && qty === null && rate === null)) {
      if (/grand total|^total\b/i.test(description) || !description) statedTotal = amount;
      continue;
    }
    if (description && qty === null && rate === null && amount === null) {
      section = description; // section heading such as "SUBSTRUCTURE" or "Bill No. 2 – Roofing"
      continue;
    }
    if (!description) {
      warnings.push(`Row ${r + 1}: numbers without a description were skipped.`);
      continue;
    }

    const flags: string[] = [];
    let quantity = qty ?? 0;
    if (qty === null && amount !== null && rate !== null && rate !== 0) {
      quantity = Math.round((amount / rate) * 1000) / 1000;
      flags.push('quantity derived from amount ÷ rate');
    }
    if (rate === null && amount !== null && quantity > 0) {
      rate = Math.round((amount / quantity) * 100) / 100;
      flags.push('rate derived from amount ÷ quantity');
    }
    if (quantity <= 0) flags.push('missing or zero quantity');
    if (rate === null) flags.push('missing rate');
    if (amount !== null && rate !== null && quantity > 0) {
      const expected = quantity * rate;
      if (Math.abs(expected - amount) > Math.max(1, Math.abs(amount) * 0.01)) flags.push(`amount ${amount} ≠ qty × rate (${expected.toFixed(2)})`);
    }

    const typeText = get('type');
    const kind: 'labor' | 'part' = LABOR_WORDS.test(typeText) || (!typeText && LABOR_WORDS.test(description)) ? 'labor' : 'part';
    const markupPct = parseMoney(get('markup')?.replace('%', ''));
    const unit = get('unit') || (cols.unit === undefined ? 'item' : '');
    if (!unit) flags.push('missing unit');

    lines.push({
      kind,
      description: section ? `${description}` : description,
      unit: unit || 'item',
      quantity,
      unitRateMinor: Math.round((rate ?? 0) * 100),
      markupBps: kind === 'part' && markupPct !== null ? Math.round(markupPct * 100) : 0,
      sourceRow: r + 1,
      section,
      flag: flags.length ? flags.join('; ') : null,
    });
  }

  if (lines.length === 0) throw new Error('No priced lines found under the header row');
  const statedTotalMinor = statedTotal !== null ? Math.round(statedTotal * 100) : null;
  if (statedTotalMinor !== null) {
    const parsed = lines.reduce((a, l) => a + Math.round(l.quantity * l.unitRateMinor), 0);
    if (Math.abs(parsed - statedTotalMinor) > Math.max(100, statedTotalMinor * 0.01)) {
      warnings.push(`Parsed lines add up to ₦${(parsed / 100).toLocaleString('en-NG')} but the file states ₦${(statedTotalMinor / 100).toLocaleString('en-NG')}.`);
    }
  }
  const flagged = lines.filter((l) => l.flag).length;
  if (flagged) warnings.push(`${flagged} line(s) need checking.`);
  return {
    source,
    lines,
    warnings,
    needsReview: source === 'word' || source === 'pdf' || flagged > 0 || warnings.length > 0,
    statedTotalMinor,
  };
}

export function detectSource(filename: string, contentType?: string): BoqSource | null {
  const f = filename.toLowerCase();
  if (f.endsWith('.xlsx') || contentType?.includes('spreadsheetml')) return 'excel';
  if (f.endsWith('.csv') || contentType === 'text/csv') return 'csv';
  if (f.endsWith('.docx') || contentType?.includes('wordprocessingml')) return 'word';
  if (f.endsWith('.pdf') || contentType === 'application/pdf') return 'pdf';
  return null;
}

export function parseBoqFile(buf: Buffer, source: BoqSource): ParsedBoq {
  const grid =
    source === 'excel' ? xlsxToGrid(buf) : source === 'csv' ? csvToGrid(buf.toString('utf8')) : source === 'word' ? docxToGrid(buf) : pdfToGrid(buf);
  return gridToBoq(grid, source);
}
