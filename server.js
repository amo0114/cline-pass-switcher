// Cline Pass 上游观察/切换代理
// 零依赖，Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - 订阅模型（cline-pass/*）与非 free 目录模型：请求体里的 provider.* 会被 Cline 网关丢弃，
//   由其规划器在系统凭证上游中自行挑选，响应元数据可回读实际上游。
// - 目录模型 :free 变体：provider.only 真正透传到 OpenRouter，可精确钉住。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { name, key, enabled } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询
  activeAccount: 0,        // single 模式下使用的账号下标
  knownModels: [
    'cline-pass/glm-5.3-flash',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/deepseek-v4.1-flash',
    'cline-pass/qwen3.8-max',
    'cline-pass/minimax-m3',
    'cline-pass/glm-5.3',
    'cline-pass/glm-5.2',
    'cline-pass/deepseek-v4-pro',
    'cline-pass/mimo-v2.5-pro',
    'cline-pass/mimo-v2.5',
    'cline-pass/kimi-k2.6',
    'cline-pass/qwen3.7-plus',
    'cline-pass/kimi-k2.7-code',
    'cline-pass/qwen3.7-max',
  ],
  // modelId -> { upstreams: string[]（有序优先列表，空=自动）, exclude: string[]（排除列表，优先级高于勾选）,
  //              pinMode: 'strict'|'preferred', sort: 'cost'|'ttft'|'tps'|null }
  // 请求按 upstreams 顺序逐个钉住尝试：第一个异常（非 200 / 网络失败 / 超时）自动顺切下一个，
  // 全部失败才把最后一个错误透传给客户端；exclude 中的上游永不被使用（自动模式下注入排除偏好）。
  // upstream 为旧版单上游兼容镜像（取列表第一个），maxRetries 已退役（旧值仅作回滚兼容保留在文件里）。
  perModel: {},
};

// 原子写：先写临时文件并 fsync，再 rename 覆盖。裸 writeFileSync 被 SIGKILL / 磁盘满打断时会留下
// 截断的半个 JSON，而 loadJson 的 fallback 会让账号池静默消失。mode 0o600：这两个文件含明文
// 上游 API Key，默认 0644 会让同机其他用户可读。
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 文件不存在属正常首次启动；解析失败意味着数据损坏，必须报警并留证据，不能静默吞掉
    if (e.code !== 'ENOENT') {
      const bak = `${file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(file, bak); } catch { /* 备份失败不阻塞启动 */ }
      console.error(`[错误] ${path.basename(file)} 读取/解析失败（${e.message}）；已备份为 ${path.basename(bak)}，本次以默认值启动`);
    }
    return fallback;
  }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null });
function saveConfig() {
  try { writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2)); }
  catch (e) { console.error(`[错误] config.json 写入失败：${e.message}`); }
}
// metadata.json 在每个代理请求结束时都会更新（history / 账号统计），同步全量写盘会阻塞事件循环；
// 改成脏标记 + 500ms 去抖合并写入，退出前由 flushMetaSave 强制落盘。
let metaDirty = false;
let metaTimer = null;
function flushMetaSave() {
  if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
  if (!metaDirty) return;
  metaDirty = false;
  try { writeFileAtomic(META_PATH, JSON.stringify(META, null, 2)); }
  catch (e) { console.error(`[错误] metadata.json 写入失败：${e.message}`); }
}
function saveMeta() {
  metaDirty = true;
  if (metaTimer) return;
  metaTimer = setTimeout(() => { metaTimer = null; flushMetaSave(); }, 500);
  if (metaTimer.unref) metaTimer.unref();
}
// 旧版单 apiKey 迁移为账号池
if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
  config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
  config.accountMode = 'single';
  config.activeAccount = 0;
  saveConfig();
}
config.accountMode = config.accountMode === 'roundrobin' ? 'roundrobin' : 'single';

// perModel 配置升级：旧版单 upstream 迁移为有序多上游列表（upstream 保留为回滚兼容镜像）
(function migratePerModel() {
  let dirty = false;
  for (const c of Object.values(config.perModel || {})) {
    if (!c || typeof c !== 'object') continue;
    if (c.upstreams === undefined) { c.upstreams = c.upstream ? [c.upstream] : []; dirty = true; }
    if (c.exclude === undefined) { c.exclude = []; dirty = true; }
    if (!Array.isArray(c.upstreams)) { c.upstreams = []; dirty = true; }
    if (!Array.isArray(c.exclude)) { c.exclude = []; dirty = true; }
  }
  if (dirty) saveConfig();
})();

// 环境变量覆盖（便于 Docker 部署）。注意：此后若通过控制台保存设置，当前生效值会写回 config.json
if (process.env.CLINE_PASS_KEY) {
  const k = process.env.CLINE_PASS_KEY.trim();
  if (k && !(config.accounts || []).some((a) => a.key === k)) {
    config.accounts = [{ name: 'env-account', key: k, enabled: true }, ...(config.accounts || [])];
  }
}
if (process.env.PROXY_KEY && process.env.PROXY_KEY.trim()) config.proxyKey = process.env.PROXY_KEY.trim();
if (process.env.PUBLIC_BASE_URL) config.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
if (process.env.PORT) config.port = Number(process.env.PORT) || config.port;

function isConfigured() {
  return !!config.apiKey || enabledAccounts().length > 0;
}
if (!isConfigured()) {
  console.warn('[提示] 尚未配置上游 API Key：打开控制台「账号管理」添加账号并保存即可；服务已启动。');
}

// 账号选择：roundrobin 在启用的账号间轮询；single 使用 activeAccount 指定的账号
let RR_COUNTER = 0;
function enabledAccounts() {
  return (config.accounts || []).filter((a) => a && a.key && a.enabled !== false);
}
function pickAccount() {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '' };
  if (config.accountMode === 'roundrobin' && list.length > 1) {
    const a = list[RR_COUNTER % list.length];
    RR_COUNTER = (RR_COUNTER + 1) % 1000000000;
    return a;
  }
  const byIdx = config.accounts[config.activeAccount];
  if (byIdx && byIdx.key && byIdx.enabled !== false) return byIdx;
  return list[0];
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// 代理密钥：非空时，/v1/* 与 /api/* 均需鉴权（Authorization: Bearer <key> 或 X-Admin-Key: <key>）；
// 控制台页面本身保持开放（不含任何敏感数据，数据由带鉴权的 /api/* 提供）。
// 可通过 POST /api/security 在运行期修改（下游密钥 = 客户端访问代理的凭据）。
let PROXY_KEY = config.proxyKey || '';

// 恒定时间比较：先各自 sha256 成定长摘要再比，长度差异与时序均不泄漏密钥信息
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 管理面（/api/*）与代理面（/v1/*）分离：
// - 代理面：PROXY_KEY 为空时放行（本地自用），非空时校验
// - 管理面：涉及账号密钥、代理密钥、配置读写。PROXY_KEY 为空且请求来自非回环地址时一律拒绝，
//   避免「未设密钥 = 任意可读账号池」；本机回环访问保留免密钥便利性。
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return LOOPBACK.has(ip);
}
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = String(req.headers['x-admin-key'] || '').trim();
  // Anthropic SDK 与 Claude Code 用 x-api-key 而非 Authorization，缺这条会导致
  // /v1/messages 在设了 proxyKey 的部署上直接 401。
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  // 各分支都做恒定时间比较，且不短路，避免通过响应时间区分命中方式
  const okBearer = bearer ? safeEqual(bearer, PROXY_KEY) : false;
  const okAdmin = admin ? safeEqual(admin, PROXY_KEY) : false;
  const okApiKey = apiKey ? safeEqual(apiKey, PROXY_KEY) : false;
  return okBearer || okAdmin || okApiKey;
}
function adminOK(req) {
  if (PROXY_KEY) return authOK(req);
  return isLoopback(req);
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized: 代理密钥缺失或错误', type: 'auth_error' } });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------- OpenRouter 目录缓存与 slug 归一化 ----------
async function orModelList() {
  if (META.orModelList && Date.now() - META.orModelsFetchedAt < 6 * 3600e3) return META.orModelList;
  const { json } = await fetchJSON(`${OR_API}/models`).catch(() => ({ json: null }));
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) {
    META.orModelList = ids;
    META.orModelsFetchedAt = Date.now();
    saveMeta();
    return ids;
  }
  // 抓取失败时回落到旧缓存，而不是返回空数组——否则探测结果里的端点明细会凭空消失
  return META.orModelList || [];
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function orEndpoints(slug) {
  // canonicalSlug 与 OpenRouter 目录 id 可能存在连字符差异（zai/... vs z-ai/...），先精确后归一匹配
  const ids = await orModelList();
  let real = ids.find((id) => id === slug) || ids.find((id) => norm(id) === norm(slug));
  if (!real) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`);
  const eps = json?.data?.endpoints || [];
  const detail = {};
  for (const e of eps) {
    const pSlug = String(e.tag || '').split('/')[0] || (e.provider_name || '').toLowerCase().replace(/\s+/g, '-');
    const d = (detail[pSlug] ||= { slug: pSlug, name: e.provider_name, endpoints: 0, context: 0, uptime: 0 });
    d.endpoints++;
    d.context = Math.max(d.context, e.context_length || 0);
    d.uptime = Math.max(d.uptime, Math.round(e.uptime_last_30m || 0));
  }
  return { slug: real, endpoints: Object.values(detail) };
}

// ---------- 探测单个模型 ----------
// 两条管道（实测）：
// - planner：响应带 provider_metadata.gateway.routing（canonicalSlug/finalProvider/fallbacksAvailable），
//   请求体 provider.* 被网关丢弃。
// - direct：响应顶层带 provider（显示名）与 model（真实 OpenRouter ID），provider.only 会透传到
//   OpenRouter，可精确钉住。
function slugify(s) { return String(s).toLowerCase().replace(/\s+/g, '-'); }

