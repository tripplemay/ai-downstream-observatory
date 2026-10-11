import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hosts = new Set(['www.sse.com.cn', 'www.huaan.com.cn', 'www.trahk.com.hk', 'advisors.vanguard.com']);
const market = { CN: [/^\d{6}\.(SH|SZ)$/, 'CNY'], HK: [/^\d{1,5}\.HK$/, 'HKD'], US: [/^[A-Z][A-Z0-9]{0,14}\.US$/, 'USD'] };
const feeKinds = new Set(['management', 'custody', 'operating_composite', 'ongoing_estimate', 'expense_ratio']);
function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), expected.slice().sort());
}
function day(value) {
  assert.equal(typeof value, 'string'); assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(value).toISOString().slice(0, 10), value); return value;
}
function labels(value) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 30);
  assert.equal(new Set(value).size, value.length);
  for (const label of value) assert.match(label, /^[A-Z][A-Z0-9_]{0,99}$/);
}
function rate(value) {
  assert.equal(typeof value, 'string'); assert.match(value, /^0\.\d{1,8}$/);
  const units = BigInt(value.slice(2).padEnd(8, '0'));
  assert.ok(units > 0n && units < 100000000n); return units;
}
export function checkEtfSourceCandidates(document, now = new Date().toISOString().slice(0, 10)) {
  keys(document, ['schema_version', 'researched_on', 'qualification', 'role_basis', 'strategy_input_eligible',
    'live_advice_eligible', 'common_gaps', 'candidates']);
  assert.equal(document.schema_version, 'public-etf-source-candidates-v1');
  assert.equal(document.qualification, 'source_candidates_only');
  assert.equal(document.role_basis, 'analyst_proposal_not_approved');
  assert.equal(document.strategy_input_eligible, false); assert.equal(document.live_advice_eligible, false);
  assert.ok(day(document.researched_on) <= day(now)); labels(document.common_gaps);
  assert.ok(Array.isArray(document.candidates) && document.candidates.length > 0 && document.candidates.length <= 20);
  const symbols = new Set();
  for (const row of document.candidates) {
    keys(row, ['symbol', 'name', 'market', 'currency', 'proposed_role', 'exposure_note', 'listing_date',
      'fee_rates', 'fee_source', 'early_price_sample', 'specific_gaps']);
    assert.ok(market[row.market]); assert.match(row.symbol, market[row.market][0]);
    assert.equal(row.currency, market[row.market][1]); assert.ok(!symbols.has(row.symbol)); symbols.add(row.symbol);
    for (const name of ['name', 'exposure_note']) assert.ok(typeof row[name] === 'string' && row[name].trim() && row[name].length <= 1000);
    assert.ok(['growth', 'defensive', 'diversifier'].includes(row.proposed_role));
    assert.ok(row.listing_date === null || day(row.listing_date) <= document.researched_on);
    assert.ok(['empty_sdk_result', 'two_dates_only', 'not_checked'].includes(row.early_price_sample)); labels(row.specific_gaps);
    keys(row.fee_source, ['url', 'verification', 'as_of', 'date_basis', 'locator']);
    const source = row.fee_source, url = new URL(source.url);
    assert.equal(url.protocol, 'https:'); assert.ok(hosts.has(url.hostname));
    assert.equal(url.username + url.password + url.port, ''); assert.ok(source.url.length <= 2000);
    assert.ok(day(source.as_of) <= document.researched_on);
    assert.ok(['publisher_pdf_visual', 'official_page_read', 'official_search_extract_only'].includes(source.verification));
    assert.ok(['document_prepared_not_historical_effective', 'publisher_effective_prior_year_estimate', 'publisher_ratio_as_of'].includes(source.date_basis));
    assert.ok(typeof source.locator === 'string' && source.locator.length > 0 && source.locator.length <= 300);
    assert.ok(row.fee_rates && typeof row.fee_rates === 'object' && !Array.isArray(row.fee_rates));
    const kinds = Object.keys(row.fee_rates); assert.ok(kinds.length > 0 && kinds.length <= feeKinds.size);
    for (const kind of kinds) { assert.ok(feeKinds.has(kind)); rate(row.fee_rates[kind]); }
    if (kinds.includes('expense_ratio') || kinds.includes('ongoing_estimate')) assert.equal(kinds.length, 1);
    if (kinds.includes('operating_composite')) {
      assert.ok(kinds.includes('management') && kinds.includes('custody'));
      assert.ok(rate(row.fee_rates.operating_composite) >= rate(row.fee_rates.management) + rate(row.fee_rates.custody));
    }
  }
  return { status: 'source_metadata_consistent_not_qualified', candidates: symbols.size,
    strategy_input_eligible: false, live_advice_eligible: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = fileURLToPath(new URL('../config/etf-source-candidates.json', import.meta.url));
  console.log(JSON.stringify(checkEtfSourceCandidates(JSON.parse(readFileSync(file, 'utf8')))));
}
