FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runtime
ARG VERSION=1.0.4
LABEL org.opencontainers.image.title="xiazai" \
      org.opencontainers.image.source="https://github.com/a06342637/xiazai" \
      org.opencontainers.image.version="$VERSION"
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY updater ./updater
COPY scripts/bootstrap-admin.mjs ./scripts/bootstrap-admin.mjs
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
