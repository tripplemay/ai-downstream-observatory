import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { Server } from 'node:http';
import path from 'node:path';

export const SERVER_TRACE_LIMITS = Object.freeze({ maxRequests: 20000, maxBytes: 8 * 1024 * 1024 });
const schema = 'workbench-server-trace-v1', slot = Symbol.for('workbench.benchmark.server-trace');
const paths = new Set(['/api/workbench', '/api/workbench/csv/jobs']);
const runPattern = /^[a-f0-9]{32}$/;
const faults = new Set(['INVALID_ID', 'DUPLICATE_ID', 'CAPACITY_EXCEEDED', 'WRITE_ERROR', 'OBSERVER_ERROR']);
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const nano = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const validId = (value, runId) => typeof value === 'string' && new RegExp(`^${runId}:(0|[1-9][0-9]{0,8})$`).test(value);

/**
 * Benchmark-only wall time, not CPU or pre-request socket queue time.
 * @param {{filename: string, runId: string, maxRequests?: number, maxBytes?: number}} options
 */
export function installServerTrace({ filename, runId, maxRequests = SERVER_TRACE_LIMITS.maxRequests, maxBytes = SERVER_TRACE_LIMITS.maxBytes }) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename) && runPattern.test(runId), 'SERVER_TRACE_CONFIG_INVALID');
  assert.ok(integer(maxRequests) && maxRequests > 0 && maxRequests <= SERVER_TRACE_LIMITS.maxRequests
    && integer(maxBytes) && maxBytes >= 4096 && maxBytes <= SERVER_TRACE_LIMITS.maxBytes, 'SERVER_TRACE_LIMIT_INVALID');
  assert.equal(globalThis[slot], undefined, 'SERVER_TRACE_ALREADY_INSTALLED');
  const parent = path.dirname(filename), directory = lstatSync(parent);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && realpathSync(parent) === parent
    && (directory.mode & 0o777) === 0o700 && directory.uid === process.getuid(), 'SERVER_TRACE_DIRECTORY_INVALID');
  const fd = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid(), 'SERVER_TRACE_FILE_INVALID');
  } catch (error) { closeSync(fd); throw error; }
  const origin = process.hrtime.bigint(), active = new Map(), seen = new Set(), failures = new Set();
  const counts = { begun: 0, finished: 0, aborted: 0, incomplete: 0 };
  let bytes = 0, stopped = false, warned = false;
  const now = () => process.hrtime.bigint() - origin;
  const raw = (record, ceiling = maxBytes - 2048) => {
    const buffer = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes + buffer.length > ceiling) return false;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (!written) throw new Error('SHORT_WRITE');
        offset += written; bytes += written;
      }
      return true;
    } catch { failures.add('WRITE_ERROR'); return false; }
  };
  const fault = code => {
    if (!failures.has(code)) { failures.add(code); raw({ type: 'fault', code }, maxBytes - 1024); }
    if (!warned) { warned = true; try { writeSync(2, 'WORKBENCH_SERVER_TRACE_INTEGRITY_FAILED\n'); } catch {} }
  };
  const append = record => {
    if (raw(record)) return true;
    fault(failures.has('WRITE_ERROR') ? 'WRITE_ERROR' : 'CAPACITY_EXCEEDED'); return false;
  };
  if (!append({ type: 'header', schema_version: schema, run_id: runId, clock: 'process.hrtime.bigint', max_requests: maxRequests, max_bytes: maxBytes })) {
    closeSync(fd); throw new Error('SERVER_TRACE_OPEN_FAILED');
  }
  const terminal = (entry, outcome) => {
    if (stopped || !active.has(entry.request_id)) return;
    active.delete(entry.request_id); counts[outcome === 'finish' ? 'finished' : outcome]++;
    const end = now(), status = entry.response.headersSent ? entry.response.statusCode : null;
    append({ type: outcome, request_id: entry.request_id, trace_id: entry.trace_id, status,
      at_ns: String(end), duration_ns: String(end - entry.started) });
  };
  const observe = (request, response) => {
    if (stopped || !['GET', 'POST'].includes(request.method) || typeof request.url !== 'string') return;
    const pathname = request.url.split('?', 1)[0];
    if (!paths.has(pathname)) return;
    const id = request.headers['x-workbench-benchmark-id'];
    if (id === undefined) return;
    if (!validId(id, runId)) { fault('INVALID_ID'); return; }
    if (seen.has(id)) { fault('DUPLICATE_ID'); return; }
    if (seen.size >= maxRequests || failures.has('CAPACITY_EXCEEDED') || failures.has('WRITE_ERROR')) { fault('CAPACITY_EXCEEDED'); return; }
    seen.add(id);
    const started = now(), entry = { request_id: id, trace_id: `trace:${seen.size}`, started, response };
    if (!append({ type: 'begin', request_id: id, trace_id: entry.trace_id, method: request.method, path: pathname, at_ns: String(started) })) return;
    counts.begun++; active.set(id, entry);
    response.once('finish', () => { try { terminal(entry, 'finish'); } catch { fault('OBSERVER_ERROR'); } });
    response.once('close', () => { try { terminal(entry, 'aborted'); } catch { fault('OBSERVER_ERROR'); } });
  };
  const original = Server.prototype.emit;
  const patched = function (event, ...args) {
    if (event === 'request') { try { observe(args[0], args[1]); } catch { fault('OBSERVER_ERROR'); } }
    return Reflect.apply(original, this, [event, ...args]);
  };
  const stop = () => {
    if (stopped) return;
    for (const entry of active.values()) terminal(entry, 'incomplete');
    stopped = true;
    if (Server.prototype.emit === patched) Server.prototype.emit = original;
    delete globalThis[slot]; process.removeListener('exit', stop);
    raw({ type: 'summary', status: failures.size || counts.aborted || counts.incomplete ? 'FAIL' : 'PASS', ...counts,
      faults: [...failures].sort(), bytes_before_summary: bytes }, maxBytes);
    try { closeSync(fd); } catch { fault('WRITE_ERROR'); }
  };
  Server.prototype.emit = patched; globalThis[slot] = { stop }; process.once('exit', stop);
  return Object.freeze({ stop });
}