function parseRouting(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message;
  const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
  const direct = typeof d?.provider === 'string' ? d.provider : null;
  return {
    content: msg?.content ?? null,
    usage: d?.usage || null,
    pipeline: rt.finalProvider ? 'planner' : direct ? 'direct' : null,
    canonicalSlug: rt.canonicalSlug || (typeof d?.model === 'string' && d.model.includes('/') ? d.model : null),
    finalProvider: rt.finalProvider || (direct ? slugify(direct) : null),
    finalProviderName: rt.finalProvider || direct,
    fallbacks: rt.fallbacksAvailable || [],
    plan: rt.planningReasoning || '',
  };
}

// 故意携带不存在的 only，让网关在路由层报错并列出可用上游（不产生 token 消耗）。
// - 直连管道（OpenRouter）：provider.only → 404 错误 JSON 里的 metadata.available_providers
// - 规划器管道（Vercel AI Gateway）：providerOptions.gateway.only → 400 错误文本里的 "Available providers are: ..."
async function harvestAvailableProviders(modelId, pipeline) {
  const acc = pickAccount();
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000);
  const err = json?.error;
  if (typeof err !== 'string') return null;
  if (pipeline === 'planner') {
    const m = /Available providers are:\s*([^.]+)/.exec(err);
    if (!m) return null;
    // 错误文本里可能混有 JSON 片段（如 ","type":"invalid_request_error"），必须按 slug 格式过滤
    const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
    return toks.length ? toks : null;
  }
  const i = err.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(err.slice(i))?.error?.metadata?.available_providers || null;
  } catch { return null; }
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId) {
  const acc = pickAccount();
  const t0 = Date.now();
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(acc.key),
    body: JSON.stringify(body),
  }, 180000);
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) {
    return { ok: false, error: typeof json.error === 'string' ? json.error : JSON.stringify(json.error) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline);
  let endpoints = [];
  let orSlug = null;
  if (r.pipeline !== 'planner' && r.canonicalSlug) {
    // 规划器管道的钉住发生在 Vercel 侧，OpenRouter 的 endpoint 明细仅对直连管道有参考意义
    try {
      const res = await orEndpoints(r.canonicalSlug);
      endpoints = res.endpoints;
      orSlug = res.slug;
    } catch { /* 公开接口失败不影响探测结果 */ }
  }
  const prev = META.models[modelId] || {};
  const detail = { ...prev.upstreamDetail };
  for (const e of endpoints) detail[e.slug] = e;
  const upstreams = r.pipeline === 'planner'
    ? [...new Set([...(harvest || []), ...r.fallbacks])]
    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];
  const tier0 = [...new Set([...(prev.tier0 || []), ...parseTier0(r.plan)])];
  META.models[modelId] = {
    ...prev,
    ok: true,
    pipeline: r.pipeline,
    pinnable: !!r.pipeline,
    availableProviders: harvest || prev.availableProviders || [],
    canonicalSlug: r.canonicalSlug,
    openrouterSlug: orSlug,
    upstreamDetail: detail,
    upstreams,
    tier0,
    lastProvider: r.finalProvider || prev.lastProvider,
    lastMs: ms,
    probedAt: Date.now(),
  };
  saveMeta();
  return { ok: true, ms, ...META.models[modelId] };
}

// 上游渠道可用性分类：渠道被单独钉住时的真实状态
function classifyUpstreamError(msg) {
  const m = String(msg || '');
  if (/empty response content/i.test(m)) return 'ok';                     // 请求已到达模型（推理耗尽 max_tokens 导致内容为空）
  if (/429|rate-?limited|temporarily rate/i.test(m)) return 'limited';   // 渠道有效，共享池限流中
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m)) return 'bad'; // 不可钉住
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';        // 账号 key 问题，与渠道无关
  return 'unknown';
}
// 钉住请求失败时自动学习该渠道状态（仅确定性失败，瞬时限流标 limited 不拉黑）
function learnUpstreamStatus(modelId, upstream, errMsg) {
  if (!upstream || !errMsg) return;
  const st = classifyUpstreamError(errMsg);
  if (st === 'unknown') return;
  const meta = (META.models[modelId] ||= {});
  meta.upstreamStatus = { ...(meta.upstreamStatus || {}), [upstream]: { status: st, note: String(errMsg).slice(0, 160), checkedAt: Date.now() } };
}

// 自动+排除模式：only 白名单与网关侧渠道清单不一致时，网关报错会附最新清单，合并学习
// （触发场景：探测缓存过期，网关侧新增了渠道而本地 known 列表没有——白名单漏掉新渠道）
function learnAvailableProviders(modelId, errMsg) {
  const m = /Available providers are:\s*([^.]+)/.exec(String(errMsg || ''));
  if (!m) return;
  const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
  if (!toks.length) return;
  const meta = (META.models[modelId] ||= {});
  const before = (meta.upstreams || []).length;
  meta.upstreams = [...new Set([...(meta.upstreams || []), ...toks])];
  if (meta.upstreams.length !== before) saveMeta();
}

// 批量校验：把模型的每个上游渠道用最小请求各钉一次，标记真实可用性
async function validateUpstreams(modelId) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const acc = pickAccount();
  const results = {};
  const batch = 5;
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000).catch(() => ({ json: { error: 'network error' } }));
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = msg.slice(0, 160);
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
      }
      results[slug] = { status, ms: Date.now() - t0, note };
    }));
  }
  META.models[modelId] = { ...meta, upstreamStatus: { ...(meta.upstreamStatus || {}), ...results }, validatedAt: Date.now() };
  saveMeta();
  return results;
}

