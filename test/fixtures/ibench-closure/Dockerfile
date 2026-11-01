ARG BASE_IMAGE=node:24.15.0-bookworm-slim
FROM ${BASE_IMAGE}

RUN if ! command -v git || ! command -v python3; then \
      apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates; \
    fi

RUN --mount=type=cache,target=/root/.npm \
    arch=$(node -p process.arch) \
    && npm install --prefix /root/.ibench-best-agent --no-audit --no-fund \
       @best-agent/cli@0.0.19 "@best-agent/cli-linux-${arch}-gnu@0.0.19" \
    && mkdir -p /opt/ibench-npm-cache \
    && cp -a /root/.npm/_cacache /opt/ibench-npm-cache/

RUN /root/.ibench-best-agent/node_modules/.bin/best-agent --version \
    && if /root/.ibench-best-agent/node_modules/.bin/best-agent run \
       --attempt-remaining-ms 60000 fixture >/opt/cli-budget-admission.txt 2>&1; then exit 1; fi \
    && grep -q -- '--attempt-remaining-ms must exceed 60000 milliseconds.' /opt/cli-budget-admission.txt

RUN test ! -e /workspace/app \
    && mkdir -p /workspace/app \
    && printf 'module.exports = (a, b) => a - b;\n' > /workspace/app/calc.js \
    && cd /workspace/app \
    && git init -q -b main \
    && git -c user.name=fixture -c user.email=fixture@invalid add -A \
    && git -c user.name=fixture -c user.email=fixture@invalid commit -qm base \
    && git rev-parse HEAD > /opt/prepared-sha

WORKDIR /workspace
