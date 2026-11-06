# zcgw-captcha：阿里云无痕验证参数铸造 sidecar
# 基于微软官方 Playwright 镜像（自带 Chromium / Firefox 及其系统依赖、Xvfb，支持 amd64 + arm64），按 digest 固定
# v1.65.0-noble 多架构索引（amd64 / arm64）
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=8790 \
    CAPTCHA_BROWSER=firefox

# 只装 playwright-core（零依赖，版本与基础镜像里的浏览器一致）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.mjs page.html entrypoint.sh ./
RUN chmod +x entrypoint.sh && chown -R pwuser:pwuser /app

# 以镜像自带的非 root 用户 pwuser 运行
USER pwuser

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["./entrypoint.sh"]
