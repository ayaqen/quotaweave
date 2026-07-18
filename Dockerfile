# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="QuotaWeave" \
      org.opencontainers.image.description="Deterministic multi-resource fairness and admission control for shared workloads." \
      org.opencontainers.image.source="https://github.com/ayaqen/quotaweave" \
      org.opencontainers.image.url="https://github.com/ayaqen/quotaweave" \
      org.opencontainers.image.documentation="https://github.com/ayaqen/quotaweave#readme" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="ayaqen"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --chown=node:node package.json README.md LICENSE ./
COPY --chown=node:node examples ./examples

USER node
STOPSIGNAL SIGTERM

ENTRYPOINT ["node"]
CMD ["examples/ai-inference.mjs"]