// 从官方接口、官方文档与社区注册表拉取最新 ClinePass 订阅模型清单（只增不删）
async function fetchOfficialModels() {
  const found = new Set();
  const sources = [];
  const addModel = (value) => {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string') return;
    const normalized = id.trim().toLowerCase();
    if (normalized.startsWith('cline-pass/')) found.add(normalized);
  };
  // 官方推荐模型接口：Cline 自己用来列出订阅模型，权威且更新最快（无需鉴权）
  try {
    const { json } = await fetchJSON('https://api.cline.bot/api/v1/ai/cline/recommended-models', {}, 30000);
    const list = json?.clinePass || json?.data?.clinePass;
    if (Array.isArray(list) && list.length) {
      list.forEach(addModel);
      sources.push('cline.api');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 社区注册表 models.dev：历史响应包在 providers 下，新响应直接以 provider id 为顶层键
  try {
    const { json } = await fetchJSON('https://models.dev/api.json', {}, 30000);
    const cp = json?.providers?.['cline-pass'] || json?.['cline-pass'];
    if (cp?.models) {
      Object.keys(cp.models).forEach((id) => addModel(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`));
      sources.push('models.dev');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 官方文档表格兜底
  try {
    const res = await fetch('https://docs.cline.bot/getting-started/clinepass', { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) || [];
    if (ids.length) { ids.forEach((id) => found.add(id.toLowerCase())); sources.push('docs.cline.bot'); }
  } catch { /* 来源不可用则跳过 */ }
  const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
  const added = valid.filter((id) => !config.knownModels.includes(id));
  if (added.length) {
    config.knownModels.push(...added);
    saveConfig();
  }
  META.officialModelsFetch = { ts: Date.now(), sources, found: valid.length, added, total: config.knownModels.length };
  saveMeta();
  return { sources, found: valid.length, added, knownModels: config.knownModels, ...META.officialModelsFetch };
}

function record(modelId, info) {
  META.models[modelId] = { ...(META.models[modelId] || {}), ...info };
  META.history.unshift({ ts: Date.now(), model: modelId, ...info });
  if (META.history.length > 100) META.history.length = 100;
  if (info.account) {
    META.stats = META.stats || {};
    const st = (META.stats[info.account] ||= { requests: 0, lastUsed: 0, lastError: null });
    st.requests += 1;
    st.lastUsed = Date.now();
    st.lastError = info.error || null;
  }
  saveMeta();
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);

// Anthropic Messages API 入站路径。上游（api.cline.bot）实测只有 OpenAI 兼容的
// /chat/completions：/messages 与 /responses 均返回与任意不存在路径逐字节一致的 404
// （md5 对照 + 带 key 的 OPTIONS 不返回 Allow 头 + 官方文档 Endpoints 章节仅列
// Chat Completions）。因此这里做本地协议转换，让 Anthropic SDK / Claude Code 直接接入。
const ANTHROPIC_PATHS = new Set(['/v1/messages', '/api/v1/messages']);

// OpenAI Responses API 入站路径（给 Codex 等客户端用）。
// 上游同样没有 /responses（与任意不存在路径 404 同形），因此本地做协议转换。
const RESPONSES_PATHS = new Set(['/v1/responses', '/api/v1/responses']);

// Responses 的 input item 类型 → Chat 消息的映射基础。
// 上游工具白名单（实测自 400 discriminator 报错）：function | custom |
// vercel:{browserbase_fetch,browserbase_search,exa_search,parallel_search,perplexity_search,tako_search}。
// 注意：OpenAI 原生的 web_search / file_search / code_interpreter / computer_use_preview
// 全部被上游拒绝；搜索类能力须映射到 vercel: 前缀的工具名。
const RESPONSES_SEARCH_TOOL_MAP = {
  web_search: 'vercel:exa_search',
  web_search_preview: 'vercel:exa_search',
  web_search_preview_2025_03_11: 'vercel:exa_search',
};
// 上游无对应实现的内置工具：明确报错，而不是静默丢弃（静默丢弃会让客户端行为不可预期）
const RESPONSES_UNSUPPORTED_TOOLS = new Set(['file_search', 'code_interpreter', 'computer_use_preview', 'image_generation', 'local_shell', 'mcp']);

// reasoning.effort → 上游 reasoning_effort。上游实测四种写法均被接受，
// 这里统一用 reasoning_effort（最直白的 OpenAI 风格写法）。
const REASONING_EFFORT = new Set(['low', 'medium', 'high']);

// Responses 请求体 → Chat Completions 请求体。
//
// 关键差异：
// - input 可以是字符串，也可以是 item 数组（message / function_call / function_call_output /
//   reasoning 等混合）；
// - instructions 是顶层字段，映射为第一条 system；
// - content part 的 type 叫 input_text / output_text / input_image，且 image 直接给 url 或
//   data URL（不像 Anthropic 要嵌套 source）；
// - tools[].type === "function" 时 parameters 在顶层（不带 function 包装层），而上游要求
//   {"type":"function","function":{...}} 包装层，必须调整；
// - custom 工具（apply_patch）不能透传：上游虽接受该形状，但模型只把调用写成正文 markdown
//   （tool_calls: null），客户端无法解析。此处降级为带 input 参数的 function，
//   实测可稳定得到结构化 tool_calls；响应侧再还原成 custom_tool_call。
function responsesToChat(b, customToolNames = new Set()) {
  const messages = [];
  if (typeof b.instructions === 'string' && b.instructions) {
    messages.push({ role: 'system', content: b.instructions });
  }
  const pushContent = (role, content) => {
    if (typeof content === 'string') {
      messages.push({ role, content });
      return;
    }
    if (!Array.isArray(content)) return;
    const parts = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      switch (c.type) {
        case 'input_text':
        case 'output_text':
        case 'text':
          if (c.text) parts.push({ type: 'text', text: c.text });
          break;
        case 'input_image':
          // Responses 的图片是扁平的 url / image_url 字段，直接转 Chat 的 image_url
          if (c.image_url) parts.push({ type: 'image_url', image_url: { url: c.image_url } });
          else if (c.url) parts.push({ type: 'image_url', image_url: { url: c.url } });
          break;
        case 'refusal':
          if (c.refusal) parts.push({ type: 'text', text: c.refusal });
          break;
        default:
          break;
      }
    }
    if (parts.length) messages.push({ role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  };

  if (typeof b.input === 'string') {
    pushContent('user', b.input);
  } else if (Array.isArray(b.input)) {
    // 历史 items 按序归并：连续的同类 item 合并，function_call/output 独立成消息
    for (const it of b.input) {
      if (!it || typeof it !== 'object') continue;
      // 官方 SDK（@ai-sdk/openai 的 responses）发出的 message item 不带 type 字段，
      // 形如 {"role":"user","content":[{"type":"input_text",...}]}。
      // 只按 it.type === 'message' 分支匹配会静默丢弃这类 item，导致上游收到空 messages
      // 并报 400 "At least one message is required"。因此以 role 存在与否兜底判定。
      const kind = it.type || (it.role ? 'message' : '');
      switch (kind) {
        case 'message':
          pushContent(it.role === 'assistant' ? 'assistant' : it.role === 'system' ? 'system' : 'user', it.content);
          break;
        case 'function_call': {
          // Responses 把每次调用拆成独立 item；Chat 要求聚合进 assistant.tool_calls
          const last = messages[messages.length - 1];
          const call = { id: it.call_id || it.id, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } };
          if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
          else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
          break;
        }
        case 'custom_tool_call': {
          // custom 工具（apply_patch）的调用：上游把它当普通工具调用回传，
          // 这里按同名 function 形式回灌，保证历史可续接
          const last = messages[messages.length - 1];
          const call = { id: it.call_id || it.id, type: 'function', function: { name: it.name, arguments: JSON.stringify({ input: it.input ?? '' }) } };
          if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
          else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const out = typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? '');
          messages.push({ role: 'tool', tool_call_id: it.call_id || it.id, content: out });
          break;
        }
        case 'reasoning': {
          // reasoning item 必须能回传给模型（Codex 靠它续接思考链）。
          // 上游实测：assistant 消息上的 reasoning 字段被接受并影响后续推理。
          const last = messages[messages.length - 1];
          const text = (it.summary || []).map((s) => s?.text || '').join('') || it.content || '';
          if (last && last.role === 'assistant') last.reasoning = text;
          else messages.push({ role: 'assistant', content: '', reasoning: text });
          break;
        }
        default:
          break;
      }
    }
  }

  const out = { model: b.model, messages, stream: !!b.stream };
  if (b.max_output_tokens != null) out.max_tokens = b.max_output_tokens;
  else if (b.max_tokens != null) out.max_tokens = b.max_tokens;
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.top_p != null) out.top_p = b.top_p;
  // reasoning.effort 或顶层 reasoning_effort 都接受
  const effort = b.reasoning?.effort || b.reasoning_effort;
  if (effort && REASONING_EFFORT.has(effort)) out.reasoning_effort = effort;
  if (Array.isArray(b.tools) && b.tools.length) {
    const tools = [];
    for (const t of b.tools) {
      if (!t || typeof t !== 'object') continue;
      const ty = String(t.type || 'function');
      if (ty === 'function') {
        // Responses 的 parameters 在顶层，上游要 function 包装层
        tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || t.input_schema || { type: 'object', properties: {} }, ...(t.strict != null ? { strict: t.strict } : {}) } });
      } else if (ty === 'custom') {
        // custom 工具（apply_patch）不能直接透传上游：
        // 实测 {"type":"custom","name":"apply_patch"} 虽被接受，但模型不会产生结构化调用，
        // 而是把调用写成正文 markdown（tool_calls: null），客户端无法解析。
        // 降级为带 input 参数的 function 后，模型稳定返回结构化 tool_calls，
        // 且参数正是 Codex 的 patch 格式：{"input":"*** Begin Patch\n..."}。
        // 响应侧再由 chatToResponses 还原成 custom_tool_call（见 customToolNames）。
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || `${t.name} (free-form tool; the argument goes into the "input" field)`,
            parameters: { type: 'object', properties: { input: { type: 'string', description: 'Free-form input for this tool.' } }, required: ['input'] },
          },
        });
        customToolNames.add(t.name);
      } else if (RESPONSES_SEARCH_TOOL_MAP[ty]) {
        tools.push({ type: RESPONSES_SEARCH_TOOL_MAP[ty] });
      } else if (RESPONSES_UNSUPPORTED_TOOLS.has(ty)) {
        throw new ResponsesToolError(ty);
      }
    }
    if (tools.length) out.tools = tools;
    if (b.tool_choice) {
      const tc = b.tool_choice;
      if (typeof tc === 'string') out.tool_choice = tc === 'required' ? 'required' : tc;
      else if (tc.type === 'function') out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }
  return out;
}

// 上游无法提供的内置工具：抛出让调用方转成 Responses 形状的错误
class ResponsesToolError extends Error {
  constructor(toolType) {
    super(`unsupported tool type: ${toolType}（上游仅支持 function、custom 与搜索类 vercel:* 工具）`);
    this.toolType = toolType;
  }
}

// Responses 响应 id：resp_ 前缀，与官方一致
function responsesId() {
  return `resp_${crypto.randomBytes(12).toString('hex')}`;
}
function responsesItemId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

// Chat 非流式响应 → Responses 响应体。
// 上游非流式被 {"data":...} 包裹，parseRouting 已解包。
// reasoning → reasoning item（Codex 依赖；上游字段名实测为 reasoning 而非 reasoning_content）；
// tool_calls → function_call item；content → message item（含 output_text）。
function chatToResponses(json, modelId, { previousResponseId = null, customToolNames = new Set() } = {}) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message || {};
  const finish = d?.choices?.[0]?.finish_reason;
  const u = d?.usage || {};
  const out = [];
  const reasoningText = msg.reasoning || '';
  if (reasoningText) {
    out.push({ id: responsesItemId('rs'), type: 'reasoning', summary: [{ type: 'summary_text', text: reasoningText }] });
  }
  const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p?.text || '').join('') : '';
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  // 有工具调用时 content 常为 null，此时不产生空 message item（与官方一致）
  if (content || !toolCalls.length) {
    out.push({
      id: responsesItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: content ? [{ type: 'output_text', text: content, annotations: [] }] : [],
    });
  }
  for (const t of toolCalls) {
    const name = t.function?.name || 'unknown';
    let args = t.function?.arguments || '{}';
    // custom 工具（apply_patch）在请求侧被降级成 function，这里还原成 custom_tool_call：
    // 客户端（Codex）按 custom 工具语义解析，会把 input 当作自由格式文本而非 JSON 参数。
    if (customToolNames.has(name)) {
      let input = '';
      try { input = String(JSON.parse(args)?.input ?? ''); } catch { input = String(args); }
      out.push({
        id: responsesItemId('ctc'),
        type: 'custom_tool_call',
        status: 'completed',
        call_id: t.id || `call_${crypto.randomBytes(8).toString('hex')}`,
        name,
        input,
      });
      continue;
    }
    out.push({
      id: responsesItemId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: t.id || `call_${crypto.randomBytes(8).toString('hex')}`,
      name,
      arguments: args,
    });
  }
  return {
    id: responsesId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: modelId,
    output: out,
    output_text: content,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    previous_response_id: previousResponseId,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: u.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
      total_tokens: u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
    },
    // 非标准但有用：上游实际命中的渠道，便于控制台观测
    metadata: { finish_reason: finish || null, resolved_provider: d?.choices?.[0]?.message?.provider_metadata?.gateway?.routing?.resolvedProvider || null },
  };
}

// Responses 错误体：{"error":{"type","message","code"}}
function sendResponsesError(res, status, type, message, code = null) {
  const cors = corsHeaders(res.req);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(cors || {}) });
  res.end(JSON.stringify({ error: { type, message: String(message ?? ''), ...(code ? { code } : {}) } }));
}

// 把上游 OpenAI SSE 翻译为 Responses API 事件流。
//
// 与 Anthropic 层同样的理由：客户端对事件序列是硬解析的，缺事件会静默挂起。
// 事件顺序（实测自官方 SDK 类型定义，共 63 种事件中取 Codex 依赖的子集）：
//   response.created
//   response.in_progress
//   [response.output_item.added(reasoning) → response.reasoning_summary_text.delta* → done]
//   [response.output_item.added(message)  → response.content_part.added
//      → response.output_text.delta* → response.output_text.done → response.content_part.done]
//   [response.output_item.added(function_call) → response.function_call_arguments.delta*
//      → response.function_call_arguments.done]
//   response.output_item.done（每个 item）
//   response.completed
//
// 关键点：
// - 上游字段名是 delta.reasoning（不是 reasoning_content），reasoning 必须完整送达，
//   Codex 靠它把思考链带回下一轮；
// - sequence_number 必须单调递增，官方客户端会校验；
// - 上游 [DONE] 不外泄；
// - 上游中断时补发 response.completed（或 response.failed），避免客户端挂起。
function pipeResponsesStream(res, up, chain, modelId, targets, customToolNames = new Set()) {
  const acc = chain.acc;
  const respId = responsesId();
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResp = () => ({ id: respId, object: 'response', created_at: createdAt, status: 'in_progress', model: modelId, output: [], output_text: '', parallel_tool_calls: true, tool_choice: 'auto', tools: [], usage: null });
  const head = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto', 'X-Cline-Attempts': String(chain.trace.length), 'X-Cline-Account': headerSafe(acc.name) };
  res.writeHead(200, head);

  let seq = 0;
  const sse = (type, payload) => {
    // 每个事件都带 type 与单调递增的 sequence_number（官方流式契约）
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };

  let closed = false;
  let text = '';
  let reasoning = '';
  let reasoningItemId = null;
  let messageItemId = null;
  let contentPartDone = false;
  let finishReason = null;
  const usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  const toolItems = new Map();   // key → { id, itemId, name, args }
  const toolOrder = [];
  let responseStartSent = false;

  // response.created 必须先于一切内容事件，且只发一次
  const ensureCreated = () => {
    if (responseStartSent) return;
    responseStartSent = true;
    sse('response.created', { response: baseResp() });
    sse('response.in_progress', { response: baseResp() });
  };

  const closeReasoning = () => {
    if (!reasoningItemId) return;
    sse('response.reasoning_summary_text.done', { item_id: reasoningItemId, output_index: 0, summary_index: 0, text: reasoning });
    const item = { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] };
    sse('response.output_item.done', { output_index: 0, item });
    reasoningItemId = null;
  };
  const closeMessage = () => {
    if (!messageItemId) return;
    sse('response.output_text.done', { item_id: messageItemId, output_index: messageOutputIndex, content_index: 0, text });
    if (!contentPartDone) {
      contentPartDone = true;
      sse('response.content_part.done', { item_id: messageItemId, output_index: messageOutputIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    }
    const item = { id: messageItemId, type: 'message', status: 'completed', role: 'assistant', content: text ? [{ type: 'output_text', text, annotations: [] }] : [] };
    sse('response.output_item.done', { output_index: messageOutputIndex, item });
    messageItemId = null;
  };
  const closeTools = () => {
    for (const key of toolOrder) {
      const t = toolItems.get(key);
      if (!t || t.done) continue;
      t.done = true;
      if (t.isCustom) {
        // 累积完毕后再解析：分块正则不可靠（见 handleChunk 注释）
        try { t.input = String(JSON.parse(t.args)?.input ?? ''); } catch { t.input = String(t.args || ''); }
      }
      sse('response.function_call_arguments.done', { item_id: t.itemId, output_index: t.outputIndex, arguments: t.args });
      sse('response.output_item.done', { output_index: t.outputIndex, item: t.isCustom
        ? { id: t.itemId, type: 'custom_tool_call', status: 'completed', call_id: t.callId, name: t.name, input: t.input }
        : { id: t.itemId, type: 'function_call', status: 'completed', call_id: t.callId, name: t.name, arguments: t.args } });
    }
  };

  // 输出 index 分配：reasoning 占 0（若有），随后是 message / function_call
  let nextOutputIndex = 0;
  let reasoningOutputIndex = 0;
  let messageOutputIndex = 0;

  const finish = (failed = false) => {
    if (closed) return;
    closed = true;
    ensureCreated();
    closeReasoning();
    closeMessage();
    closeTools();
    const finalOut = [];
    for (const key of toolOrder) {
      const t = toolItems.get(key);
      if (t) finalOut.push(t.isCustom
        ? { id: t.itemId, type: 'custom_tool_call', status: 'completed', call_id: t.callId, name: t.name, input: t.input }
        : { id: t.itemId, type: 'function_call', status: 'completed', call_id: t.callId, name: t.name, arguments: t.args });
    }
    if (text) finalOut.unshift({ id: responsesItemId('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
    const resp = {
      ...baseResp(),
      status: failed ? 'failed' : 'completed',
      output: finalOut,
      output_text: text,
      usage: { input_tokens: usage.input_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: usage.output_tokens, output_tokens_details: { reasoning_tokens: usage.reasoning_tokens }, total_tokens: usage.input_tokens + usage.output_tokens },
    };
    if (failed) sse('response.failed', { response: resp });
    else sse('response.completed', { response: resp });
    res.end();
  };

  const handleChunk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.usage && typeof obj.usage === 'object') {
      if (obj.usage.prompt_tokens != null) usage.input_tokens = obj.usage.prompt_tokens;
      if (obj.usage.completion_tokens != null) usage.output_tokens = obj.usage.completion_tokens;
      const rt = obj.usage.completion_tokens_details?.reasoning_tokens;
      if (rt != null) usage.reasoning_tokens = rt;
    }
    const ch = obj.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (ch.finish_reason) finishReason = ch.finish_reason;

    // 推理增量 → reasoning item（Codex 续接思考链依赖）
    if (typeof d.reasoning === 'string' && d.reasoning.length) {
      ensureCreated();
      if (!reasoningItemId) {
        reasoningItemId = responsesItemId('rs');
        reasoningOutputIndex = nextOutputIndex++;
        sse('response.output_item.added', { output_index: reasoningOutputIndex, item: { id: reasoningItemId, type: 'reasoning', summary: [] } });
        contentPartDone = false;
      }
      reasoning += d.reasoning;
      sse('response.reasoning_summary_text.delta', { item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: 0, delta: d.reasoning });
    }
    // 正文增量 → message item
    if (typeof d.content === 'string' && d.content.length) {
      ensureCreated();
      if (reasoningItemId) closeReasoning();
      if (!messageItemId) {
        messageItemId = responsesItemId('msg');
        messageOutputIndex = nextOutputIndex++;
        sse('response.output_item.added', { output_index: messageOutputIndex, item: { id: messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        sse('response.content_part.added', { item_id: messageItemId, output_index: messageOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        contentPartDone = false;
      }
      text += d.content;
      sse('response.output_text.delta', { item_id: messageItemId, output_index: messageOutputIndex, content_index: 0, delta: d.content });
    }
    // 工具调用增量 → function_call item
    for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      ensureCreated();
      if (reasoningItemId) closeReasoning();
      if (messageItemId) closeMessage();
      const key = t.index != null ? `idx:${t.index}` : t.id || '';
      let rec = toolItems.get(key);
      if (!rec) {
        const nm = t.function?.name || 'unknown';
        const isCustom = customToolNames.has(nm);
        rec = { itemId: responsesItemId(isCustom ? 'ctc' : 'fc'), callId: t.id || `call_${crypto.randomBytes(8).toString('hex')}`, name: nm, args: '', input: '', isCustom, outputIndex: nextOutputIndex++, done: false };
        toolItems.set(key, rec);
        toolOrder.push(key);
        // custom 工具的 item 类型是 custom_tool_call，事件名与 function_call 不同
        sse('response.output_item.added', rec.isCustom
          ? { output_index: rec.outputIndex, item: { id: rec.itemId, type: 'custom_tool_call', status: 'in_progress', call_id: rec.callId, name: rec.name, input: '' } }
          : { output_index: rec.outputIndex, item: { id: rec.itemId, type: 'function_call', status: 'in_progress', call_id: rec.callId, name: rec.name, arguments: '' } });
      }
      if (t.function?.name) rec.name = t.function.name;
      if (typeof t.function?.arguments === 'string' && t.function.arguments) {
        rec.args += t.function.arguments;
        // custom 工具的 input 不能在此逐块正则提取：上游把 JSON 拆成极碎的块
        // （"{", "\"input\"", ": " 等），跨块匹配必然失败（实测 input 会是空字符串）。
        // 统一在 closeTools() 里对累积完整的 args 做一次 JSON.parse。
        sse('response.function_call_arguments.delta', { item_id: rec.itemId, output_index: rec.outputIndex, delta: t.function.arguments });
      }
    }
    if (ch.finish_reason) finish();
  };

  let pending = '';
  const tap = new Transform({
    transform(c, enc, cb) {
      pending += c.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const l = line.replace(/\r$/, '');
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { handleChunk(JSON.parse(payload)); } catch { /* 非 JSON 行跳过 */ }
      }
      cb();
    },
    flush(cb) { finish(finishReason === null); cb(); },
  });

  const src = Readable.fromWeb(up.body);
  const onErr = (e) => {
    console.error(`[responses流式] 传输中断：${e?.message || e}`);
    try { src.destroy(); } catch { /* 已销毁 */ }
    try { tap.destroy(); } catch { /* 已销毁 */ }
    finish(true);
  };
  src.on('error', onErr);
  tap.on('error', onErr);
  res.on('error', onErr);
  res.on('close', () => { if (!closed) { try { src.destroy(); } catch { /* 已销毁 */ } } });

  if (chain.streamHead) tap.write(chain.streamHead);
  src.pipe(tap);
}

// 上游 OpenAI 的 finish_reason → Anthropic 的 stop_reason。
// end_turn 是 Anthropic 的默认终止值，未知原因统一落到它，避免客户端拿到 null。
const STOP_REASON_FROM_OPENAI = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

// 把 Anthropic 请求体转换为 OpenAI Chat Completions 请求体。
// 关键差异：system 是顶层字段而非消息；content 可以是字符串或 block 数组；
// 工具 schema 字段叫 input_schema 而非 parameters；stop_sequences 对应 stop。
function anthropicToOpenAI(b) {
  const messages = [];
  const sys = b.system;
  if (typeof sys === 'string' && sys) messages.push({ role: 'system', content: sys });
  else if (Array.isArray(sys)) {
    // system 也可为 text block 数组（支持 cache_control），拼接为纯文本
    const t = sys.map((x) => (typeof x === 'string' ? x : x?.text || '')).filter(Boolean).join('\n');
    if (t) messages.push({ role: 'system', content: t });
  }
  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const c of m.content) {
      if (!c || typeof c !== 'object') continue;
      switch (c.type) {
        case 'text':
          if (c.text) parts.push({ type: 'text', text: c.text });
          break;
        case 'image':
          // Anthropic 用 base64 source；OpenAI 用 data URL。url 类型 source 直接透传。
          if (c.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${c.source.media_type || 'image/png'};base64,${c.source.data}` } });
          else if (c.source?.type === 'url') parts.push({ type: 'image_url', image_url: { url: c.source.url } });
          break;
        case 'tool_use':
          // Anthropic 的工具调用在 assistant 消息内；OpenAI 放在 message.tool_calls
          toolCalls.push({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } });
          break;
        case 'tool_result':
          // Anthropic 把工具结果作为 user 消息内的 block；OpenAI 要求独立的 role:"tool" 消息
          toolResults.push({ role: 'tool', tool_call_id: c.tool_use_id, content: toolResultText(c.content) });
          break;
        default:
          break;
      }
    }
    // 工具结果必须先于同消息的文本下发（OpenAI 要求 tool 消息紧跟对应的 assistant 工具调用）
    messages.push(...toolResults);
    if (toolCalls.length) {
      const m2 = { role: 'assistant', tool_calls: toolCalls };
      if (parts.length) m2.content = parts;
      messages.push(m2);
    } else if (parts.length) {
      // 单文本块降级为字符串，兼容不支持多模态数组的上游实现
      messages.push({ role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    } else if (!toolResults.length) {
      messages.push({ role, content: '' });
    }
  }
  const out = { model: b.model, messages, stream: !!b.stream };
  // max_tokens 是 Anthropic 必填项，直接对应；上限保护交由上游处理
  if (b.max_tokens != null) out.max_tokens = b.max_tokens;
  for (const [from, to] of [['temperature', 'temperature'], ['top_p', 'top_p'], ['top_k', 'top_k']]) {
    if (b[from] != null) out[to] = b[from];
  }
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length) out.stop = b.stop_sequences;
  if (b.metadata?.user_id) out.user = b.metadata.user_id;
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } } }));
    if (b.tool_choice) {
      const tc = b.tool_choice;
      out.tool_choice = tc.type === 'auto' ? 'auto' : tc.type === 'any' ? 'required' : tc.type === 'none' ? 'none' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : 'auto';
    }
  }
  return out;
}

