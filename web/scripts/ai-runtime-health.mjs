import { readFileSync } from 'node:fs';

export function checkAiRuntimeHealth(file = '/tmp/etf-ai-runtime-health.json', now = Date.now()) {
  const health = JSON.parse(readFileSync(file, 'utf8'));
  if (health?.status !== 'ready' || typeof health.at !== 'number' || !Number.isFinite(health.at)
    || !Number.isFinite(now) || health.at > now || now - health.at > 120000) throw new Error('AI_RUNTIME_NOT_READY');
}
