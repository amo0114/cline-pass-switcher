// 端到端冒烟测试：真实启动 server.js 子进程 + 本地 mock 上游。
// 覆盖的不是纯函数细节，而是"改坏会出事故"的那几条边界：跨源读取、模型端点、故障转移、流式容错。
//
//   npm test
//
// 需要空闲端口 3211（mock 上游）与 3212（被测服务），可用 SMOKE_UP_PORT / SMOKE_APP_PORT 覆盖。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UP_PORT = Number(process.env.SMOKE_UP_PORT || 3211);
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 3212);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let upstream = null;
let app = null;
let dataDir = '';
let appLog = '';

// mock 上游：按被钉住的上游 slug 决定行为，用来驱动故障转移与流式中断两条分支
function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body); } catch { /* 非 JSON 请求体直接走默认分支 */ }
        const only = j?.provider?.only?.[0] || j?.providerOptions?.gateway?.only?.[0] || '';
        if (only === 'boom') {
          // 声明 SSE 并发出首包，随后粗暴断开——模拟真实网络抖动
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
          setTimeout(() => res.socket.destroy(), 40);
          return;
        }
        if (only === 'fail') {
          res.writeHead(429, JSON_HEADERS);
          res.end(JSON.stringify({ error: { message: 'mock: rate limited' } }));
          return;
        }
        if (j.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
          setTimeout(() => {
            res.write('data: {"provider":"mock-provider","model":"mock/canonical"}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 60);
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'OK' } }],
          provider: 'mock-provider',
          model: 'mock/canonical',
        }));
      });
    });
    upstream.listen(UP_PORT, '127.0.0.1', resolve);
  });
}

function startApp() {
  return new Promise((resolve, reject) => {
    app = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(APP_PORT), BIND_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout.on('data', (d) => { appLog += d; });
    app.stderr.on('data', (d) => { appLog += d; });
    app.on('exit', (code) => reject(new Error(`被测服务提前退出（code=${code}）：\n${appLog}`)));
    setTimeout(resolve, 1500);
  });
}

const chat = (body) => fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-smoke-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: APP_PORT,
    upstreamBase: `http://127.0.0.1:${UP_PORT}/api/v1`,
    accounts: [{ name: 'acct', key: 'sk-mock', enabled: true }],
    accountMode: 'single',
    activeAccount: 0,
    knownModels: ['cline-pass/known', 'cline-pass/boom', 'cline-pass/stream'],
    perModel: {
      'cline-pass/known': { upstreams: ['fail', 'ok'], exclude: [], pinMode: 'strict' },
      'cline-pass/boom': { upstreams: ['boom'], exclude: [], pinMode: 'strict' },
      'cline-pass/stream': { upstreams: [], exclude: [], pinMode: 'strict' },
    },
  }, null, 2));
  await startUpstream();
  await startApp();
});

after(() => {
  try { app?.kill('SIGTERM'); } catch { /* 已退出 */ }
  try { upstream?.close(); } catch { /* 已关闭 */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

test('管理面拒绝跨源请求，且不回 CORS 头', async () => {
  const res = await fetch(`${BASE}/api/accounts?reveal=1`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  // 关键：不能回 Access-Control-Allow-Origin，否则浏览器端仍能读到响应体
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('管理面拒绝 Sec-Fetch-Site: cross-site', async () => {
  const res = await fetch(`${BASE}/api/accounts`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('跨源预检被拒绝，同源请求放行', async () => {
  const pre = await fetch(`${BASE}/api/accounts`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(pre.status, 403);
  const same = await fetch(`${BASE}/api/accounts`, { headers: { Origin: BASE } });
  assert.equal(same.status, 200);
  assert.equal(same.headers.get('access-control-allow-origin'), BASE);
});

test('/healthz 可用且不泄漏敏感信息', async () => {
  const body = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.configured, 'boolean');
});

test('/v1/models/{id} 支持含斜杠的模型 ID', async () => {
  assert.equal((await fetch(`${BASE}/v1/models/cline-pass/known`)).status, 200);
  assert.equal((await fetch(`${BASE}/v1/models/nope`)).status, 404);
});

test('上游失败时按顺序切换到下一个候选', async () => {
  const res = await chat({ model: 'cline-pass/known', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-cline-attempts'), '2');
  assert.equal((await res.json()).provider, 'mock-provider');
});

test('流式响应正常透传', async () => {
  const res = await chat({ model: 'cline-pass/stream', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /data: \[DONE\]/);
});

test('流式上游中途断开：进程存活，且历史里留下中断记录', async () => {
  const res = await chat({ model: 'cline-pass/boom', messages: [{ role: 'user', content: 'hi' }], stream: true });
  await res.text().catch(() => { /* 连接被上游掐断，读取必然失败 */ });
  await new Promise((r) => setTimeout(r, 800));   // 等节流写盘

  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.ok, true, '上游断开不应拖垮服务进程');

  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'metadata.json'), 'utf8'));
  assert.ok(
    meta.history.some((h) => h.error && h.error.includes('中断')),
    '中断的流式请求也应出现在请求历史里',
  );
});

test('config.json 以 0600 原子落盘', async () => {
  await fetch(`${BASE}/api/security`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ publicBaseUrl: 'https://pass.example.com' }),
  });
  const file = path.join(dataDir, 'config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false, '不应留下临时文件');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).publicBaseUrl, 'https://pass.example.com');
});
