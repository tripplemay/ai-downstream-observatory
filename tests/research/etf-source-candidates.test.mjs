import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkEtfSourceCandidates } from '../../scripts/check-etf-source-candidates.mjs';

const source = JSON.parse(readFileSync(new URL('../../config/etf-source-candidates.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(source);
const check = data => checkEtfSourceCandidates(data, '2026-10-08');

test('six public source candidates keep qualification and fee bases separate', () => {
  assert.deepEqual(check(source), { status: 'source_metadata_consistent_not_qualified', candidates: 6,
    strategy_input_eligible: false, live_advice_eligible: false });
  const bond = source.candidates.find(row => row.symbol === '511010.SH');
  assert.equal(bond.fee_rates.operating_composite, '0.0021');
  const gold = source.candidates.find(row => row.symbol === '518880.SH');
  assert.equal(gold.fee_rates.operating_composite, '0.0067');
  assert.ok(source.candidates.find(row => row.symbol === 'BND.US').specific_gaps.includes('CONFLICTING_PAGE_INCEPTION_DATES'));
});

test('cannot upgrade eligibility, qualification or add weights, prices and credentials', () => {
  for (const change of [data => data.strategy_input_eligible = true, data => data.live_advice_eligible = true,
    data => data.qualification = 'approved', data => data.weights = { 'VT.US': '1' },
    data => data.candidates[0].price = '10', data => data.candidates[0].app_key = 'fixture-only']) {
    const data = copy(); change(data); assert.throws(() => check(data));
  }
});

test('incompatible mapping, duplicates, malformed and future dates are rejected', () => {
  for (const change of [data => data.candidates[0].market = 'US', data => data.candidates[0].currency = 'USD',
    data => data.candidates.push(data.candidates[0]), data => data.researched_on = '2026-10-09',
    data => data.candidates[0].listing_date = '2026-02-30', data => data.candidates[0].fee_source.as_of = '2027-01-01']) {
    const data = copy(); change(data); assert.throws(() => check(data));
  }
});

test('missing and incompatible fee definitions cannot be zero-filled or added together', () => {
  for (const rates of [{}, { management: '0' }, { management: 0.0015 }, { management: '-0.001' },
    { management: 'NaN' }, { management: '0.000000001' }, { expense_ratio: '0.001', custody: '0.0005' },
    { management: '0.0015', custody: '0.0005', operating_composite: '0.0015' }]) {
    const data = copy(); data.candidates[0].fee_rates = rates; assert.throws(() => check(data));
  }
});

test('primary source provenance and explicit unresolved labels are required', () => {
  for (const change of [data => data.candidates[0].fee_source.url = 'http://www.sse.com.cn/example.pdf',
    data => data.candidates[0].fee_source.url = 'https://www.sse.com.cn.evil.invalid/example.pdf',
    data => data.candidates[0].fee_source.url = 'https://secret@www.sse.com.cn/example.pdf',
    data => data.candidates[0].fee_source.verification = 'provider_certified',
    data => data.candidates[0].fee_source.date_basis = 'valid_for_all_history',
    data => data.common_gaps = [], data => data.candidates[0].specific_gaps = ['unknown', 'unknown']]) {
    const data = copy(); change(data); assert.throws(() => check(data));
  }
});
