import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'web/package.json'));
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const validator = new Ajv2020({ allErrors: true, strict: true });
addFormats(validator);
for (const file of readdirSync(join(root, 'contracts/v1')).filter((name) => name.endsWith('.schema.json'))) {
  validator.addSchema(JSON.parse(readFileSync(join(root, 'contracts/v1', file), 'utf8')));
}
const validate = validator.getSchema('https://etf-workbench.invalid/contracts/v1/ledger-command.schema.json');
const decimal = validator.compile({ $ref: 'https://etf-workbench.invalid/contracts/v1/common.schema.json#/$defs/decimal' });

const command = (fact) => ({
  portfolio_id: 'p-test', expected_revision: 0, idempotency_key: 'command-1', source_id: 'manual',
  effective_at: '2026-01-01', time_precision: 'date', source_timezone: 'Asia/Shanghai', reason: 'Synthetic fixture',
  fact: { account_id: 'a-test', currency: 'CNY', ...fact },
});

test('E-15: decimal facts reject floats, exponent notation, grouping, excess scale and precision', () => {
  for (const value of ['0', '-1', '99999999999999999999999999999999999999', '0.000000000000000001', '1000000.01']) {
    assert.equal(decimal(value), true, `accepted ${value}`);
  }
  for (const value of [1, 0.1, null, 'NaN', 'Infinity', '1e3', '1,000', ' 1', '+1', '01', '0.0000000000000000001', '999999999999999999999999999999999999999', '99999999999999999999999999999999999999.1']) {
    assert.equal(decimal(value), false, `rejected ${String(value)}`);
  }
});

test('E-03/E-15: all supported facts pass their event-specific shapes', () => {
  const value_evidence = { schema_version: 'security-transfer-value-v1', reference: 'Synthetic confirmation', effective_at: '2026-01-01', time_precision: 'date', source_timezone: 'Asia/Shanghai' };
  const examples = [
    { type: 'opening_cash', amount: '100000' },
    { type: 'opening_position', listing_id: 'ETF:001', quantity: '100' },
    { type: 'opening_position', listing_id: 'ETF:001', quantity: '100', cost_amount: '2000' },
    { type: 'deposit', amount: '500000' },
    { type: 'withdrawal', amount: '1000' },
    { type: 'buy', listing_id: 'ETF:001', quantity: '1000', price: '10', fee: '10' },
    { type: 'sell', listing_id: 'ETF:001', quantity: '400', consideration: '4800', fee: '4' },
    { type: 'settlement', direction: 'buy', related_event_id: 'buy-1', amount: '10010' },
    { type: 'dividend_accrual', amount: '200', tax: '20' },
    { type: 'dividend_payment', related_event_id: 'dividend-1', amount: '180' },
    { type: 'dividend', amount: '200', tax: '20' },
    { type: 'fee', amount: '10' },
    { type: 'fx', amount: '7000', target_currency: 'USD', received_amount: '1000', fee: '7' },
    { type: 'transfer_out', target_account_id: 'a-other', amount: '30000', fee: '10' },
    { type: 'transfer_in', related_event_id: 'transfer-1', amount: '30000' },
    { type: 'split', listing_id: 'ETF:001', split_numerator: '2', split_denominator: '1' },
    { type: 'security_in', listing_id: 'ETF:001', quantity: '10', market_value: '100', value_evidence },
    { type: 'security_in', listing_id: 'ETF:001', quantity: '10', market_value: '100', cost_amount: '80', value_evidence },
    { type: 'security_out', listing_id: 'ETF:001', quantity: '10', market_value: '100', value_evidence },
    { type: 'security_transfer_out', listing_id: 'ETF:001', quantity: '10', target_account_id: 'a-other' },
    { type: 'security_transfer_in', listing_id: 'ETF:001', quantity: '5', related_event_id: 'out-1' },
    { type: 'security_transfer_return', listing_id: 'ETF:001', quantity: '5', related_event_id: 'out-1' },
  ];
  for (const example of examples) assert.equal(validate(command(example)), true, JSON.stringify({ example, errors: validate.errors }));
});

test('E-15/E-17: no ignored fee/tax or server identity injection; require actual date precision', () => {
  const invalid = [
    command({ type: 'deposit', amount: '1', fee: '10' }),
    command({ type: 'buy', listing_id: 'ETF:001', quantity: '1', price: '10', tax: '10' }),
    command({ type: 'buy', listing_id: 'ETF:001', quantity: '1' }),
    command({ type: 'settlement', amount: '10' }),
    command({ type: 'fee', amount: '1', unknown: 'ignore' }),
    { ...command({ type: 'deposit', amount: '1' }), actor_id: 'spoofed-user' },
    { ...command({ type: 'deposit', amount: '1' }), effective_at: '2026-02-30' },
    { ...command({ type: 'deposit', amount: '1' }), effective_at: '2026-01-01T00:00:00Z' },
    { ...command({ type: 'deposit', amount: '1' }), time_precision: 'second' },
    { ...command({ type: 'deposit', amount: '1' }), time_precision: 'second', effective_at: '2026-01-01T00:00:00+08:00' },
  ];
  for (const value of invalid) assert.equal(validate(value), false, JSON.stringify(value));
  assert.equal(validate({ ...command({ type: 'deposit', amount: '1' }), time_precision: 'second', effective_at: '2026-01-01T00:00:00.000Z' }), true);
});

