import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { observeHttpFixtureServer, runHttpFixture } from '../../web/scripts/http-fixture-process.mjs';

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

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`server cleanup observes an already delivered ${signal} without awaiting a lost exit event`, { timeout: 3000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const stop = observeHttpFixtureServer(child);
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    child.kill(signal); await exited;
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, signal);
    assert.deepEqual(await stop(), { exit_code: null, signal, spawn_error: false, unexpected_exit: true });
  });
}

test('server cleanup drains closed pipes and preserves an unexpected numeric exit', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('complete');process.exitCode=7"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = observeHttpFixtureServer(child), chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume();
  await once(child, 'exit');
  assert.deepEqual(await stop(), { exit_code: 7, signal: null, spawn_error: false, unexpected_exit: true });
  assert.equal(Buffer.concat(chunks).toString(), 'complete');
});

test('server cleanup records normal requested termination and is repeatable', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{process.stdout.write('drained');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = observeHttpFixtureServer(child), chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume();
  await once(child.stdout, 'data');
  const result = await stop();
  assert.deepEqual(result, { exit_code: 0, signal: null, spawn_error: false, unexpected_exit: false });
  assert.deepEqual(await stop(), result); assert.equal(Buffer.concat(chunks).toString(), 'readydrained');
});

test('server cleanup records a spawn failure rather than hanging on an impossible signal', { timeout: 3000 }, async () => {
  const child = spawn('/synthetic-missing-http-fixture-executable', [], { stdio: 'ignore' });
  const stop = observeHttpFixtureServer(child);
  await new Promise(resolve => child.once('close', resolve));
  const result = await stop();
  assert.equal(result.spawn_error, true); assert.equal(result.unexpected_exit, true); assert.equal(result.signal, null);
});
