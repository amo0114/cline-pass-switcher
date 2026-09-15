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

# 容器内以非 root 运行；数据目录属主由 entrypoint 在启动时纠正
USER node

# 健康检查：Docker / compose 可据此判断容器是否真的在服务（而不是仅仅进程存活）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3123)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
