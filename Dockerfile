FROM node:22-alpine

# 零依赖项目：只需要 node 本体 + su-exec（入口脚本降权用）
RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json server.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV DATA_DIR=/data \
    BIND_HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 3123

# 刻意不在此处写 USER node：entrypoint 需要先以 root 启动，才能对 bind mount 进来的
# /data 执行 chown（其属主由宿主机决定，构建期无法预知），随后用 su-exec 降权到 node。
# 若在这里写 USER node，进程一开始就是 uid=1000，entrypoint 中的
# `if [ "$(id -u)" = "0" ]` 分支永不成立，chown 成为死代码——当宿主机 data/ 属主是
# root（例如从旧版以 root 运行的容器升级上来）时会读不到 config.json，
# 报 EACCES 并以默认配置启动，表现为账号池"消失"。
# 最终运行身份仍是 node（见 docker-entrypoint.sh），root 仅存在于启动瞬间。

# 健康检查：Docker / compose 可据此判断容器是否真的在服务（而不是仅仅进程存活）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3123)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
