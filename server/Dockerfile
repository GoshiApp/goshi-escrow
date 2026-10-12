# Build from the repo root so devnet-config.json is in the context:
#   docker build -f server/Dockerfile .
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

COPY server/src ./server/src
COPY server/tsconfig.json ./server/tsconfig.json
COPY devnet-config.json ./devnet-config.json

ENV DEVNET_CONFIG=/app/devnet-config.json
# The authority key is mounted from Secret Manager at run time, never baked into the image.
ENV AUTHORITY_KEYPAIR_PATH=/secrets/authority.json
ENV PORT=8080

RUN mkdir -p /app/server/.devbots && chown -R node:node /app/server
USER node
WORKDIR /app/server
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
