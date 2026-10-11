import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { csvToGrid, gridToBoq, parseBoqFile, parseMoney, type BoqSource } from '../src/domain/boqParse.ts';

const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f));
const N = 100;

/** Same BOQ in four formats; every parser must recover the same six priced lines. */
const EXPECTED = [
  { description: 'Excavate foundation trench', unit: 'm3', quantity: 24, unitRateMinor: 4_500 * N, kind: 'part' },
  { description: 'Concrete 1:2:4 in strip foundation', unit: 'm3', quantity: 12, unitRateMinor: 85_000 * N, kind: 'part' },
  { description: 'Labour: setting out and blinding', unit: 'item', quantity: 1, unitRateMinor: 60_000 * N, kind: 'labor' },
  { description: '225mm sandcrete blocks', unit: 'nr', quantity: 1800, unitRateMinor: 650 * N, kind: 'part' },
  { description: 'Bricklayer workmanship to block walls', unit: 'm2', quantity: 220, unitRateMinor: 1_500 * N, kind: 'labor' },
  { description: 'Y12 reinforcement bars', unit: 'tonnes', quantity: 1.5, unitRateMinor: 1_100_000 * N, kind: 'part' },
];

for (const [file, source] of [['boq.xlsx', 'excel'], ['boq.csv', 'csv'], ['boq.docx', 'word'], ['boq.pdf', 'pdf']] as [string, BoqSource][]) {
  test(`parses ${file}`, () => {
    const r = parseBoqFile(fx(file), source);
    assert.deepEqual(
      r.lines.map(({ description, unit, quantity, unitRateMinor, kind }) => ({ description, unit, quantity, unitRateMinor, kind })),
      EXPECTED,
    );
    assert.equal(r.statedTotalMinor, 4_338_000 * N);
    assert.equal(r.lines.filter((l) => l.flag).length, 0, JSON.stringify(r.lines.filter((l) => l.flag)));
    assert.deepEqual([...new Set(r.lines.map((l) => l.section))], ['SUBSTRUCTURE', 'SUPERSTRUCTURE']);
    // Word & PDF always require technician review before the customer sees anything.
    assert.equal(r.needsReview, source === 'word' || source === 'pdf');
  });
}

test('flags arithmetic mismatches, derives missing values, and checks the stated total', () => {
  const grid = csvToGrid(
    'Description,Unit,Qty,Rate,Amount\nRoof sheets,sheet,40,9000,360000\nNails,kg,,1500,30000\nWrong row,m2,10,100,5000\nTotal,,,,999999\n',
  );
  const r = gridToBoq(grid, 'csv');
  assert.equal(r.lines[1].quantity, 20);
  assert.match(r.lines[1].flag!, /quantity derived/);
  assert.match(r.lines[2].flag!, /≠ qty × rate/);
  assert.ok(r.warnings.some((w) => /states/.test(w)));
  assert.equal(r.needsReview, true);
});

test('rejects files without a recognisable header', () => {
  assert.throws(() => gridToBoq(csvToGrid('foo,bar\n1,2\n'), 'csv'), /header row/);
});

test('money parsing handles naira formatting', () => {
  assert.equal(parseMoney('₦1,250,000.50'), 1250000.5);
  assert.equal(parseMoney('NGN 4,500'), 4500);
  assert.equal(parseMoney('(2,000)'), -2000);
  assert.equal(parseMoney(''), null);
});
