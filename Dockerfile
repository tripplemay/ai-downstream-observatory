FROM python:3.11-slim

ARG RELEASE_SHA=development
LABEL org.opencontainers.image.revision=$RELEASE_SHA

WORKDIR /app

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