/** Strict replay of the journal; missing telemetry never becomes a zero-duration success. */
export function summarizeServerTrace(text, runId) {
  const errors = [], requests = Object.create(null), begins = new Map(), ids = new Set(), recordedFaults = new Set();
  const counts = { begun: 0, finished: 0, aborted: 0, incomplete: 0 };
  let limits = null;
  const fail = message => { if (!errors.includes(message)) errors.push(message); };
  try {
    assert.ok(runPattern.test(runId) && typeof text === 'string' && Buffer.byteLength(text) <= SERVER_TRACE_LIMITS.maxBytes && text.endsWith('\n'), 'TRACE_BYTES_INVALID');
    const lines = text.slice(0, -1).split('\n');
    assert.ok(lines.length >= 2 && lines.length <= SERVER_TRACE_LIMITS.maxRequests * 2 + faults.size + 2, 'TRACE_RECORD_COUNT_INVALID');
    let header = null, summary = null, previous = 0n, bytesBefore = 0;
    for (const [index, line] of lines.entries()) {
      const value = JSON.parse(line); assert.equal(JSON.stringify(value), line, 'TRACE_NONCANONICAL_JSON');
      if (index === 0) {
        assert.ok(sameKeys(value, ['type', 'schema_version', 'run_id', 'clock', 'max_requests', 'max_bytes'])
          && value.type === 'header' && value.schema_version === schema && value.run_id === runId && value.clock === 'process.hrtime.bigint'
          && integer(value.max_requests) && value.max_requests > 0 && value.max_requests <= SERVER_TRACE_LIMITS.maxRequests
          && integer(value.max_bytes) && value.max_bytes >= 4096 && value.max_bytes <= SERVER_TRACE_LIMITS.maxBytes, 'TRACE_HEADER_INVALID');
        header = value; limits = { max_requests: value.max_requests, max_bytes: value.max_bytes };
        assert.ok(Buffer.byteLength(text) <= value.max_bytes, 'TRACE_CAPACITY_EXCEEDED');
      } else if (value.type === 'summary') {
        assert.equal(index, lines.length - 1, 'TRACE_TRAILING_RECORD');
        assert.ok(sameKeys(value, ['type', 'status', 'begun', 'finished', 'aborted', 'incomplete', 'faults', 'bytes_before_summary']), 'TRACE_SUMMARY_INVALID');
        assert.ok(['PASS', 'FAIL'].includes(value.status) && Array.isArray(value.faults)
          && value.faults.every(code => faults.has(code)) && [...value.faults].sort().join('|') === value.faults.join('|')
          && new Set(value.faults).size === value.faults.length, 'TRACE_SUMMARY_INVALID');
        for (const key of Object.keys(counts)) assert.ok(integer(value[key]) && value[key] === counts[key], 'TRACE_COUNT_MISMATCH');
        assert.equal(value.bytes_before_summary, bytesBefore, 'TRACE_BYTE_COUNT_MISMATCH');
        for (const code of value.faults) fail(code);
        assert.deepEqual(value.faults, [...recordedFaults].sort(), 'TRACE_FAULT_MISMATCH'); summary = value;
      } else if (value.type === 'fault') {
        assert.ok(sameKeys(value, ['type', 'code']) && faults.has(value.code) && !recordedFaults.has(value.code), 'TRACE_FAULT_INVALID');
        recordedFaults.add(value.code); fail(value.code);
      } else {
        assert.ok(nano(value.at_ns) && BigInt(value.at_ns) >= previous, 'TRACE_CLOCK_INVALID'); previous = BigInt(value.at_ns);
        assert.ok(validId(value.request_id, runId), 'TRACE_ID_INVALID');
        if (value.type === 'begin') {
          assert.ok(sameKeys(value, ['type', 'request_id', 'trace_id', 'method', 'path', 'at_ns']) && ['GET', 'POST'].includes(value.method) && paths.has(value.path), 'TRACE_BEGIN_INVALID');
          assert.ok(!ids.has(value.request_id) && value.trace_id === `trace:${counts.begun + 1}` && counts.begun < header.max_requests, 'TRACE_DUPLICATE_ID');
          ids.add(value.request_id); begins.set(value.request_id, value); counts.begun++;
        } else {
          assert.ok(['finish', 'aborted', 'incomplete'].includes(value.type) && sameKeys(value, ['type', 'request_id', 'trace_id', 'status', 'at_ns', 'duration_ns']), 'TRACE_TERMINAL_INVALID');
          const begin = begins.get(value.request_id);
          assert.ok(begin && begin.trace_id === value.trace_id && nano(value.duration_ns)
            && BigInt(value.duration_ns) === BigInt(value.at_ns) - BigInt(begin.at_ns), 'TRACE_PAIR_INVALID');
          assert.ok(value.status === null || integer(value.status) && value.status >= 100 && value.status <= 599, 'TRACE_STATUS_INVALID');
          assert.ok(value.type !== 'finish' || value.status !== null, 'TRACE_FINISH_STATUS_MISSING');
          begins.delete(value.request_id); counts[value.type === 'finish' ? 'finished' : value.type]++;
          const elapsed = Number(BigInt(value.duration_ns)) / 1e6;
          requests[value.request_id] = { trace_id: value.trace_id, method: begin.method, path: begin.path, status: value.status, outcome: value.type,
            started_ns: begin.at_ns, completed_ns: value.at_ns, duration_ms: value.type === 'incomplete' ? null : elapsed };
        }
      }
      bytesBefore += Buffer.byteLength(line) + 1;
    }
    assert.ok(summary, 'TRACE_SUMMARY_MISSING'); assert.equal(begins.size, 0, 'TRACE_TERMINAL_MISSING');
    if (counts.aborted) fail('TRACE_ABORTED'); if (counts.incomplete) fail('TRACE_INCOMPLETE');
    assert.equal(summary.status, errors.length ? 'FAIL' : 'PASS', 'TRACE_STATUS_MISMATCH');
  } catch (error) { fail(error instanceof Error && /^TRACE_[A-Z_]+$/.test(error.message) ? error.message : 'TRACE_INVALID'); }
  return { schema_version: 'workbench-server-trace-summary-v1', run_id: runId, status: errors.length ? 'FAIL' : 'PASS', errors, limits, counts, requests };
}

/** @param {Record<string, string | undefined>} environment */
export function installServerTraceFromEnvironment(environment = process.env) {
  const filename = environment.WORKBENCH_SERVER_TRACE_PATH, runId = environment.WORKBENCH_SERVER_TRACE_RUN_ID;
  if (filename === undefined && runId === undefined) return null;
  return installServerTrace({ filename, runId });
}

installServerTraceFromEnvironment();
