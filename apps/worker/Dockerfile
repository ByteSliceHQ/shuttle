# Durable Object container image for SessionSandbox.
# Needs Docker for local `wrangler dev` with SHUTTLE_WORKSPACE_MODE=container.
#
# cloudflare/sandbox is a donor image that ships sandbox-shim for @cloudflare/sandbox.
# Keep its tag equal to the installed @cloudflare/sandbox version. The runtime OS is Alpine.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM alpine:3.24
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace \
  && apk add --no-cache \
    bash git ripgrep curl ca-certificates \
    nodejs npm \
    python3

WORKDIR /workspace
CMD ["sleep", "infinity"]
