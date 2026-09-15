#!/bin/sh
set -e

# 以 root 启动时把数据目录交给 node 用户再降权运行。
# 这样做的原因：docker compose 里 ./data 是 bind mount，其属主由宿主机决定；
# 若容器直接以 node(1000) 运行而宿主目录属主是 root，应用会因无法写入 config.json
# 而静默丢掉配置。这里先纠正属主，再 exec 降权，两边都不牺牲。
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
