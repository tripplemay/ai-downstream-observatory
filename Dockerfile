FROM node:22-bookworm-slim AS evaluation-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --no-audit --no-fund
COPY contracts/ ./contracts/
COPY migrations/ ./migrations/
COPY web/src/server/ ./web/src/server/
COPY web/scripts/build-evaluation-worker.mjs web/scripts/monthly-evaluation.ts ./web/scripts/
COPY web/tsconfig.json ./web/tsconfig.json
RUN npm --prefix web run build:evaluation-worker

FROM python:3.11-slim-bookworm

ARG RELEASE_SHA=development
LABEL org.opencontainers.image.revision=$RELEASE_SHA

WORKDIR /app

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libstdc++6 libatomic1 tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=evaluation-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=evaluation-builder /build/web/dist/monthly-evaluation.mjs ./worker-bridge/monthly-evaluation.mjs
# The bundle contains all JS dependencies except SQLite's native module loader.
COPY --from=evaluation-builder /build/web/node_modules/better-sqlite3/ ./worker-bridge/node_modules/better-sqlite3/
COPY --from=evaluation-builder /build/web/node_modules/bindings/ ./worker-bridge/node_modules/bindings/
COPY --from=evaluation-builder /build/web/node_modules/file-uri-to-path/ ./worker-bridge/node_modules/file-uri-to-path/
RUN node --input-type=module -e "import Database from './worker-bridge/node_modules/better-sqlite3/lib/index.js'; const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();"

COPY requirements-workbench.txt .
RUN pip install --no-cache-dir -r requirements-workbench.txt

COPY worker/accounting/ ./worker/accounting/
COPY worker/market/ ./worker/market/
COPY worker/orchestration/ ./worker/orchestration/
COPY worker/performance/ ./worker/performance/
COPY worker/research/ ./worker/research/
COPY contracts/ ./contracts/
COPY migrations/ ./migrations/

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WORKBENCH_DB_PATH=/app/data/etf-workbench.db \
    WORKBENCH_DATA_DIR=/app/data

RUN groupadd --gid 10001 workbench && useradd --uid 10001 --gid workbench --no-create-home workbench
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["python", "-c", "import os; from worker.orchestration.db import open_database; c=open_database(os.environ['WORKBENCH_DB_PATH']); c.close()"]
CMD ["python", "-m", "worker.orchestration"]
