import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(new URL('../../deploy/nginx/etf.vpanel.cc.conf', import.meta.url), 'utf8');

test('private workbench closes backend sockets without retrying non-idempotent commands or extending deadlines', () => {
  assert.equal((config.match(/proxy_set_header Connection "close";/g) ?? []).length, 1);
  assert.doesNotMatch(config, /proxy_set_header Connection "";/);
  assert.doesNotMatch(config, /proxy_next_upstream|non_idempotent|proxy_read_timeout\s+(?!120s;)/);
  assert.match(config, /proxy_read_timeout 120s;/);
  assert.match(config, /proxy_http_version 1\.1;/);
});

test('upstream transport change preserves loopback routing, TLS and forwarded-origin boundaries', () => {
  assert.match(config, /server 127\.0\.0\.1:5051;/);
  assert.match(config, /proxy_pass http:\/\/observatory_web;/);
  assert.match(config, /listen 443 ssl http2;/);
  assert.match(config, /ssl_certificate\s+\/etc\/letsencrypt\/live\/etf\.vpanel\.cc\/fullchain\.pem;/);
  for (const header of ['Host \\$host', 'X-Real-IP \\$remote_addr', 'X-Forwarded-For \\$proxy_add_x_forwarded_for', 'X-Forwarded-Proto \\$scheme'])
    assert.match(config, new RegExp('proxy_set_header ' + header + ';'));
  assert.doesNotMatch(config, /proxy_ssl_verify off|proxy_cache|Authorization|Cookie/);
});