test('E-22: immutable event contract rejects simulation environment', () => {
  const check = validator.getSchema('https://etf-workbench.invalid/contracts/v1/ledger-event.schema.json');
  const payload = command({ type: 'deposit', amount: '1' });
  const event = {
    id: 'event-1', portfolio_id: payload.portfolio_id, account_id: payload.fact.account_id,
    environment: 'actual', event_type: 'deposit', effective_at: payload.effective_at, time_precision: payload.time_precision,
    source_timezone: payload.source_timezone, recorded_at: '2026-01-01T00:00:00Z', source_id: payload.source_id,
    idempotency_key: payload.idempotency_key, payload_hash: 'a'.repeat(64), payload, schema_version: 1,
    ledger_revision: 1, actor_id: 'owner', reason: payload.reason,
  };
  assert.equal(check(event), true, JSON.stringify(check.errors));
  assert.equal(check({ ...event, environment: 'simulation' }), false);
});

test('E-12: a date-only observation cannot invent an instant or omit provenance', () => {
  const check = validator.getSchema('https://etf-workbench.invalid/contracts/v1/market-observation.schema.json');
  const observation = {
    id: 'price-1', batch_id: 'batch-1', source_id: 'fixture', listing_id: 'ETF:001', series_key: 'ETF:001',
    metric: 'close', value: '10', unit: 'CNY', observed_at: '2026-01-01', ingested_at: '2026-01-02T00:00:00Z',
    source_timezone: 'Asia/Shanghai', time_precision: 'date', price_basis: 'unadjusted', revision_id: 'r1',
    raw_hash: 'a'.repeat(64), parser_version: 'v1', provenance: 'reconstructed',
  };
  assert.equal(check(observation), true, JSON.stringify(check.errors));
  assert.equal(check({ ...observation, observed_at: '2026-01-01T00:00:00Z' }), false);
  const missing = { ...observation }; delete missing.provenance;
  assert.equal(check(missing), false);
});

test('E-12/E-13: reversal payload is distinct from user facts and requires original evidence links', () => {
  const check = validator.getSchema('https://etf-workbench.invalid/contracts/v1/ledger-event.schema.json');
  const event = {
    id: 'reversal-1', portfolio_id: 'p-test', account_id: 'a-test', environment: 'actual', event_type: 'reversal',
    effective_at: '2026-01-01', time_precision: 'date', source_timezone: 'Asia/Shanghai', recorded_at: '2026-08-01T00:00:00Z',
    source_id: 'correction:1', idempotency_key: 'reverse:1', payload_hash: 'a'.repeat(64), schema_version: 1,
    ledger_revision: 2, actor_id: 'owner', reason: 'Synthetic correction', reversal_of: 'event-1',
    payload: { kind: 'ledger_reversal', original_event_id: 'event-1', original_payload_hash: 'b'.repeat(64), correction_id: 'c-1', attachment_id: 'a-1', reason: 'Synthetic correction' },
  };
  assert.equal(check(event), true, JSON.stringify(check.errors));
  const missing = { ...event }; delete missing.reversal_of;
  assert.equal(check(missing), false);
  assert.equal(check({ ...event, event_type: 'deposit' }), false);
  assert.equal(check({ ...event, payload: command({ type: 'deposit', amount: '1' }) }), false);
  assert.equal(validate(command({ type: 'reversal', reversal_of: 'event-1' })), false);
});

test('E-10/E-12: manual market batches require evidence and empty or unknown source modes fail', () => {
  const check = validator.getSchema('https://etf-workbench.invalid/contracts/v1/market-batch.schema.json');
  const observation = {
    id: 'price-1', batch_id: 'batch-1', source_id: 'fixture', series_key: 'ETF:001', metric: 'close', value: '10', unit: 'CNY',
    observed_at: '2026-01-01', ingested_at: '2026-01-02T00:00:00Z', source_timezone: 'Asia/Shanghai', time_precision: 'date',
    price_basis: 'unadjusted', revision_id: 'r1', raw_hash: 'a'.repeat(64), parser_version: 'v1', provenance: 'reconstructed',
  };
  const batch = {
    schema_version: 'market-batch-v1',
    batch: { id: 'batch-1', source_id: 'fixture', batch_type: 'prices', scope: 'CN', expected_pages: 1, expected_rows: 1, expected_publication_revision: 0, source_mode: 'synthetic' },
    pages: [{ page_number: 1, observations: [observation] }],
  };
  assert.equal(check(batch), true, JSON.stringify(check.errors));
  assert.equal(check({ ...batch, pages: [] }), false);
  assert.equal(check({ ...batch, batch: { ...batch.batch, source_mode: 'live_trusted' } }), false);
  assert.equal(check({ ...batch, batch: { ...batch.batch, source_mode: 'manual_verified' } }), false);
  assert.equal(check({ ...batch, batch: { ...batch.batch, source_mode: 'manual_verified', source_evidence: 'Synthetic manually checked fixture' } }), true);
});
