# Build from the repo root so devnet-config.json is in the context:
#   docker build -f server/Dockerfile .
# Pinned by digest: the base image changes only when this line is changed on purpose.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

COPY server/src ./server/src
COPY server/tsconfig.json ./server/tsconfig.json
COPY *-config.json ./

ENV DEVNET_CONFIG=/app/devnet-config.json
# The authority key is mounted from Secret Manager at run time, never baked into the image.
ENV AUTHORITY_KEYPAIR_PATH=/secrets/authority.json
ENV PORT=8080

RUN mkdir -p /app/server/.devbots && chown -R node:node /app/server
USER node
WORKDIR /app/server
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
