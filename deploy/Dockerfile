FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.14.1-bookworm-slim AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/LEVEN924/AIEnglish" org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production HTTPS_ENABLED=false PORT=4173 BIND_HOST=127.0.0.1
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/database-maintenance.mjs scripts/verify-tencent.mjs scripts/audit-word-content.mjs ./scripts/
COPY --chown=node:node content/lessons.json ./content/lessons.json
RUN mkdir -p data backups && chown node:node data backups
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/app.mjs"]
