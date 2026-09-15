# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

**零依赖**的 Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住上游** —— 严格钉住 / 优先+回退两种模式，支持按最低成本、最快首字、最高吞吐排序
- 🧬 **多上游优先级故障转移（2026-09-06 新增）** —— 勾选多个上游即按勾选顺序逐个尝试：第一个异常（报错 / 网络失败 / 超时）自动顺切下一个，全部失败才透传错误；每次尝试有独立 120s 超时与逐次尝试明细（请求头 X-Cline-Target-Upstream: a>b 与 X-Cline-Attempts，历史与测试台展示逐次尝试路径 upstream(502) 到 upstream(200)）
- 🚫 **上游排除** —— 勾「排除」的渠道永不被使用：勾选模式下从候选中剔除；自动模式与优先+回退模式下把排除换算成 only 白名单（已知上游 - 排除项）注入，两类管道均实测生效；网关侧渠道清单更新导致白名单过期时，报错中附带的最新渠道清单会被自动学习合并
- 👥 **账号池** —— 多账号管理、手动切换、轮询均衡、逐账号连通性测试与用量统计
- 📊 **观测** —— 每条请求自动记录实际命中的渠道、背后模型、耗时（含流式）
- 🔑 **代理密钥** —— 给下游客户端发一把独立密钥，可随时在页面轮换
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## 30 秒上手（本地）

```bash
git clone https://github.com/<你的用户名>/cline-pass-switcher.git
cd cline-pass-switcher
node server.js        # 仅需 Node ≥ 18，无需 npm install
```

打开 <http://127.0.0.1:3123/>，在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。
没有 key 也能启动：页面会提示配置入口。

> Cline Pass key 从哪里来？购买 Cline Pass 订阅后，在 Cline 的账户设置里创建 API Key。
> 订阅模型 ID 均为 `cline-pass/*` 前缀（如 `cline-pass/glm-5.2`）。

客户端接入（任何 OpenAI 兼容工具）：

```
Base URL: http://127.0.0.1:3123/v1
API Key:  （在控制台「访问与安全」里设置代理密钥；本地留空 = 不鉴权）
Model:    cline-pass/glm-5.2 等
```

---

## Docker 部署

### 方式 A：All-in-one（自带 Caddy 自动 HTTPS，推荐新手）

```bash
mkdir -p data && cp config.example.json data/config.json
# 编辑 data/config.json，或在启动时用环境变量注入 key

# 有域名（A 记录指向服务器，自动签发 Let's Encrypt 受信证书）：
CPASS_DOMAIN=pass.example.com docker compose -f deploy/docker-compose.all-in-one.yml up -d --build

# 只有 IP（自签证书，浏览器需手动信任一次）：
docker compose -f deploy/docker-compose.all-in-one.yml up -d --build
```

访问 `https://你的域名/`（或 `https://服务器IP/`），控制台里设置代理密钥即可对外提供服务。

### 方式 B：已有一个性化反代（nginx 门户等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 方式 C：作为 new-api 的上游（同机容器对接）