// tool_result 的 content 可以是字符串或 block 数组，统一压成 OpenAI 能吃的文本
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : JSON.stringify(c))).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// 生成 Anthropic message id：格式与官方一致（msg_ + 长随机串），便于客户端正则匹配
function anthropicMessageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

// 把上游 OpenAI 非流式响应转换为 Anthropic Messages 响应体。
// 注意：上游非流式响应外层包了一层 {"data":...}，parseRouting 已做解包并给出 content/usage。
function openAIToAnthropic(json, modelId) {
  const r = parseRouting(json);
  const content = [];
  const raw = r.content;
  if (typeof raw === 'string' && raw) content.push({ type: 'text', text: raw });
  else if (Array.isArray(raw)) {
    for (const p of raw) if (p?.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
  }
  // 工具调用 → Anthropic tool_use block
  const tc = json?.data && json.data.choices ? json.data.choices[0]?.message?.tool_calls : json?.choices?.[0]?.message?.tool_calls;
  for (const t of Array.isArray(tc) ? tc : []) {
    let input = {};
    try { input = JSON.parse(t.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: t.id || `toolu_${crypto.randomBytes(8).toString('hex')}`, name: t.function?.name || 'unknown', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const finish = json?.data && json.data.choices ? json.data.choices[0]?.finish_reason : json?.choices?.[0]?.finish_reason;
  const u = r.usage || {};
  return {
    id: anthropicMessageId(),
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: STOP_REASON_FROM_OPENAI[finish] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
    },
  };
}

// Anthropic 错误体形状与 OpenAI 不同：{"type":"error","error":{"type":...,"message":...}}
function sendAnthropicError(res, status, type, message) {
  const cors = corsHeaders(res.req);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(cors || {}) });
  res.end(JSON.stringify({ type: 'error', error: { type, message: String(message ?? '') } }));
}

// 把上游 OpenAI SSE 翻译为 Anthropic Messages SSE 事件流。
//
// Anthropic 客户端对事件序列是严格解析的：缺失 message_start / content_block_stop /
// message_delta / message_stop 中的任意一个，官方 SDK 会静默挂起而不报错。因此这里维护
// 完整的块生命周期状态机，而不是简单地把 OpenAI 的 delta 改名。
//
// 两个上游细节（已实测）：
// - 上游流式是标准 OpenAI chunk，不带非流式那层 {"data":...} 包裹；
// - 首个 delta 只含 role，且 reasoning 内容通过 delta.reasoning 下发，不属 Anthropic
//   text block，按需丢弃或作为 thinking 处理（此处丢弃，避免污染正文）。
//
// streamHead 已被 runChatChain 预读用于探测「200 + event-stream 实为错误体」，必须先行回灌，
// 否则首块（含 role delta）会丢失。
function pipeAnthropicStream(res, up, chain, modelId, targets) {
  const acc = chain.acc;
  const msgId = anthropicMessageId();
  const head = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto', 'X-Cline-Attempts': String(chain.trace.length), 'X-Cline-Account': headerSafe(acc.name) };
  res.writeHead(200, head);

  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let textBlockOpen = false;      // 文本块是否已 content_block_start
  let textIndex = 0;
  let nextIndex = 0;              // 下一个可用块下标（tool_use 会占用后续 index）
  const toolIndexByCallId = new Map();
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let started = false;
  let closed = false;             // 防止 error / end 双路径重复收尾
  let sawDone = false;

  const ensureStart = () => {
    if (started) return;
    started = true;
    sse('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const closeTextBlock = () => {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    sse('content_block_stop', { type: 'content_block_stop', index: textIndex });
  };
  // 收尾：补齐未关闭的块，再发 message_delta + message_stop
  const finish = () => {
    if (closed) return;
    closed = true;
    ensureStart();
    closeTextBlock();
    for (const [callId, idx] of toolIndexByCallId) {
      if (idx != null && !idx.closed) {
        idx.closed = true;
        sse('content_block_stop', { type: 'content_block_stop', index: idx.index });
      }
    }
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: STOP_REASON_FROM_OPENAI[finishReason] || 'end_turn', stop_sequence: null }, usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 } });
    sse('message_stop', { type: 'message_stop' });
    res.end();
  };
  // 上游中途断开且未收到 [DONE]：仍按协议收尾，让客户端正常结束而非挂起
  const abort = (why) => {
    if (closed) return;
    console.error(`[anthropic流式] 上游异常：${why}`);
    finish();
  };

  const handleChunk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    // 上游可能在任意块的 provider_metadata 里带 usage（末块常见）
    if (obj.usage && typeof obj.usage === 'object') {
      if (obj.usage.prompt_tokens != null) usage.input_tokens = obj.usage.prompt_tokens;
      if (obj.usage.completion_tokens != null) usage.output_tokens = obj.usage.completion_tokens;
    }
    const ch = obj.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (ch.finish_reason) finishReason = ch.finish_reason;
    // 正文文本 → 文本块
    if (typeof d.content === 'string' && d.content.length) {
      ensureStart();
      if (!textBlockOpen) {
        textBlockOpen = true;
        textIndex = nextIndex++;
        sse('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
      }
      sse('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: d.content } });
    }
    // 工具调用增量 → tool_use 块
    for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const key = t.index != null ? `idx:${t.index}` : t.id || '';
      let rec = toolIndexByCallId.get(key);
      if (!rec) {
        ensureStart();
        closeTextBlock();
        rec = { index: nextIndex++, id: t.id || `toolu_${crypto.randomBytes(8).toString('hex')}`, name: t.function?.name || 'unknown', closed: false };
        toolIndexByCallId.set(key, rec);
        sse('content_block_start', { type: 'content_block_start', index: rec.index, content_block: { type: 'tool_use', id: rec.id, name: rec.name, input: {} } });
      }
      if (t.function?.name) rec.name = t.function.name;
      if (typeof t.function?.arguments === 'string' && t.function.arguments) {
        sse('content_block_delta', { type: 'content_block_delta', index: rec.index, delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
      }
    }
    // 上游给出 finish 且本块无更多增量时即可收尾
    if (ch.finish_reason) finish();
  };

  // SSE 解析：按行累积，只处理 "data:" 行；[DONE] 标记流结束
  let pending = '';
  const tap = new Transform({
    transform(c, enc, cb) {
      pending += c.toString('utf8');
      // 事件以空行分隔，但逐行解析足以处理 data: 负载
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const l = line.replace(/\r$/, '');
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { sawDone = true; continue; }
        try { handleChunk(JSON.parse(payload)); } catch { /* 不完整或非 JSON 行，跳过 */ }
      }
      cb();
    },
    flush(cb) { finish(); cb(); },
  });

  const src = Readable.fromWeb(up.body);
  const onErr = (e) => {
    console.error(`[anthropic流式] 传输中断：${e?.message || e}`);
    try { src.destroy(); } catch { /* 已销毁 */ }
    try { tap.destroy(); } catch { /* 已销毁 */ }
    abort(e?.message || 'stream error');
  };
  src.on('error', onErr);
  tap.on('error', onErr);
  res.on('error', onErr);
  res.on('close', () => { if (!closed) { try { src.destroy(); } catch { /* 已销毁 */ } } });

  // 回灌预读块，否则首块丢失
  if (chain.streamHead) tap.write(chain.streamHead);
  src.pipe(tap);
  void sawDone;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unwrap(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return { status, body: { error: { message: msg, type: 'upstream_error' } }, routing: {} };
  }
  const r = parseRouting(d);
  return { status: 200, body: d, routing: r };
}

