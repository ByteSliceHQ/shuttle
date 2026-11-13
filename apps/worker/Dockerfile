# Durable Object container image for SessionSandbox.
# Needs Docker for local `wrangler dev` with SHUTTLE_WORKSPACE_MODE=container.
#
# cloudflare/sandbox is a donor image that ships sandbox-shim for @cloudflare/sandbox.
# Keep its tag equal to the installed @cloudflare/sandbox version.
#
# The runtime OS is Debian, not Alpine: the Cursor CLI bundles a glibc runtime that does not
# run on musl. The vendor agent CLIs are baked in so a subscription session starts without an
# install step; they account for most of the image size.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash git ripgrep curl ca-certificates \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# Vendor coding agents, run under the developer's own subscription.
ARG CODEX_VERSION=0.169.0
ARG CLAUDE_CODE_VERSION=2.1.323
RUN npm install -g --no-fund --no-audit \
    @openai/codex@${CODEX_VERSION} \
    @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force
# Cursor publishes its CLI through this installer only; it installs to /root/.local/bin.
RUN curl -fsS https://cursor.com/install | bash
ENV PATH="/root/.local/bin:${PATH}"

# shuttle-agent-bridge drives those agents for the Worker. Node runs the TypeScript directly.
COPY bridge /opt/shuttle-bridge

WORKDIR /workspace
CMD ["sleep", "infinity"]
