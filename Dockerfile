# 零依赖运行时：只需要 node 本体（zcgw-server.mjs 无任何 npm 依赖）
FROM node:24-alpine

# 容器内以非 root 运行
RUN addgroup -S zcgw && adduser -S zcgw -G zcgw
WORKDIR /app

# 先拷程序（利用层缓存；数据卷挂 /app/data）
COPY --chown=zcgw:zcgw zcgw-server.mjs zcgw-fingerprint.mjs zcode-profile.json dashboard.html ./

# 数据目录由 compose 挂载到宿主机 ./data（宿主机需 chown 100:101 给容器内 zcgw 用户）
RUN mkdir -p /app/data && chown zcgw:zcgw /app/data
ENV ZCGW_DATA_DIR=/app/data
USER zcgw

EXPOSE 8787
CMD ["node", "zcgw-server.mjs"]
