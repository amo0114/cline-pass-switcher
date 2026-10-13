#!/usr/bin/env bash
# 判定 Cline 上游是否原生支持 Anthropic Messages API 与 OpenAI Responses API。
#
#   CLINE_PASS_KEY='sk_...' ./scripts/probe-upstream-protocols.sh
#
# 默认两阶段，**阶段一零 token 消耗**：
#   阶段一 端点探针：请求体合法但模型名是伪造的，网关在模型解析层即拒绝，
#                    不会路由到任何真实渠道，因此不产生计费 token。
#                    响应里回显该假模型名 => 端点存在；报 no route/404 => 端点不存在。
#   阶段二 实测验证：仅在阶段一判定端点「存在」时才跑，默认关闭。
#                    开启后对存在的端点用真实模型发一次最小请求。
#
# 可选覆盖：
#   CLINE_BASE      上游基址，默认 https://api.cline.bot/api/v1
#   CLINE_LIVE_MODEL 阶段二真实模型，默认 cline-pass/deepseek-v4.1-flash
#   CLINE_LIVE      置 1 开启阶段二，默认 0（只做零消耗探针）
#   CLINE_MAX_TOKENS 阶段二 max_tokens，默认 512
#   CLINE_TIMEOUT   单次请求超时秒数，默认 60
#
# ⚠️ 关于 max_tokens 与推理模型（实测踩过的坑）：
#   deepseek-v4.1-flash 等模型默认开启思考，reasoning 会先吃掉 max_tokens，
#   给 16 这类小值会直接返回 {"error":"empty response content"} 500，
#   看起来像「模型/端点有问题」，实为推理预算耗尽。因此：
#     - 默认 max_tokens 取 512；
#     - 且阶段二统一带 reasoning_effort:"none"（实测 reasoning_tokens=0），
#       从根源上避免探测被推理内容干扰。
#   需要测「带思考」的行为时，用 CLINE_MAX_TOKENS 显式调大并去掉 effor 覆盖。

#
# key 仅用于本次请求的 Authorization 头：不回显、不写盘、不进日志。
#
# 为什么必须带有效 key：该网关的鉴权中间件位于路由之前，无凭证时任何路径（含不存在的
# 路径）都返回同一个 401，端点存在性无法区分。带 key 后对比「候选路径」与「必然不存在的
# 对照路径」才有判定意义。

set -uo pipefail

BASE="${CLINE_BASE:-https://api.cline.bot/api/v1}"
KEY="${CLINE_PASS_KEY:-}"
TIMEOUT="${CLINE_TIMEOUT:-60}"
LIVE_MODEL="${CLINE_LIVE_MODEL:-cline-pass/deepseek-v4.1-flash}"
DO_LIVE="${CLINE_LIVE:-0}"
# 推理模型会先用 reasoning 吃掉预算，给太小会得到 empty response 而误判
MAX_TOKENS="${CLINE_MAX_TOKENS:-512}"
# 探测统一关掉思考：实测 reasoning_effort:"none" 时 reasoning_tokens=0，从根源消除干扰
PROBE_NO_THINK='"reasoning_effort":"none"'
CONTROL_PATH='/__probe_nonexistent_path__'
# 伪造模型名：故意不可能存在，且带独特后缀便于在响应里精确回显匹配
FAKE_MODEL='__probe_nonexistent_model_xyz__'

if [ -z "$KEY" ]; then
  printf '缺少 CLINE_PASS_KEY（Cline Pass 的 key，sk_ 开头）\n' >&2
  exit 2
fi

# probe <path> <json>  ->  输出 "<status>\t<单行响应体>"
probe() {
  local path="$1" payload="$2" out status body
  out=$(curl -s -m "$TIMEOUT" -w $'\n%{http_code}' \
    -X POST "${BASE%/}${path}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${KEY}" \
    -d "$payload" 2>/dev/null)
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  printf '%s\t%s' "$status" "$(printf '%s' "$body" | tr -d '\n\r' | cut -c1-300)"
}

make_payload() {
  # $1=形状  $2=模型名  $3=是否附带请求参数（阶段一不加任何额外参数，保持"结构合法但模型假"的最小形态）
  local shape="$1" model="$2" extra="${3:-}"
  case "$shape" in
    # Anthropic 入站形状
    anthropic) printf '{"model":"%s","max_tokens":%s%s,"messages":[{"role":"user","content":"hi"}]}' "$model" "$MAX_TOKENS" "$extra" ;;
    # OpenAI 入站形状（基线）
    openai)    printf '{"model":"%s","max_tokens":%s%s,"messages":[{"role":"user","content":"hi"}]}' "$model" "$MAX_TOKENS" "$extra" ;;
    # Responses 入站形状
    responses) printf '{"model":"%s","input":"hi","max_output_tokens":%s%s}' "$model" "$MAX_TOKENS" "$extra" ;;
  esac
}

# 阶段一判定：只看请求是否被路由到模型解析层
classify_probe() {
  local status="$1" body="$2"
  case "$status" in
    401|403) printf '鉴权失败(key 无效或无权限)'; return ;;
  esac
  # 最强信号：响应回显了我们伪造的模型名，说明端点存在且完成了路由
  if printf '%s' "$body" | grep -qF "$FAKE_MODEL"; then
    printf '存在(零token确认)'; return
  fi
  if [ "$status" = '404' ] || printf '%s' "$body" | grep -qiE 'no route|route not found|cannot POST|unknown route|not implemented'; then
    printf '不存在'; return
  fi
  case "$status" in
    200) printf '存在(未校验模型名)' ;;
    400|422) printf '疑似存在(需人工看响应)' ;;
    *) printf '未知(见响应)' ;;
  esac
}

