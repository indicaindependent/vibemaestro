# VibeMaestro compute — OpenCode serve, version-pinned, Capy pack baked in.
# SECURITY (CVE-2026-22812): OpenCode server is UNAUTHENTICATED — never publicly reachable.
# Bound to Fly 6PN private address only, fronted by the session-gated app worker via Flycast.
FROM node:22-slim

ARG OPENCODE_VERSION=1.17.15
# Robust apt: retry mirror, tolerate transient failures. node:22-slim already ships ca-certificates.
RUN set -eux; \
    for i in 1 2 3; do apt-get update && break || sleep 5; done; \
    apt-get install -y --no-install-recommends git || apt-get install -y --no-install-recommends --fix-missing git; \
    npm install -g opencode-ai@${OPENCODE_VERSION}; \
    npm cache clean --force; \
    apt-get clean

RUN useradd -m -u 10001 vibe
WORKDIR /workspace
COPY --chown=vibe:vibe capy-pack/ /home/vibe/.config/opencode/
COPY --chown=vibe:vibe bridge/ /app/bridge/
COPY --chown=vibe:vibe entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /workspaces && chown -R vibe:vibe /workspaces && chmod +x /usr/local/bin/entrypoint.sh && chown -R vibe:vibe /workspace
USER vibe
ENV OPENCODE_CONFIG=/home/vibe/.config/opencode/opencode.json
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