// 按管道注入上游偏好（实测结论）：
// - 规划器管道（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
//   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
// - 直连管道（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
// - 管道未知时两种形式同时注入，各自取用、互不干扰。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };

// upstream: 本次尝试钉住的上游（null=自动）；orderRest: preferred 模式下排在当前上游之后的回退序列；
// excludeList: 排除列表。网关不支持 exclude/ignore 字段（实测被静默忽略），因此排除统一换算成 only 白名单：
// 自动模式 only=已知上游-排除；preferred 钉住模式 order=[当前,...] 且 only=已知上游-排除（防止网关回退到被排除渠道）；
// 严格钉住模式 only=[当前上游]，天然排除其他一切渠道。
function injectPrefs(body, modelId, { upstream, orderRest = [], excludeList = [], strict = true, sort = null }) {
  // 顶层浅拷贝即可：下面只替换 provider / providerOptions 两个键，不会改动 body 的嵌套对象。
  // 原来的 JSON 深拷贝会按尝试次数重复复制整份 messages（带图请求时开销明显）。
  const b = { ...body };
  const exclude = (excludeList || []).filter((u) => u !== upstream);
  const meta = META.models[modelId] || {};
  const known = meta.upstreams || [];
  const allowList = exclude.length ? known.filter((u) => !exclude.includes(u)) : null;
  if (!upstream && !sort && !(allowList && allowList.length)) return b;
  const pipeline = meta.pipeline || null;
  const useVercel = pipeline === 'planner' || pipeline === null;
  const useOpenRouter = pipeline === 'direct' || pipeline === null;
  if (useVercel) {
    const gw = {};
    if (upstream) {
      if (strict) gw.only = [upstream];
      else {
        gw.order = [upstream, ...orderRest];
        if (allowList && allowList.length) gw.only = allowList;
      }
    } else if (allowList && allowList.length) {
      gw.only = allowList;
    }
    if (sort) gw.sort = sort;
    b.providerOptions = { ...(b.providerOptions || {}), gateway: { ...(b.providerOptions?.gateway || {}), ...gw } };
  }
  if (useOpenRouter) {
    const p = { ...(b.provider || {}) };
    if (upstream) {
      if (strict) p.only = [upstream];
      else {
        p.order = [upstream, ...orderRest];
        if (allowList && allowList.length) p.only = allowList;
      }
    } else if (allowList && allowList.length) {
      p.only = allowList;
    }
    if (sort) p.sort = OR_SORT[sort] || sort;
    b.provider = p;
  }
  return b;
}