如果你用 [new-api](https://github.com/QuantumNous/new-api) 做统一网关，本服务可以作为它的一个普通上游渠道。**钉上游的旋钮留在本服务的控制台，不需要在 new-api 侧写任何 `param_override`** —— 两边重复配置会互相干扰（`injectPrefs()` 会按本服务的 `perModel` 重新构造请求体，覆盖 new-api 注入的同名字段）。

链路：`客户端 → new-api → cline-pass-switcher → Cline 网关`

`docker-compose.yml` 已按此场景配好。关键是三者：与 new-api 同网络、容器内绑 `0.0.0.0`、设置 `PROXY_KEY`。

```bash
git clone https://github.com/amo0114/cline-pass-switcher.git && cd cline-pass-switcher
mkdir -p data && cp config.example.json data/config.json
cp .env.example .env
vi .env                     # 设置 PROXY_KEY（必填）
docker compose up -d --build
```

网络接线：本服务默认加入 `cliproxyapi_default` 网络（已在 `docker-compose.yml` 中设为默认值）。

```bash
docker network ls | grep -i cliproxyapi     # 确认网络存在
```

若你的环境网络名不同，在 `.env` 里改 `NET_NAME=<实际网络名>`。**该网络声明为 external，名称填错或不存在时 compose 会报 `network ... declared as external, but could not be found` 并中止**（这是刻意设计：宁可明确报错，也不要静默起在错误的网络里）。

如果不确定网络名，也可以先独立启动再接入：

```bash
docker compose up -d --build
docker network connect cliproxyapi_default cline-pass-console
```

启动后验证互通：

```bash
docker run --rm --network cliproxyapi_default curlimages/curl:latest \
  -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $PROXY_KEY" \
  http://cline-pass-console:3123/v1/models
# 返回 200 即通
```

在 new-api 后台新建渠道：

| 字段 | 值 |
|---|---|
| 类型 | `Custom`（OpenAI 兼容） |
| Base URL | `http://cline-pass-console:3123/v1`（容器名直连，容器内 DNS 解析） |
| 密钥 | 与 `PROXY_KEY` 相同 |
| 模型 | 点「获取模型列表」自动拉取；或用 `model_mapping` 把 `cline-pass/*` 映射成你想要的对外名 |

**行为差异（重要）**：本服务的「失败自动顺切下一个上游」是在**同一请求内**改写 `provider.only` 重发；new-api 的故障转移是换**渠道**。若要做到「同一模型、上游 A 挂了切上游 B」，在 new-api 建两个渠道（同模型、不同 `Priority`），或直接在本服务控制台配好「优先 + 回退」，由本服务内部完成切换。

**本服务默认不发布端口到宿主机**。要从本机浏览器访问控制台，取消 `docker-compose.yml` 里 `ports` 的注释后 `docker compose up -d`，用完记得注释回去。

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（客户端/new-api 访问代理的凭据）；**对外部署或容器对接必填** |
| `PUBLIC_BASE_URL` | 门户展示的公网代理地址，如 `https://pass.example.com` |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内必须 0.0.0.0）/ 配置目录 |
| `NET_NAME` | 仅在 `docker-compose.yml` 中使用，指定 new-api 所在网络名 |

环境变量在启动时覆盖 `config.json`；此后通过控制台保存设置，会以当前生效值写回文件。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ name, key, enabled }]` |
| `accountMode` | `single` 手动指定 / `roundrobin` 轮询 |
| `activeAccount` | 单账号模式下使用的下标 |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `perModel` | 每模型的钉住配置：`{ upstream, pinMode: strict|preferred, sort: cost|ttft|tps, maxRetries }` |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only / order` |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / order / sort`** |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃
（这也是官方 API 上"换上游不生效"的原因），但 `providerOptions.gateway` 嵌套形式会**原样透传**：

```json
{
  "model": "cline-pass/glm-5.2",
  "messages": [],
  "providerOptions": { "gateway": { "only": ["alibaba"] } }
}
```

实测响应：`finalProvider: "alibaba"`，规划器理由变为 `Provider set restricted to: alibaba`。
参考：[Vercel AI Gateway — Provider Filtering, Ordering & Sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

### 上游枚举的三种手段

1. **响应元数据回读**：规划器管道带 `canonicalSlug` / `fallbacksAvailable` / `finalProvider`；直连管道顶层 `provider` 即实际上游；
2. **假上游探测**（零 token）：带不存在的 `only:["__probe__"]` 让网关在路由层报错并列出精确的可用渠道清单（两条管道的清单**不一致**，要分别取）；
3. **OpenRouter 公开接口** `GET /api/v1/models/{slug}/endpoints`：补充上下文长度/在线率（对直连管道有直接参考意义）。

### 实测记录（2026-09）

| 实验 | 结果 |
|---|---|
| glm-5.2 + 顶层 `provider.only/ignore/order` | 全部被网关丢弃，恒选同一渠道 |
| glm-5.2 + `providerOptions.gateway.only:["alibaba"]` | ✔ `finalProvider: alibaba` |
| glm-5.2 流式 + `only:["baseten"]` | ✔ 流式同样生效 |
| glm-5.2 + `providerOptions.gateway.sort:"cost"` | ✔ 按成本重排执行顺序 |
| glm-5.3-flash（直连）+ 顶层 `provider.only:["gmicloud"]` | ✔ `provider: "GMICloud"` |
| glm-5.3-flash + `providerOptions.gateway` | ✘ 无效（直连管道只认顶层 provider 形式） |

> 管道归属由 Cline 侧决定、可能随时间变化，控制台的「探测」会刷新每个模型的管道类型与渠道清单。

---

## 控制台功能一览

| 卡片 | 功能 |
|---|---|
| 账号管理 | 账号池增删改、显隐密钥、逐账号连通性测试、单账号/轮询模式、用量统计 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道数 / 最近实际渠道；渠道下拉（带可用性标注）；严格钉住 / 优先+回退；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（全渠道实测地图） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求历史 | 自动记录每条请求的账号、实际渠道、耗时、尝试序列（最近 100 条，含流式） |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式、错误统一为
`{"error":{"message":...}}`、附加 `X-Cline-Target-Upstream / X-Cline-Actual-Upstream / X-Cline-Account` 等响应头。

---

## 常见问题

**Q：为什么选了某个渠道会报 `invalid_request_error`？**
部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**
能。限流是共享池的临时状态，过段时间重新「校验」即可；或改用「优先+回退」模式，限流时自动跳到其他渠道。

**Q：直接用官方 API 写 `provider.only` 为什么不生效？**
对规划器管道（走 Vercel AI Gateway 的模型）会被 Cline 网关丢弃，请改用 `providerOptions.gateway`，见上文。

**Q：两条管道的渠道清单为什么不一样？**
钉住发生在不同后端（OpenRouter vs Vercel AI Gateway），各自支持的渠道池不同，要以对应清单为准。

**Q：订阅额度怎么计？**
经代理的请求与直连官方 API 计费一致；「探测/测试/校验」会产生极小额的真实请求（每次约 0.0002 美元级）。

---

## 安全模型

鉴权分两层，理解这一点再决定怎么部署：

**代理面（`/v1/*`、`/chat/completions`）** —— 给下游客户端调用。`proxyKey` 为空时放行，非空时校验 `Authorization: Bearer <key>`。

**管理面（`/api/*`）** —— 读写账号池、代理密钥、模型配置。`proxyKey` 为空时**仅允许回环地址（127.0.0.1 / ::1）访问**，非回环来源一律 401；设置了 `proxyKey` 则要求携带凭据。`/api/meta` 例外，始终匿名可访问，仅供前端探测鉴权状态。

这样设计的原因：未设密钥时若管理面也放行，任何能访问到端口的人都能读走账号池里的明文 `sk_` 密钥。

**密钥脱敏**：`GET /api/accounts` 默认只回 `sk_********3456` 形式的掩码，需显式加 `?reveal=1` 才返回明文；`GET /api/security` 永不返回 `proxyKey` 明文。前端保存时若回传的是掩码值，服务端识别为「不修改」，不会把掩码写成真密钥。

**密钥比较**使用 `crypto.timingSafeEqual`（先各自 sha256 成定长摘要），避免通过响应时间反推密钥。

### 部署对照

| 场景 | BIND_HOST | PROXY_KEY | 管理面可达性 |
|---|---|---|---|
| 本机自用 | `127.0.0.1`（默认） | 留空 | 回环免密钥，外部不可达 |
| new-api 同机容器对接 | `0.0.0.0` | **必须设置** | 同网络容器凭密钥访问，不发布端口 |
| 对外暴露（Caddy/Nginx） | `0.0.0.0` | **必须设置** | 凭密钥访问；未设密钥时反代来源将被拒绝 |

⚠️ **对外部署必须设 `PROXY_KEY`**：经反向代理进来的请求来源是容器内网地址而非回环，未设密钥时管理面会直接拒绝，控制台将无法加载数据。

### 其他提醒

- `config.json` / `data/` 含明文密钥，已在 `.gitignore` 排除，**不要提交或分享**；
- `metadata.json` 的 `history` 记录每次请求的模型、账号名、实际上游与耗时。若对外提供服务，该文件含业务调用痕迹，不要暴露控制台给终端用户；
- 「重试博弈」`maxRetries > 0` 时会放大请求量，注意额度消耗。

## License

[MIT](LICENSE)
