import assert from 'node:assert/strict';
import test from 'node:test';
import { runHttpFixture } from '../../web/scripts/http-fixture-process.mjs';

const options = { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 };

test('fixture process captures stdout, stderr and complete stdin without logging input', async () => {
  const result = await runHttpFixture(process.execPath, ['-e', "let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{process.stdout.write(input);process.stderr.write('diagnostic')});"],
    { ...options, input: '{"fictional":true}' });
  assert.equal(result.status, 0); assert.equal(result.error, null); assert.equal(result.signal, null);
  assert.ok(Number.isSafeInteger(result.elapsed_ms) && result.elapsed_ms >= 0);
  assert.equal(result.stdout, '{"fictional":true}'); assert.equal(result.stderr, 'diagnostic');
});

test('fixture process preserves a nonzero exit instead of reporting success', async () => {
  const result = await runHttpFixture(process.execPath, ['-e', "process.stdout.write('bounded');process.exitCode=7;"], options);
  assert.equal(result.status, 7); assert.equal(result.signal, null); assert.ok(result.error);
  assert.equal(result.stdout, 'bounded');
});

test('fixture process retains the existing output bound', async () => {
  const result = await runHttpFixture(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000));"], { ...options, maxBuffer: 32 });
  assert.equal(result.status, null); assert.equal(result.error?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.ok(Buffer.byteLength(result.stdout) <= 32);
});

test('fixture process retains the deadline and fails on termination', async () => {
  const result = await runHttpFixture(process.execPath, ['-e', 'setTimeout(()=>{},5000);'], { ...options, timeout: 100 });
  assert.equal(result.status, null); assert.equal(result.signal, 'SIGTERM'); assert.equal(result.error?.killed, true);
});

test('fixture process does not block HTTP-client event-loop progress', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await runHttpFixture(process.execPath, ['-e', "const until=Date.now()+250;while(Date.now()<until){};process.stdout.write('complete');"], options);
    assert.equal(result.status, 0); assert.equal(result.stdout, 'complete'); assert.ok(ticks > 0);
  } finally { clearInterval(timer); }
});