// 由 perModel 配置展开出故障转移候选序列：[{ upstream, orderRest, excludeList, strict, sort }, ...]
// - 勾选了上游（排除后非空）：逐个尝试，排除的永不在候选中
// - 未勾选：单候选自动模式，排除换算成 only 白名单注入（见 injectPrefs）
function buildAttempts(modelId, cfg) {
  const listed = (cfg?.upstreams || []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude || []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const strict = (cfg?.pinMode || 'strict') === 'strict';
  const sort = cfg?.sort || null;
  const base = { strict, sort, excludeList: exclude };
  if (wanted.length) {
    // preferred 模式：当前上游排在 order 首位，其余勾选项作为网关侧回退序列；排除列表随行（限制网关回退范围）
    return wanted.map((u, i) => ({ ...base, upstream: u, orderRest: strict ? [] : wanted.filter((_, j) => j !== i) }));
  }
  return [{ ...base, upstream: null, orderRest: [], excludeList: exclude }];
}

// 把上游错误信息归一成短字符串（用于学习与尝试日志）
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

// 单次向上游网关发起非流式请求；返回 { status, out, routing, netError, acc }
// 异常（网络错误/非 JSON/非 200）不抛出，由调用方决定切换。
// acc 由调用方传入：同一次客户端请求的整条故障转移链共用同一账号。
async function attemptOnce(modelId, body, attempt, signal, acc) {
  const send = injectPrefs(body, modelId, attempt);
  try {
    const res = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal,
    });
    const json = await res.json().catch(() => null);
    if (!json) return { status: 502, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, netError: 'non-JSON response', acc };
    const { status, body: out, routing } = unwrap(json);
    return { status, out, routing, netError: null, acc };
  } catch (e) {
    return { status: 502, out: { error: { message: `upstream fetch failed: ${e.message}`, type: 'upstream_error' } }, routing: {}, netError: e.message, acc };
  }
}

