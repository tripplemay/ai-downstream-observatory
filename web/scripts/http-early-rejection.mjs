import http from 'node:http';

const DEFAULT_LIMIT = 5 * 1024 * 1024;
const transport = 'node_http_unfinished_chunked';
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
// Parse JSON first, then require exactly one string pair so duplicate (including escaped) keys cannot collapse.
const singleStringField = /^[ \t\r\n]*\{[ \t\r\n]*"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"[ \t\r\n]*:[ \t\r\n]*"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"[ \t\r\n]*\}[ \t\r\n]*$/;

export async function probeEarlyRejection(url, headers, options = {}) {
  const { limitBytes = DEFAULT_LIMIT, chunkBytes = 65536, deadlineMs = 15000, maxResponseBytes = 65536 } = options;
  let destination, requestHeaders;
  try { destination = new URL(url); requestHeaders = new Headers(headers); }
  catch { throw new Error('HTTP_EARLY_REJECTION_INVALID_OPTIONS'); }
  if (destination.protocol !== 'http:' || destination.username || destination.password
      || !Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > DEFAULT_LIMIT
      || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 65536
      || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 65536
      || requestHeaders.has('content-length') || requestHeaders.has('expect')) throw new Error('HTTP_EARLY_REJECTION_INVALID_OPTIONS');
  requestHeaders.set('transfer-encoding', 'chunked');
  requestHeaders.set('connection', 'keep-alive');

  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const chunk = Buffer.alloc(chunkBytes, 65), target = limitBytes + 1;
    let request, settled = false, responseStarted = false, responseEnded = false;
    let bytesSent = 0, responseBytes = 0;
    const cleanup = () => { clearTimeout(deadline); request?.destroy(); agent.destroy(); };
    const fail = (phase, code) => {
      if (settled) return;
      settled = true;
      const error = new Error(`HTTP_EARLY_REJECTION_FAILED ${phase} ${code}`);
      error.phase = phase; error.code = code;
      error.evidence = { transport, bytes_sent: bytesSent, request_ended: request?.writableEnded ?? false, response_bytes: responseBytes };
      cleanup(); reject(error);
    };
    const deadline = setTimeout(() => fail('deadline', 'DEADLINE_EXCEEDED'), deadlineMs);
    try {
      request = http.request(destination, { method: 'POST', headers: Object.fromEntries(requestHeaders), agent });
      request.on('error', error => fail('request', safeCode(error)));
      request.on('response', response => {
        responseStarted = true;
        const parts = [];
        response.on('error', error => fail('response', safeCode(error)));
        response.on('aborted', () => fail('response', 'RESPONSE_ABORTED'));
        response.on('close', () => { if (!responseEnded && !settled) fail('response', 'INCOMPLETE_RESPONSE'); });
        response.on('data', part => {
          responseBytes += part.length;
          if (responseBytes > maxResponseBytes) { fail('response', 'RESPONSE_TOO_LARGE'); return; }
          parts.push(part);
        });
        response.on('end', () => {
          responseEnded = true;
          if (settled) return;
          if (!response.complete || response.aborted) { fail('response', 'INCOMPLETE_RESPONSE'); return; }
          if (bytesSent !== target || request.writableEnded) { fail('request', 'UNFINISHED_LIMIT_PROOF_INVALID'); return; }
          if (response.statusCode !== 413) { fail('response', 'UNEXPECTED_STATUS'); return; }
          const responseHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          if (responseHeaders.get('connection')?.trim().toLowerCase() !== 'close') { fail('response', 'CONNECTION_NOT_CLOSED'); return; }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(responseHeaders.get('content-type') ?? '')) { fail('response', 'JSON_CONTENT_TYPE_REQUIRED'); return; }
          let json, text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)); json = JSON.parse(text); }
          catch { fail('response', 'INVALID_JSON_RESPONSE'); return; }
          if (!singleStringField.test(text) || !json || typeof json !== 'object' || Array.isArray(json)
              || Object.keys(json).length !== 1 || json.error !== 'REQUEST_TOO_LARGE') {
            fail('response', 'UNEXPECTED_JSON_RESPONSE'); return;
          }
          settled = true;
          // Only a fully parsed HTTP response authorizes cleanup, never a reset or EOF alone.
          cleanup();
          resolve({ status: 413, json, headers: responseHeaders, transport, bytes_sent: bytesSent,
            request_ended: false, response_complete: true, response_bytes: responseBytes });
        });
      });
      const writeNext = () => {
        if (settled || responseStarted || bytesSent === target) return;
        const count = Math.min(chunk.length, target - bytesSent);
        bytesSent += count;
        // One write at a time bounds pending bytes and respects transport backpressure.
        request.write(chunk.subarray(0, count), error => {
          if (error) fail('request', safeCode(error));
          else writeNext();
        });
      };
      request.flushHeaders();
      writeNext();
      // No end() and no terminating zero chunk: rejection must precede request completion.
    } catch (error) { fail('request', safeCode(error)); }
  });
}
