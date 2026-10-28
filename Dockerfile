# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
# Chromium + its system libraries/fonts come from Playwright; deps need root, the app itself runs as "node".
RUN npm ci --omit=dev \
    && npx playwright-core install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY test ./test
COPY docs/API.md ./docs/API.md

RUN mkdir -p /app/data /app/backups && chown -R node:node /app /ms-playwright
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