// 顺序故障转移：依次执行候选，非 200 / 网络失败 / 超时即切换下一个；全部失败返回最后一次结果。
// 流式：首包前（网关以 JSON 而非 SSE 应答错误）仍可切换；SSE 一旦开始即透传，无法重试。
// 每次尝试有独立的超时中止（attemptTimeoutMs）；客户端断开会中止当前尝试。
// 返回 { status, out, routing, acc, trace, streamUp? } —— trace 为逐次尝试 [{ upstream, status, ms, note }]
async function runChatChain(req, body, modelId, cfg, { stream = false, attemptTimeoutMs = 120000, account = null } = {}) {
  const attempts = buildAttempts(modelId, cfg);
  // 账号在整条故障转移链上固定：轮询模式按「每个客户端请求」轮换，而不是按每次重试轮换，
  // 否则一次请求内的重试会落到不同账号，计费/限流语义会变得不可预期。
  const acc = account || pickAccount();
  const trace = [];
  const t0 = Date.now();
  let last = null;
  let activeCtrl = null;            // 当前尝试的 AbortController；流式成功后保持指向该次 fetch，用于断连时中止上游 body
  let keepCloseHook = false;        // 流式 SSE 建立后，close 钩子要保留到流结束
  const onClientClose = () => { if (activeCtrl) activeCtrl.abort(); };
  req.on('close', onClientClose);
  try {
    for (const attempt of attempts) {
      const t1 = Date.now();
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt);
          let up = null;
          let netError = null;
          try {
            up = await fetch(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal: ctrl.signal });
          } catch (e) { netError = e.message; }
          const ctype = up?.headers?.get('content-type') || '';
          let isSSE = !!up && up.status === 200 && ctype.includes('event-stream');
          // 网关对流式错误可能返回 200 + text/event-stream，body 却是 {"error":...}：
          // 读首个数据块探测，真正的 SSE 第一行是 "data: {...}" 且非纯错误对象
          let firstChunk = null;
          if (isSSE) {
            let reader = null;
            try {
              reader = up.body.getReader();
              const { value, done } = await reader.read();
              if (done) {
                isSSE = false;
                netError = 'empty stream';
              } else {
                firstChunk = Buffer.from(value);
                const head = firstChunk.toString('utf8').trimStart().slice(0, 200);
                if (head.startsWith('data:')) {
                  const payload = head.replace(/^data:\s*/, '').slice(0, 160);
                  if (payload.startsWith('{"error"')) { isSSE = false; netError = `stream error: ${payload.slice(0, 120)}`; }
                } else {
                  isSSE = false;
                  netError = `unexpected stream head: ${head.slice(0, 60)}`;
                }
              }
            } catch (e) {
              isSSE = false;
              netError = e.message;
            } finally {
              try { reader?.releaseLock(); } catch {}
            }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            let text = '';
            let json = null;
            if (firstChunk) {
              // 已消费的块 + 剩余 body 拼回完整错误文本
              const rest = await up.text().catch(() => '');
              text = firstChunk.toString('utf8') + rest;
            } else {
              text = await up.text();
            }
            try { json = JSON.parse(text); } catch {}
            const msg = errText(json?.error) || text.slice(0, 160) || netError;
            trace.push({ upstream: attempt.upstream, status: up.status, ms, note: msg.slice(0, 160) });
            if (attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, msg);
            if (!attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, msg);
            last = { status: json?.error ? 502 : up.status, out: json || { error: { message: text.slice(0, 400) || netError, type: 'upstream_error' } }, routing: parseRouting(json || {}), acc, netError: null };
            continue; // 错误：还未向客户端写任何字节，可切换下一候选
          }
          if (!up) {
            trace.push({ upstream: attempt.upstream, status: 502, ms, note: netError || 'no response' });
            last = { status: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, acc, netError: netError || 'no response' };
            continue;
          }
          // 真 SSE：firstChunk 与剩余 body 串联透传（SSE 开始后无法重试）；close 钩子保留用于客户端断开时中止上游
          keepCloseHook = true;
          trace.push({ upstream: attempt.upstream, status: 200, ms, note: 'stream' });
          return { status: 200, streamUp: up, streamHead: firstChunk, acc, trace, t0 };
        }
        // 非流式
        const r = await attemptOnce(modelId, body, attempt, ctrl.signal, acc);
        const ms = Date.now() - t1;
        const note = r.netError || (r.status !== 200 ? errText(r.out?.error?.message).slice(0, 160) : 'ok');
        trace.push({ upstream: attempt.upstream, status: r.status, ms, note });
        if (r.status !== 200 && attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, errText(r.out?.error?.message));
        if (r.status !== 200 && !attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, r.netError || note);
        last = r;
        if (r.status === 200) break;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!keepCloseHook) req.off('close', onClientClose);
  }
  return { ...last, status: last?.status ?? 502, trace, t0, netError: last?.netError || null };
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  const pathname = new URL(req.url, 'http://x').pathname;
  const isAnthropic = ANTHROPIC_PATHS.has(pathname);
  const isResponses = RESPONSES_PATHS.has(pathname);
  // 请求侧把哪些 custom 工具降级成了 function：响应侧要据此还原成 custom_tool_call
  const customToolNames = new Set();
  // 各协议的模型字段名与请求体校验差异：
  // - Responses 用 model（同 Chat），但校验和错误体形状不同
  const errBad = (status, type, message) => (isAnthropic
    ? sendAnthropicError(res, status, type, message)
    : isResponses
      ? sendResponsesError(res, status, type, message)
      : sendJSON(res, status, { error: { message, type } }));
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch {
    return errBad(400, 'invalid_request_error', 'invalid JSON body');
  }
  const modelId = body.model;
  if (!modelId) return errBad(400, 'invalid_request_error', 'model: field required');
  if (isAnthropic && body.max_tokens == null) {
    return sendAnthropicError(res, 400, 'invalid_request_error', 'max_tokens: field required');
  }
  // Responses 请求转换可能因不支持的内置工具而抛错，需转成该协议的错误体
  let upstreamBody;
  try {
    upstreamBody = isAnthropic ? anthropicToOpenAI(body) : isResponses ? responsesToChat(body, customToolNames) : body;
  } catch (e) {
    if (e instanceof ResponsesToolError) {
      return sendResponsesError(res, 400, 'invalid_request_error', e.message, 'unsupported_tool');
    }
    return errBad(400, 'invalid_request_error', e.message);
  }

  const cfg = config.perModel[modelId] || {};
  const targets = buildAttempts(modelId, cfg).map((a) => a.upstream).filter(Boolean);
  const isStream = !!upstreamBody.stream;

  const chain = await runChatChain(req, upstreamBody, modelId, cfg, { stream: isStream, account: pickAccount() });

  if (isStream && chain.streamUp) {
    // 流式透传：先写已探测的首块，再接剩余 body；tap 在结束时回读路由元数据并记录
    const up = chain.streamUp;
    const acc = chain.acc;
    const t0 = chain.t0;
    // Anthropic 入站：上游是 OpenAI SSE，必须逐块翻译为 Anthropic 事件序列
    if (isAnthropic) return pipeAnthropicStream(res, up, chain, modelId, targets);
    if (isResponses) return pipeResponsesStream(res, up, chain, modelId, targets, customToolNames);
    const ctype = up.headers.get('content-type') || 'text/event-stream';
    res.writeHead(up.status, {
      'Content-Type': ctype,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Attempts': String(chain.trace.length),
      'X-Cline-Account': headerSafe(acc.name),
    });
    if (chain.streamHead) res.write(chain.streamHead);
    const buf = [];
    let finalized = false;   // 正常收尾与中断两条路径只记录一次
    const tap = new Transform({
      transform(c, enc, cb) { buf.push(c); cb(null, c); },
      flush(cb) {
        const text = Buffer.concat(buf).toString('utf8');
        let provider = null, canonical = null;
        // direct 管道：最后一个 chunk 顶层带 provider（显示名）与 model
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10 && !provider; i--) {
          const l = lines[i];
          if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
          try {
            const c = JSON.parse(l.slice(6));
            if (typeof c.provider === 'string') { provider = slugify(c.provider); canonical = c.model || null; }
          } catch { /* 跳过不完整行 */ }
        }
        // planner 管道：final chunk 的 provider_metadata.gateway.routing
        if (!provider) {
          const fp = /"finalProvider":"([^"]+)"/.exec(text);
          const cs = /"canonicalSlug":"([^"]+)"/.exec(text);
          provider = fp ? fp[1] : null;
          canonical = cs ? cs[1] : null;
        }
        finalized = true;
        record(modelId, { provider, canonical, ms: Date.now() - t0, stream: true, error: null, account: acc.name, attempts: chain.trace.map((t) => t.upstream || 'auto') });
        cb();
      },
    });
    const src = Readable.fromWeb(up.body);
    // 上游 SSE 中断、解码失败或客户端断连都会让管道 emit 'error'；未监听的 stream 'error'
    // 会作为未捕获异常直接终止进程，这是生产中最容易被网络抖动触发的崩溃点。
    const onPipeError = (e) => {
      console.error(`[流式] 传输中断：${e?.message || e}`);
      // 中断也要留痕：否则请求历史里这次调用会凭空消失，排查时看不到任何线索
      if (!finalized) {
        finalized = true;
        record(modelId, {
          provider: null, canonical: null, ms: Date.now() - t0, stream: true,
          error: `流式传输中断：${e?.message || e}`, account: acc.name,
          attempts: chain.trace.map((t) => t.upstream || 'auto'),
        });
      }
      try { src.destroy(); } catch { /* 已销毁 */ }
      try { tap.destroy(); } catch { /* 已销毁 */ }
      try { res.destroy(); } catch { /* 已关闭 */ }
    };
    src.on('error', onPipeError);
    tap.on('error', onPipeError);
    res.on('error', onPipeError);
    // 客户端提前断开时释放上游连接（onClientClose 已 abort fetch，这里兜底销毁 body 流）
    res.on('close', () => { try { src.destroy(); } catch { /* 已销毁 */ } });
    src.pipe(tap).pipe(res);
    return;
  }

  const { status, out, routing, acc } = chain;
  if (!out) {
    return isAnthropic
      ? sendAnthropicError(res, 502, 'api_error', 'no upstream response')
      : isResponses
        ? sendResponsesError(res, 502, 'api_error', 'no upstream response')
        : sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } });
  }
  // 客户端实际使用成功的新订阅模型自动收录进列表。字符集与 fetchOfficialModels 保持一致，
  // 避免任意 model 名进入 knownModels 后污染 /v1/models 与控制台渲染。
  if (status === 200 && /^cline-pass\/[a-z0-9._-]+$/.test(String(modelId)) && !config.knownModels.includes(modelId)) {
    config.knownModels.push(modelId);
    saveConfig();
  }
  record(modelId, {
    provider: routing.finalProvider || null,
    canonical: routing.canonicalSlug || null,
    ms: Date.now() - chain.t0,
    stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'),
    trace: chain.trace,
    error: status !== 200 ? out?.error?.message || null : null,
    account: acc ? acc.name : null,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '',
    'X-Cline-Attempts': String(chain.trace.length),
    'X-Cline-Account': headerSafe(acc ? acc.name : ''),
  });
  // Anthropic / Responses 入站：成功时各自翻译响应体；失败时用各自的错误形状
  if (isAnthropic) {
    if (status !== 200) {
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(out?.error?.message || 'upstream error') } }));
    }
    return res.end(JSON.stringify(openAIToAnthropic(out, modelId)));
  }
  if (isResponses) {
    if (status !== 200) {
      return res.end(JSON.stringify({ error: { type: 'api_error', message: String(out?.error?.message || 'upstream error'), code: 'upstream_error' } }));
    }
    return res.end(JSON.stringify(chatToResponses(out, modelId, { previousResponseId: body.previous_response_id || null, customToolNames })));
  }
  res.end(JSON.stringify(out));
}

// ---------- HTTP 服务 ----------
// 跨源策略：
// - 管理面（/api/*）只允许同源。此前无条件回 Access-Control-Allow-Origin: * 时，任意网页都能
//   fetch('http://127.0.0.1:3123/api/accounts?reveal=1') 读走全部明文上游 Key —— 因为未设 PROXY_KEY
//   时管理面只校验回环地址，而浏览器发来的请求其 remoteAddress 正是 127.0.0.1。
// - 代理面（/v1/*）保留跨源：浏览器里的第三方客户端（不同端口/域名）依赖它。
function corsHeaders(req) {
  const origin = req?.headers?.origin;
  if (!origin) return {};                                  // curl / 服务端 SDK 不带 Origin
  const host = req?.headers?.host || '';
  if (origin === `http://${host}` || origin === `https://${host}`) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return null;                                             // 跨源：不回 CORS 头，浏览器读不到响应体
}
// 跨源判定：Origin 与 Host 不同源，或浏览器明确标记 cross-site（DNS rebinding 兜底）
function isCrossOrigin(req) {
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return true;
  const origin = req?.headers?.origin;
  if (!origin) return false;
  const host = req?.headers?.host || '';
  return origin !== `http://${host}` && origin !== `https://${host}`;
}
function sendJSON(res, status, obj) {
  const cors = corsHeaders(res.req);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(cors || {}) });
  res.end(JSON.stringify(obj));
}

async function catalog() {
  if (META.catalog && Date.now() - (META.catalogFetchedAt || 0) < 3600e3) return META.catalog;
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(pickAccount().key) });
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

// /v1/models 暴露的模型集合：默认只含订阅模型，exposeCatalog=true 时并入完整目录
async function exposedModelIds() {
  return config.exposeCatalog
    ? [...new Set([...config.knownModels, ...(await catalog())])]
    : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
}

