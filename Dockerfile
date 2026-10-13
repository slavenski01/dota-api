# Versions match the workspace toolchain. Update deliberately and rerun acceptance.
ARG REGISTRY=docker.io/library
FROM ${REGISTRY}/eclipse-temurin:21.0.12.1_1-jdk-jammy@sha256:e0c60c487345d1dc9d0fc7b6f0496f3cc941e5132e09296cc17a6decc71b902b AS parser
WORKDIR /app
COPY services/replay-parser services/replay-parser
COPY packages/contracts/schema packages/contracts/schema
RUN ./services/replay-parser/gradlew --project-dir services/replay-parser --no-daemon build installDist

FROM ${REGISTRY}/node:26.3.0-bookworm-slim@sha256:3fe807a03a4436e7bc76b7e84e6861899cd75c9028ae99bc00581940141ae150 AS build
WORKDIR /app
RUN npm install --global npm@11.16.0
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm ci && npm run build:ts && npm prune --omit=dev && rm -rf apps/web/.next/cache

FROM ${REGISTRY}/eclipse-temurin:21.0.12.1_1-jre-jammy@sha256:f04fb34e053148344e83317976114ec3f37e4b830ec8bdab5a2fe3cecd7d010b AS java
FROM ${REGISTRY}/node:26.3.0-bookworm-slim@sha256:3fe807a03a4436e7bc76b7e84e6861899cd75c9028ae99bc00581940141ae150 AS runtime
RUN apt-get update && apt-get install --yes --no-install-recommends bzip2 procps ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/dota/storage && chown node:node /var/lib/dota/storage
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH="/opt/java/openjdk/bin:${PATH}" \
    NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 STORAGE_ROOT=/var/lib/dota/storage
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --from=parser --chown=node:node /app/services/replay-parser/build/install/replay-parser /app/services/replay-parser/build/install/replay-parser
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0"]
