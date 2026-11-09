import { execFile } from 'node:child_process';

// Register before any requests: a signal exit keeps exitCode null, even after exit.
export function observeHttpFixtureServer(child) {
  let spawnError = false, stopping;
  child.once('error', () => { spawnError = true; });
  const closed = new Promise(resolve => child.once('close', (exit_code, signal) => resolve({ exit_code, signal })));
  return () => stopping ??= (async () => {
    const unexpected_exit = spawnError || child.exitCode !== null || child.signalCode !== null;
    if (!unexpected_exit) child.kill('SIGTERM');
    return { ...await closed, spawn_error: spawnError, unexpected_exit };
  })();
}

// Keep HTTP close events and idle timers running while fixture children execute.
export function runHttpFixture(command, args, options) {
  const { input, ...config } = options;
  const started = performance.now();
  return new Promise(resolve => {
    let inputError;
    const child = execFile(command, args, config, (error, stdout, stderr) => {
      const failure = error ?? inputError;
      resolve({ status: failure ? Number.isInteger(failure.code) ? failure.code : null : 0,
        signal: failure?.signal ?? null, error: failure ?? null, stdout, stderr,
        elapsed_ms: Math.round(performance.now() - started) });
    });
    child.stdin.once('error', error => { inputError = error; });
    child.stdin.end(input);
  });
}
