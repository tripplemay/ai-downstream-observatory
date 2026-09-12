import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { probeEarlyRejection } from '../../web/scripts/http-early-rejection.mjs';

const LIMIT = 1024;
const body = Buffer.from('{"error":"REQUEST_TOO_LARGE"}');
const headers = { 'Content-Type': 'multipart/form-data; boundary=synthetic-limit' };

async function serverFixture(t, respond, limit = LIMIT) {
  const observed = { requests: 0, bytes: 0, ended: false, complete: false, headers: null };
  const server = http.createServer((request, response) => {
    observed.requests++; observed.headers = request.headers;
    request.on('error', () => {}); response.on('error', () => {});
    request.on('end', () => { observed.ended = true; });
    request.on('data', chunk => {
      observed.bytes += chunk.length;
      if (observed.bytes >= limit + 1 && !observed.responded) {
        observed.responded = true; observed.complete = request.complete;
        respond(request, response);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/synthetic-limit`, observed };
}

function reply(response, { status = 413, bytes = body, connection = 'close', type = 'application/json' } = {}) {
  response.writeHead(status, { 'Content-Type': type, Connection: connection, 'Content-Length': bytes.length });
  response.end(bytes);
}
const options = { limitBytes: LIMIT, chunkBytes: 128, deadlineMs: 2000 };

test('real chunked transport obtains complete 413 before sending an end marker, without Content-Length or retry', async t => {
  const f = await serverFixture(t, (_request, response) => reply(response));
  const proof = await probeEarlyRejection(f.url, headers, options);
  assert.equal(proof.status, 413); assert.deepEqual(proof.json, { error: 'REQUEST_TOO_LARGE' });
  assert.equal(proof.headers.get('connection'), 'close'); assert.equal(proof.response_complete, true);
  assert.equal(proof.request_ended, false); assert.equal(proof.bytes_sent, LIMIT + 1);
  assert.equal(proof.response_bytes, body.length); assert.equal(proof.transport, 'node_http_unfinished_chunked');
  assert.equal(f.observed.requests, 1); assert.equal(f.observed.bytes, LIMIT + 1);
  assert.equal(f.observed.ended, false); assert.equal(f.observed.complete, false);
  assert.equal(f.observed.headers['content-length'], undefined);
  assert.equal(f.observed.headers['transfer-encoding'], 'chunked'); assert.equal(f.observed.headers.connection, 'keep-alive');
});

test('default limit sends exactly 5 MiB plus one byte and leaves the request unfinished', async t => {
  const limit = 5 * 1024 * 1024;
  const f = await serverFixture(t, (_request, response) => reply(response), limit);
  const proof = await probeEarlyRejection(f.url, headers);
  assert.equal(proof.bytes_sent, limit + 1); assert.equal(f.observed.bytes, limit + 1);
  assert.equal(f.observed.complete, false); assert.equal(f.observed.ended, false);
});

test('one whitespace-formatted field with escaped key and value is accepted without weakening key uniqueness', async t => {
  const bytes = Buffer.from(' \t\r\n{\n "\\u0065rror" : "REQUEST_\\u0054OO_LARGE"\r\n}\t ');
  const f = await serverFixture(t, (_request, response) => reply(response, { bytes }));
  const proof = await probeEarlyRejection(f.url, headers, options);
  assert.deepEqual(proof.json, { error: 'REQUEST_TOO_LARGE' }); assert.equal(proof.response_bytes, bytes.length);
  assert.equal(f.observed.requests, 1); assert.equal(f.observed.ended, false);
});

test('socket reset with no response is a failure and is never retried', async t => {
  const f = await serverFixture(t, request => request.socket.destroy());
  await assert.rejects(probeEarlyRejection(f.url, headers, options), /HTTP_EARLY_REJECTION_FAILED request ECONNRESET/);
  assert.equal(f.observed.requests, 1);
});

test('a partial JSON response followed by reset cannot become a passing 413', async t => {
  const f = await serverFixture(t, (_request, response) => {
    response.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', 'Content-Length': body.length });
    response.write('{"error":', () => response.socket?.destroy());
  });
  await assert.rejects(probeEarlyRejection(f.url, headers, options), /HTTP_EARLY_REJECTION_FAILED (response|request)/);
  assert.equal(f.observed.requests, 1);
});

for (const [name, patch, code] of [
  ['non-413 status', { status: 400 }, 'UNEXPECTED_STATUS'],
  ['wrong JSON error', { bytes: Buffer.from('{"error":"OTHER_ERROR"}') }, 'UNEXPECTED_JSON_RESPONSE'],
  ['additional JSON properties', { bytes: Buffer.from('{"error":"REQUEST_TOO_LARGE","extra":true}') }, 'UNEXPECTED_JSON_RESPONSE'],
  ['duplicate error keys with last value expected', { bytes: Buffer.from('{"error":"OTHER","error":"REQUEST_TOO_LARGE"}') }, 'UNEXPECTED_JSON_RESPONSE'],
  ['duplicate error keys in reverse order', { bytes: Buffer.from('{"error":"REQUEST_TOO_LARGE","error":"OTHER"}') }, 'UNEXPECTED_JSON_RESPONSE'],
  ['duplicate escaped error key', { bytes: Buffer.from('{"error":"OTHER","\\u0065rror":"REQUEST_TOO_LARGE"}') }, 'UNEXPECTED_JSON_RESPONSE'],
  ['duplicate expected values with an escaped first key', { bytes: Buffer.from('{"\\u0065rror":"REQUEST_TOO_LARGE","error":"REQUEST_TOO_LARGE"}') }, 'UNEXPECTED_JSON_RESPONSE'],
  ['malformed private response', { bytes: Buffer.from('SYNTHETIC_PRIVATE_RESPONSE') }, 'INVALID_JSON_RESPONSE'],
  ['invalid UTF-8 response', { bytes: Buffer.from([0xff]) }, 'INVALID_JSON_RESPONSE'],
  ['missing server close policy', { connection: 'keep-alive' }, 'CONNECTION_NOT_CLOSED'],
  ['non-JSON media type', { type: 'text/plain' }, 'JSON_CONTENT_TYPE_REQUIRED'],
]) test(`rejects ${name} without reflecting response contents`, async t => {
  const f = await serverFixture(t, (_request, response) => reply(response, patch));
  await assert.rejects(probeEarlyRejection(f.url, headers, options), error => {
    assert.equal(error.code, code); assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|OTHER_ERROR|extra/); return true;
  });
  assert.equal(f.observed.requests, 1);
});

test('response size has a hard bound independent of request size', async t => {
  const f = await serverFixture(t, (_request, response) => reply(response));
  await assert.rejects(probeEarlyRejection(f.url, headers, { ...options, maxResponseBytes: 8 }), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('absolute deadline rejects a silent server and does not retry', async t => {
  const f = await serverFixture(t, () => {});
  await assert.rejects(probeEarlyRejection(f.url, headers, { ...options, deadlineMs: 150 }), error => error.code === 'DEADLINE_EXCEEDED');
  assert.equal(f.observed.requests, 1);
});

test('incoming activity does not extend the absolute deadline', async t => {
  let interval;
  const f = await serverFixture(t, (_request, response) => {
    response.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
    response.write(' '); interval = setInterval(() => response.write(' '), 15);
  });
  t.after(() => clearInterval(interval));
  await assert.rejects(probeEarlyRejection(f.url, headers, { ...options, deadlineMs: 150 }), error => error.code === 'DEADLINE_EXCEEDED');
  assert.equal(f.observed.requests, 1);
});

test('declared length, expectation and invalid bounds are rejected without issuing a request', async t => {
  const f = await serverFixture(t, (_request, response) => reply(response));
  for (const [inputHeaders, inputOptions] of [[{ ...headers, 'Content-Length': String(LIMIT + 1) }, options],
    [{ ...headers, Expect: '100-continue' }, options], [headers, { ...options, limitBytes: 0 }], [headers, { ...options, chunkBytes: 65537 }]]) {
    await assert.rejects(probeEarlyRejection(f.url, inputHeaders, inputOptions), /HTTP_EARLY_REJECTION_INVALID_OPTIONS/);
  }
  assert.equal(f.observed.requests, 0);
});
