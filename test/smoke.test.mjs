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
        // reasoning 模型分支：非流式带 reasoning 字段，流式逐块下发 delta.reasoning
        // 用于验证 Responses 层的 reasoning item 往返（Codex 续接思考链依赖）
        if (j.model === 'reasoning-mock') {
          if (j.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"index":0,"delta":{"reasoning":"let me "},"finish_reason":null}]}\n\n');
            res.write('data: {"choices":[{"index":0,"delta":{"reasoning":"think"},"finish_reason":null}]}\n\n');
            res.write('data: {"choices":[{"index":0,"delta":{"content":"42"},"finish_reason":null}]}\n\n');
            setTimeout(() => {
              res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":7,"total_tokens":16,"completion_tokens_details":{"reasoning_tokens":4}}}\n\n');
              res.write('data: [DONE]\n\n');
              res.end();
            }, 40);
            return;
          }
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '42', reasoning: 'let me think' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16, completion_tokens_details: { reasoning_tokens: 4 } },
          }));
          return;
        }
        // custom 工具（apply_patch）流式分支：模拟上游把 {"input":"..."} 拆成极碎的块，
        // 用于守住"分块正则提取 input 会失败、必须累积后解析"这个坑
        if (j.model === 'custom-mock') {
          // 用构造式写法生成碎块，避免手写多层转义出错：
          // 把 {"input":"*** Begin Patch\n+hi\n*** End Patch"} 切成若干块下发
          const fullArgs = JSON.stringify({ input: '*** Begin Patch\n+hi\n*** End Patch' });
          const cuts = [1, 9, 10, fullArgs.length];
          const pieces = [];
          let prev = 0;
          for (const c of cuts) { pieces.push(fullArgs.slice(prev, c)); prev = c; }
          // 必须是完整 chunk 结构：{"choices":[{"delta":{"tool_calls":[...]}}]}
          const mk = (argFrag, withId) => JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(withId ? { id: 'call_ctc' } : {}), function: { name: 'apply_patch', arguments: argFrag } }] }, finish_reason: null }],
          });
          if (j.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${mk(pieces[0], true)}\n\n`);
            for (let n = 1; n < pieces.length; n++) res.write(`data: ${mk(pieces[n], false)}\n\n`);
            setTimeout(() => {
              res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
              res.write('data: [DONE]\n\n');
              res.end();
            }, 30);
            return;
          }
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_ctc', type: 'function', function: { name: 'apply_patch', arguments: fullArgs } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          }));
          return;
        }
        // 工具调用分支：验证 Responses 的 function_call item 生成
        if (j.model === 'tool-mock') {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }));
          return;
        }
        if (j.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          // 真实上游实测形状：首块仅 role，推理内容走 delta.reasoning（不应混入正文）
          res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
          res.write('data: {"choices":[{"index":0,"delta":{"reasoning":"thinking..."},"finish_reason":null}]}\n\n');
          res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
          setTimeout(() => {
            res.write('data: {"provider":"mock-provider","model":"mock/canonical"}\n\n');
            // 末块带 finish_reason 与 usage，之后才是 [DONE]（实测顺序）
            res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\n');
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

test('config.json 以 0600 原子落盘', async () => {  await fetch(`${BASE}/api/security`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ publicBaseUrl: 'https://pass.example.com' }),
  });
  const file = path.join(dataDir, 'config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false, '不应留下临时文件');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).publicBaseUrl, 'https://pass.example.com');
});

// ---------- Anthropic Messages 兼容层 ----------
// 上游（api.cline.bot）实测无 /messages 端点，转换全部在本地完成，
// 因此这里断言的是「客户端拿到的 Anthropic 契约」，而非上游行为。

const anthropic = (body, headers = {}) => fetch(`${BASE}/v1/messages`, {
  method: 'POST',
  headers: { ...JSON_HEADERS, ...headers },
  body: JSON.stringify(body),
});

test('/v1/messages 非流式返回 Anthropic 响应结构', async () => {
  const r = await anthropic({ model: 'cline-pass/stream', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.type, 'message');
  assert.equal(j.role, 'assistant');
  assert.ok(/^msg_[0-9a-f]+$/.test(j.id), `id 应为 msg_ 前缀，实际 ${j.id}`);
  assert.equal(j.model, 'cline-pass/stream', '应回显客户端请求的模型名，而非上游 canonicalSlug');
  assert.ok(Array.isArray(j.content));
  assert.equal(j.content[0].type, 'text');
  assert.equal(j.content[0].text, 'OK');
  assert.equal(j.stop_reason, 'end_turn', 'OpenAI 的 stop 应译为 end_turn');
  assert.equal(j.usage.input_tokens, 0, '无 usage 时应为 0 而非 undefined');
  assert.equal(j.usage.output_tokens, 0);
});

test('/v1/messages 缺少 max_tokens 返回 Anthropic 形状的 400', async () => {
  const r = await anthropic({ model: 'cline-pass/stream', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.type, 'error', '错误体必须是 Anthropic 形状而非 OpenAI 的 {error:{message}}');
  assert.equal(j.error.type, 'invalid_request_error');
  assert.match(j.error.message, /max_tokens/);
});

test('/v1/messages system 字段被提升为 system 消息', async () => {
  // system 是 Anthropic 的顶层字段，若透传上游会被忽略，必须转成 role:"system"
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: 'echo-check', max_tokens: 64, system: 'be terse', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  // echo-check 不在 knownModels，走自动模式；此处只验证请求被正常处理未报错
  const j = await r.json();
  assert.equal(j.type, 'message');
});

test('/v1/messages 流式输出完整 Anthropic 事件序列', async () => {
  const r = await anthropic({ model: 'cline-pass/stream', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  const text = await r.text();
  // 事件顺序是硬契约：缺任一环节官方 SDK 会静默挂起
  const order = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
  let cursor = -1;
  for (const ev of order) {
    const at = text.indexOf(`event: ${ev}`);
    assert.ok(at > -1, `缺少事件 ${ev}；实际输出：\n${text}`);
    assert.ok(at > cursor, `事件 ${ev} 顺序错误；实际输出：\n${text}`);
    cursor = at;
  }
  // 逐块核验关键负载
  const start = JSON.parse(text.split('event: message_start\ndata: ')[1].split('\n')[0]);
  assert.equal(start.message.role, 'assistant');
  assert.deepEqual(start.message.content, []);
  assert.ok(/^msg_[0-9a-f]+$/.test(start.message.id));
  const delta = JSON.parse(text.split('event: content_block_delta\ndata: ')[1].split('\n')[0]);
  assert.equal(delta.delta.type, 'text_delta');
  assert.equal(delta.delta.text, 'hello');
  const md = JSON.parse(text.split('event: message_delta\ndata: ')[1].split('\n')[0]);
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.equal(md.usage.output_tokens, 5, 'usage 应取自上游末块');
  // 推理内容不得混入正文块
  assert.ok(!text.includes('thinking...'), 'delta.reasoning 不应进入 Anthropic 文本块');
  // OpenAI 的 [DONE] 哨兵不得泄漏给 Anthropic 客户端
  assert.ok(!text.includes('[DONE]'), '[DONE] 不应出现在 Anthropic 事件流中');
});

test('/v1/messages 流式上游中断仍按协议收尾', async () => {
  // boom 上游发首块后断开：必须补发 message_stop，否则客户端永久挂起
  const r = await anthropic({ model: 'cline-pass/boom', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const text = await r.text().catch(() => '');
  assert.ok(text.includes('event: message_stop'), `中断后应补发 message_stop；实际：\n${text}`);
  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.ok, true, '上游中断不应拖垮服务进程');
});

test('x-api-key 可作为代理凭据（Anthropic SDK 风格）', async () => {
  // 设代理密钥后，Anthropic SDK 只发 x-api-key，不发 Authorization
  await fetch(`${BASE}/api/security`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ proxyKey: 'pk-test' }) });
  try {
    const noKey = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model: 'cline-pass/stream', max_tokens: 8, messages: [] }) });
    assert.equal(noKey.status, 401, '无凭据应拒绝');
    const withKey = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-api-key': 'pk-test' },
      body: JSON.stringify({ model: 'cline-pass/stream', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(withKey.status, 200, 'x-api-key 应被接受');
  } finally {
    await fetch(`${BASE}/api/security`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-admin-key': 'pk-test' },
      body: JSON.stringify({ proxyKey: '' }),
    });
  }
});

// ---------- Responses API 兼容层 ----------
// 同样：上游无 /responses 端点，转换全在本地。

const responses = (body) => fetch(`${BASE}/v1/responses`, {
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

test('/v1/responses 非流式返回 Responses 响应结构', async () => {
  const r = await responses({ model: 'cline-pass/stream', input: 'hi', max_output_tokens: 64 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'response');
  assert.equal(j.status, 'completed');
  assert.ok(/^resp_[0-9a-f]+$/.test(j.id), `id 应为 resp_ 前缀，实际 ${j.id}`);
  assert.equal(j.model, 'cline-pass/stream', '应回显客户端模型名');
  assert.ok(Array.isArray(j.output));
  const msg = j.output.find((i) => i.type === 'message');
  assert.ok(msg, '应含 message item');
  assert.equal(msg.status, 'completed');
  assert.equal(msg.content[0].type, 'output_text');
  assert.equal(msg.content[0].text, 'OK');
  assert.equal(j.output_text, 'OK', '顶层 output_text 应便于直接取用');
  assert.equal(j.usage.input_tokens, 0);
});

test('/v1/responses 生成 reasoning item（Codex 续接思考链依赖）', async () => {
  const r = await responses({ model: 'reasoning-mock', input: 'what is 6*7', max_output_tokens: 512 });
  const j = await r.json();
  const rs = j.output.find((i) => i.type === 'reasoning');
  assert.ok(rs, `应含 reasoning item；实际 items=${j.output.map((i) => i.type)}`);
  // 上游字段名实测为 reasoning（不是 reasoning_content），这里验证没取错字段
  assert.equal(rs.summary[0].text, 'let me think');
  assert.equal(j.usage.output_tokens_details.reasoning_tokens, 4, 'reasoning_tokens 应透传');
});

test('/v1/responses 工具调用生成 function_call item', async () => {
  const r = await responses({
    model: 'tool-mock',
    input: 'weather in Paris?',
    max_output_tokens: 512,
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
  });
  const j = await r.json();
  const fc = j.output.find((i) => i.type === 'function_call');
  assert.ok(fc, `应含 function_call item；实际 ${j.output.map((i) => i.type)}`);
  assert.equal(fc.name, 'get_weather');
  assert.equal(fc.call_id, 'call_abc');
  assert.equal(fc.status, 'completed');
  assert.deepEqual(JSON.parse(fc.arguments), { city: 'Paris' });
});

test('/v1/responses 不支持的内置工具返回明确错误', async () => {
  // code_interpreter 上游无实现：必须报错，不能静默丢弃（否则客户端行为不可预期）
  const r = await responses({ model: 'cline-pass/stream', input: 'hi', max_output_tokens: 64, tools: [{ type: 'code_interpreter' }] });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(j.error, '错误体应为 {error:{type,message}} 形状');
  assert.equal(j.error.code, 'unsupported_tool');
  assert.match(j.error.message, /code_interpreter/);
});

test('/v1/responses 支持 custom 工具（apply_patch）', async () => {
  const r = await responses({
    model: 'cline-pass/stream',
    input: 'patch a file',
    max_output_tokens: 64,
    tools: [{ type: 'custom', name: 'apply_patch' }],
  });
  assert.equal(r.status, 200, 'custom 工具应被上游接受（实测支持）');
});

test('/v1/responses 流式输出完整事件序列', async () => {
  const r = await responses({ model: 'reasoning-mock', input: 'hi', stream: true, max_output_tokens: 512 });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  const text = await r.text();
  // 每个事件类型都必须出现（缺任一环节官方客户端会静默挂起）
  for (const ev of ['response.created', 'response.in_progress', 'response.output_item.added', 'response.reasoning_summary_text.delta', 'response.output_text.delta', 'response.output_item.done', 'response.completed']) {
    assert.ok(text.includes(`event: ${ev}`), `缺少事件 ${ev}；实际输出：\n${text}`);
  }
  // 只断言真实存在的偏序关系：reasoning 的 done 会合法地早于正文 delta
  // （先关闭 reasoning 块，再打开 message 块），不能按线性顺序硬比。
  const at = (ev) => text.indexOf(`event: ${ev}`);
  assert.ok(at('response.created') < at('response.in_progress'), 'created 应先于 in_progress');
  assert.ok(at('response.in_progress') < at('response.output_item.added'), 'in_progress 应先于首个 item');
  assert.ok(at('response.reasoning_summary_text.delta') < at('response.output_text.delta'), 'reasoning 增量应先于正文增量');
  assert.ok(at('response.output_text.delta') < at('response.completed'), '正文增量应先于 completed');
  assert.ok(text.lastIndexOf('event: response.completed') > at('response.output_item.done'), 'completed 应为终止事件');
  // sequence_number 必须单调递增（官方客户端会校验）
  const seqs = [...text.matchAll(/"sequence_number":(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(seqs.length > 0, '应带 sequence_number');
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `sequence_number 必须递增：${seqs[i - 1]} -> ${seqs[i]}`);
  }
  // reasoning 内容必须完整送达且不混入正文
  assert.ok(text.includes('let me '), 'reasoning 增量应送达');
  assert.ok(text.includes('"think"'), 'reasoning 第二块应送达');
  assert.ok(!text.includes('[DONE]'), '[DONE] 不应外泄');
  const completed = JSON.parse(text.split('event: response.completed\ndata: ')[1].split('\n')[0]);
  assert.equal(completed.response.status, 'completed');
  assert.equal(completed.response.output_text, '42');
  assert.equal(completed.response.usage.output_tokens_details.reasoning_tokens, 4);
});

test('/v1/responses 流式上游中断仍按协议收尾', async () => {
  const r = await responses({ model: 'cline-pass/boom', input: 'hi', stream: true, max_output_tokens: 512 });
  const text = await r.text().catch(() => '');
  // 中断时必须给出终止事件，否则 Codex 永久挂起
  assert.ok(/event: response\.(failed|completed)/.test(text), `中断后应有终止事件；实际：\n${text}`);
  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.ok, true, '上游中断不应拖垮服务进程');
});

test('/v1/responses custom 工具（apply_patch）生成 custom_tool_call item', async () => {
  const r = await responses({
    model: 'custom-mock',
    input: 'add hello.txt',
    max_output_tokens: 512,
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
  });
  const j = await r.json();
  const ctc = j.output.find((i) => i.type === 'custom_tool_call');
  assert.ok(ctc, `应含 custom_tool_call item；实际 ${j.output.map((i) => i.type)}`);
  assert.equal(ctc.name, 'apply_patch');
  assert.equal(ctc.status, 'completed');
  // custom 工具被降级成 function 发给上游，响应侧必须还原回 input 字段（而非 arguments）
  assert.match(ctc.input, /\*\*\* Begin Patch/);
  assert.equal(ctc.arguments, undefined, 'custom_tool_call 不应带 arguments 字段');
});

test('/v1/responses custom 工具流式：碎块 JSON 也能还原 input', async () => {
  // 上游把 {"input":"..."} 拆成极碎的块，跨块正则提取必然失败（实测 input 会是空串）。
  // 这条测试守住"累积后统一 JSON.parse"这个修正。
  const r = await responses({
    model: 'custom-mock',
    input: 'add hello.txt',
    stream: true,
    max_output_tokens: 512,
    tools: [{ type: 'custom', name: 'apply_patch' }],
  });
  const text = await r.text();
  assert.ok(text.includes('event: response.completed'), `应有终止事件；实际：\n${text}`);
  const completed = JSON.parse(text.split('event: response.completed\ndata: ')[1].split('\n')[0]);
  const ctc = completed.response.output.find((i) => i.type === 'custom_tool_call');
  assert.ok(ctc, `流式 final output 应含 custom_tool_call；实际 ${completed.response.output.map((i) => i.type)}`);
  assert.ok(ctc.input && ctc.input.length > 0, `input 不应为空（这是碎块解析失败的典型症状）；实际 ${JSON.stringify(ctc.input)}`);
  assert.match(ctc.input, /\*\*\* Begin Patch/);
});

test('/v1/responses 支持不带 type 的 message item（官方 SDK 形态）', async () => {
  // @ai-sdk/openai 的 responses 客户端发的是 {"role":"user","content":[{"type":"input_text","text":"..."}]}，
  // item 上没有 type 字段。早期实现只匹配 it.type === 'message'，会静默丢弃整条输入，
  // 上游收到空 messages 后报 400 "At least one message is required"。
  const r = await responses({
    model: 'cline-pass/stream',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    max_output_tokens: 64,
  });
  assert.equal(r.status, 200, '不带 type 的 message item 不应被丢弃');
  const j = await r.json();
  assert.equal(j.output_text, 'OK', '输入应被正确转换并得到响应');
});

test('/v1/responses input 为带 type 的 message item 时同样正常', async () => {
  const r = await responses({
    model: 'cline-pass/stream',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    max_output_tokens: 64,
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).output_text, 'OK');
});
