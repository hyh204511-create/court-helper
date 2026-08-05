# syntax=docker/dockerfile:1.7

# The repository keeps package.json at the project root. docker-compose.yml
# supplies that root as the named `project` build context.
FROM node:22-bookworm-slim AS build

WORKDIR /workspace

COPY --from=project package.json package-lock.json ./
RUN npm ci

COPY --from=project server/tsconfig.json ./server/tsconfig.json
COPY --from=project server/src ./server/src
COPY --from=project server/migrations ./server/migrations
RUN npm run server:build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /workspace/package.json /workspace/package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build --chown=node:node /workspace/server/dist ./server/dist
COPY --from=build --chown=node:node /workspace/server/migrations ./server/migrations
RUN mkdir -p /var/log/court-helper /var/lib/court-helper/storage \
  && chown -R node:node /var/log/court-helper /var/lib/court-helper

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "server:start"]