// 密钥脱敏：保留前缀与末 4 位，中间定长掩码（不泄漏原长度）
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  const head = s.slice(0, 3);
  const tail = s.slice(-4);
  return `${head}${'*'.repeat(8)}${tail}`;
}
// 判断是否为脱敏占位（前端原样回传时不应覆盖真实密钥）
function isMasked(k) {
  return typeof k === 'string' && k.includes('********');
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return sendJSON(res, 400, { error: { message: 'malformed request url' } });
  }
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    // 管理面的跨源预检直接拒绝（同源请求不会触发预检）
    if (p.startsWith('/api/') && isCrossOrigin(req)) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(204, {
      ...(corsHeaders(req) || { 'Access-Control-Allow-Origin': '*' }),
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    // 管理面跨源一律拒绝：即使本机回环免鉴权模式，也不允许其他站点读取账号池
    if (p.startsWith('/api/') && isCrossOrigin(req)) {
      return sendJSON(res, 403, { error: { message: 'cross-origin admin request denied' } });
    }
    // 健康检查：给 Docker healthcheck / 反向代理探活使用，不含任何敏感信息
    if (req.method === 'GET' && p === '/healthz') {
      return sendJSON(res, 200, { ok: true, configured: isConfigured(), uptime: Math.round(process.uptime()) });
    }
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    // 管理面严格鉴权：密钥为空时仅允许回环地址（避免账号池被外部读取）
    if (p.startsWith('/api/') && p !== '/api/meta') {
      if (!adminOK(req)) return unauthorized(res);
    }
    // 代理面：密钥为空时放行（本地自用），非空时校验
    if ((p.startsWith('/v1/') || CHAT_PATHS.has(p)) && !authOK(req)) {
      return unauthorized(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    if (req.method === 'GET' && p === '/api/models') {
      const cat = await catalog();
      const sub = config.knownModels.map((id) => ({ id, config: config.perModel[id] || {}, meta: META.models[id] || null }));
      return sendJSON(res, 200, { subscription: sub, catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const { model } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const r = await probeModel(model);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && p === '/api/test') {
      // 临时配置可带 upstreams/exclude（数组）或旧版 upstream（单值），完整走故障转移链路
      const { model, upstream, upstreams, exclude } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const t0 = Date.now();
      const cfg = { ...(config.perModel[model] || {}) };
      if (upstreams !== undefined) cfg.upstreams = upstreams;
      else if (upstream !== undefined) cfg.upstreams = upstream ? [upstream] : [];
      if (exclude !== undefined) cfg.exclude = exclude;
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      const chain = await runChatChain(req, body, model, cfg, { stream: false, attemptTimeoutMs: 180000 });
      const trace = chain.trace || [];
      if (chain.status !== 200) {
        return sendJSON(res, 200, {
          ok: false, error: (chain.out?.error?.message || 'upstream error').slice?.(0, 400) || 'upstream error',
          targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [], trace,
        });
      }
      const r = parseRouting(chain.out);
      record(model, { provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), error: null, account: chain.acc?.name || null });
      return sendJSON(res, 200, {
        ok: true, ms: Date.now() - t0,
        targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [],
        actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null,
        canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120),
        account: chain.acc?.name || null, trace,
      });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      // 默认脱敏：只回 key 尾部 4 位。需要回填编辑时前端用 GET /api/accounts?reveal=1。
      const reveal = url.searchParams.get('reveal') === '1';
      return sendJSON(res, 200, {
        accounts: config.accounts.map((a) => ({
          ...a,
          key: reveal ? a.key : maskKey(a.key),
        })),
        mode: config.accountMode,
        active: config.activeAccount,
        stats: META.stats || {},
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const prev = config.accounts || [];
      const accs = (Array.isArray(body.accounts) ? body.accounts : [])
        .map((a, i) => {
          const raw = String(a.key || '').trim();
          // 前端未改动密钥时会回传脱敏值：按下标回填原密钥，避免把掩码写成真 key。
          // （前端目前始终以 reveal=1 拉取明文，这条分支属防御性兜底。）
          const key = isMasked(raw) ? (prev[i]?.key || '') : raw;
          // key 为空的行保留但标为停用，不再静默丢弃：用户可以暂时清空某行而不丢账号。
          // 空 key 账号不会被 enabledAccounts() 选中，因此不影响代理行为。
          return {
            name: String(a.name || `账号${i + 1}`).slice(0, 50),
            key,
            enabled: !!key && a.enabled !== false,
          };
        });
      if (!accs.some((a) => a.key)) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      config.accounts = accs;
      config.accountMode = body.mode === 'roundrobin' ? 'roundrobin' : 'single';
      config.activeAccount = Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      saveConfig();
      RR_COUNTER = 0;
      return sendJSON(res, 200, { ok: true, accounts: config.accounts.length, mode: config.accountMode, active: config.activeAccount });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const { key } = JSON.parse(await readBody(req).then((b) => b.toString()));
      const k = String(key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(k),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
      }, 120000);
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(msg);
        // 密钥无效会直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
        // 说明鉴权已通过，不应误报为密钥问题
        return sendJSON(res, 200, authFail
          ? { ok: false, ms: Date.now() - t0, error: `密钥无效或未授权：${msg.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - t0, model, note: `密钥鉴权通过；网关提示：${msg.slice(0, 120)}` });
      }
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, model });
    }
    if (req.method === 'GET' && p === '/api/security') {
      // 不回传 proxyKey 明文：管理密钥一旦被下游客户端读到即可用于改配置
      return sendJSON(res, 200, {
        hasProxyKey: !!config.proxyKey,
        proxyKeyMasked: maskKey(config.proxyKey),
        publicBaseUrl: config.publicBaseUrl || '',
        authRequired: !!PROXY_KEY,
        exposeCatalog: !!config.exposeCatalog,
      });
    }
    if (req.method === 'POST' && p === '/api/security') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      // 修改既有密钥时要求携带当前密钥（本机回环无密钥模式除外），防止下游客户端越权改配置
      if (config.proxyKey && body.currentKey !== undefined && !safeEqual(String(body.currentKey), config.proxyKey)) {
        return sendJSON(res, 401, { error: { message: 'currentKey 不正确' } });
      }
      if (body.proxyKey !== undefined) {
        const next = String(body.proxyKey).trim();
        // 传回脱敏值视为「不修改」
        if (!isMasked(next)) config.proxyKey = next;
      }
      if (body.publicBaseUrl !== undefined) config.publicBaseUrl = String(body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (body.exposeCatalog !== undefined) config.exposeCatalog = !!body.exposeCatalog;
      saveConfig();
      PROXY_KEY = config.proxyKey || '';
      return sendJSON(res, 200, {
        ok: true,
        hasProxyKey: !!config.proxyKey,
        proxyKeyMasked: maskKey(config.proxyKey),
        publicBaseUrl: config.publicBaseUrl,
        authRequired: !!PROXY_KEY,
        proxyBase: publicProxyBase(),
        exposeCatalog: !!config.exposeCatalog,
      });
    }
    if (req.method === 'POST' && p === '/api/validate-upstreams') {
      const { model } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const results = await validateUpstreams(model);
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
      for (const r of Object.values(results)) summary[r.status] = (summary[r.status] || 0) + 1;
      return sendJSON(res, 200, { ok: true, summary, results, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: META.history });
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { port: config.port, perModel: config.perModel, knownModels: config.knownModels });
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.perModel) {
        for (const [m, c] of Object.entries(body.perModel)) {
          const normalize = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
          let upstreams = normalize(c.upstreams);
          const exclude = normalize(c.exclude);
          const excl = new Set(exclude);
          upstreams = upstreams.filter((u) => !excl.has(u)); // 同时出现以 exclude 为准
          const upstream = upstreams[0] || null; // 旧字段兼容镜像
          config.perModel[m] = {
            upstream,
            upstreams,
            exclude,
            pinMode: c.pinMode === 'preferred' ? 'preferred' : 'strict',
            sort: ['cost', 'ttft', 'tps'].includes(c.sort) ? c.sort : null,
          };
        }
        saveConfig();
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = await exposedModelIds();
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    // OpenAI 兼容的单模型查询：部分客户端与下游网关自检会请求 /v1/models/{id}，缺失会被判为渠道失效。
    // 注意 id 本身含斜杠（cline-pass/xxx），不能用 [^/]+ 匹配。
    const modelOne = /^\/(?:api\/)?v1\/models\/(.+)$/.exec(p);
    if (req.method === 'GET' && modelOne) {
      let id = modelOne[1];
      try { id = decodeURIComponent(id); } catch { /* 非法转义则保留原样 */ }
      if (!(await exposedModelIds()).includes(id)) {
        return sendJSON(res, 404, { error: { message: `model not found: ${id}`, type: 'invalid_request_error' } });
      }
      return sendJSON(res, 200, { id, object: 'model', owned_by: 'cline-pass-switcher' });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    // Anthropic Messages 兼容入口：上游无原生端点，由本地做协议转换（见 anthropicToOpenAI）
    if (ANTHROPIC_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    // Responses API 兼容入口：上游无原生端点，本地做协议转换（见 responsesToChat）
    if (RESPONSES_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, 500, { error: { message: e.message } });
  }
});

// HTTP 响应头只允许 Latin-1，账号名里的中文等字符需要清洗（历史/统计仍用原名）
const headerSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 80) || '-';

server.on('error', (e) => {
  console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
  process.exit(1);
});

// 显式设置超时：Node 默认值偏宽松，慢速连接可以长时间占住 socket
server.headersTimeout = 30000;      // 请求头必须在 30s 内收完
server.requestTimeout = 300000;     // 单个请求整体上限（探测/校验类请求本身耗时较长）
server.keepAliveTimeout = 65000;

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(config.port, BIND_HOST, () => {
  const shown = BIND_HOST === '0.0.0.0' ? '所有网卡' : BIND_HOST;
  console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${config.port}/`);
  console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${config.port}/v1  （监听 ${shown}:${config.port}）`);
});

// 优雅关闭：Docker stop / systemd stop 默认会先发 SIGTERM，处理不好就是 SIGKILL 打断写盘。
// 这里先停止接收新连接、放掉空闲 keep-alive，给在途请求留出收尾时间，并强制落盘 metadata.json。
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] 正在关闭：停止接收新连接…`);
  server.close(() => {
    flushMetaSave();
    console.log('[关闭] 已安全退出');
    process.exit(0);
  });
  try { server.closeIdleConnections?.(); } catch { /* 旧版本 Node 无此方法 */ }
  // 兜底：长连接/流式请求迟迟不结束时强制退出，但先保住配置与元数据
  setTimeout(() => {
    flushMetaSave();
    console.error('[关闭] 等待超时，强制退出');
    process.exit(0);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => { try { flushMetaSave(); } catch { /* 尽力而为 */ } });
