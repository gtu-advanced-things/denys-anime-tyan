FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.166.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git espeak-ng \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund "@openai/codex@${CODEX_VERSION}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server.mjs guide-mcp.mjs codex.mjs gtu-prompt.txt gtu-posters.json ./
COPY web ./web
COPY public ./public
RUN npm run build
ENV NODE_ENV=production PORT=22004 BIND_ADDRESS=0.0.0.0
USER node
EXPOSE 22004
CMD ["node", "server.mjs"]