# 阶段二判定：真实响应结构是否符合该协议
classify_live() {
  local status="$1" body="$2" kind="$3"
  case "$status" in
    401|403) printf '鉴权失败'; return ;;
  esac
  case "$kind" in
    anthropic)
      printf '%s' "$body" | grep -qE '"type"[[:space:]]*:[[:space:]]*"message"|"content"[[:space:]]*:[[:space:]]*\[' \
        && { printf '原生Anthropic格式'; return; } ;;
    responses)
      printf '%s' "$body" | grep -qE '"object"[[:space:]]*:[[:space:]]*"response"' \
        && { printf '原生Responses格式'; return; } ;;
    openai)
      printf '%s' "$body" | grep -qE '"object"[[:space:]]*:[[:space:]]*"chat\.completion"|"choices"[[:space:]]*:[[:space:]]*\[' \
        && { printf '基线可用(OpenAI格式)'; return; } ;;
  esac
  printf 'HTTP %s(格式不匹配)' "$status"
}

printf '上游基址 : %s\n' "$BASE"
printf '阶段一   : 零 token 端点探针（伪造模型名 %s）\n' "$FAKE_MODEL"
printf '\n'

# 对照组：无 key 时它与真实端点同返 401，带 key 后应稳定 404
IFS=$'\t' read -r c_status c_body <<<"$(probe "$CONTROL_PATH" '{}')"
printf '对照路径 %s -> HTTP %s（预期 404）\n' "$CONTROL_PATH" "$c_status"
if [ "$c_status" = '401' ] || [ "$c_status" = '403' ]; then
  printf '\n中止：key 未通过鉴权，无法区分端点存在性。请确认 key 有效。\n' >&2
  exit 1
fi
if [ "$c_status" != '404' ]; then
  printf '\n注意：对照路径未返回 404（实际 %s），判定基准可能不稳，结论请谨慎采信。\n' "$c_status"
fi
printf '\n'

CANDIDATES=("/messages|anthropic" "/chat/completions|openai" "/responses|responses")

declare -A EXISTS
printf '阶段一：端点存在性（零 token 消耗）\n'
printf '  %-18s %-6s %-24s %s\n' '路径' '状态' '判定' '原始响应(截断)'
printf '  %s\n' '------------------------------------------------------------------------------------------'
for entry in "${CANDIDATES[@]}"; do
  IFS='|' read -r path kind <<<"$entry"
  IFS=$'\t' read -r status body <<<"$(probe "$path" "$(make_payload "$kind" "$FAKE_MODEL")")"
  verdict="$(classify_probe "$status" "$body")"
  EXISTS["$path"]="$verdict"
  printf '  %-18s %-6s %-24s %s\n' "$path" "$status" "$verdict" "$body"
done
printf '\n'

# 阶段二：仅在用户显式开启、且阶段一确认存在时才发起真实请求
if [ "$DO_LIVE" != '1' ]; then
  printf '阶段二已跳过（默认关闭，零消耗）。\n'
  printf '如需用真实模型实测协议响应格式，追加 CLINE_LIVE=1 重跑，\n'
  printf '届时仅对阶段一判定「存在」的端点各发 1 次、max_tokens=16 的最小请求。\n'
  printf '\n'
else
  printf '阶段二：真实响应格式实测（模型 %s，max_tokens=%s，reasoning_effort=none）\n' "$LIVE_MODEL" "$MAX_TOKENS"
  printf '  %-18s %-6s %-24s %s\n' '路径' '状态' '判定' '原始响应(截断)'
  printf '  %s\n' '------------------------------------------------------------------------------------------'
  for entry in "${CANDIDATES[@]}"; do
    IFS='|' read -r path kind <<<"$entry"
    if [ "${EXISTS[$path]}" = '不存在' ]; then
      printf '  %-18s %-6s %-24s %s\n' "$path" '-' '跳过(阶段一判定不存在)' '不产生消耗'
      continue
    fi
    # 显式关掉思考，避免 reasoning 吃掉 max_tokens 造成 empty response 误判
    IFS=$'\t' read -r status body <<<"$(probe "$path" "$(make_payload "$kind" "$LIVE_MODEL" ",$PROBE_NO_THINK")")"
    printf '  %-18s %-6s %-24s %s\n' "$path" "$status" "$(classify_live "$status" "$body" "$kind")" "$body"
  done
  printf '\n'
fi

printf '判读：\n'
printf '  - /chat/completions 是基线。真实请求下它非 200，说明 key 或模型名有误，\n'
printf '    其余端点的结论不具参考性。\n'
printf '  - /messages 判定「存在」=> 上游有 Anthropic 端点，代理层可直接透传，\n'
printf '    max_tokens / thinking 语义无需本地模拟，实现量大幅下降。\n'
printf '  - /messages 判定「不存在」=> 需在代理内做 Anthropic <-> OpenAI 协议转换。\n'
