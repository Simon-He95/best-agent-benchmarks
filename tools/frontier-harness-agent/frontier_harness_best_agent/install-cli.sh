#!/usr/bin/env bash

set -euo pipefail

CLI_TARBALL="${CLI_TARBALL:?CLI_TARBALL is required}"
CLI_TARBALL_SHA256="${CLI_TARBALL_SHA256:?CLI_TARBALL_SHA256 is required}"
CLI_BINARY_SHA256="${CLI_BINARY_SHA256:?CLI_BINARY_SHA256 is required}"
CLI_NODE_SHA256="${CLI_NODE_SHA256:?CLI_NODE_SHA256 is required}"
CLI_NODE_VERSION="${CLI_NODE_VERSION:?CLI_NODE_VERSION is required}"
CLI_RUNTIME_LOCK_SHA256="${CLI_RUNTIME_LOCK_SHA256:?CLI_RUNTIME_LOCK_SHA256 is required}"

INSTALL_DIR="$HOME/.best-agent-cli"
printf '%s  %s\n' "$CLI_TARBALL_SHA256" "$CLI_TARBALL" | sha256sum --check
mkdir "$INSTALL_DIR"
tar xzf "$CLI_TARBALL" -C "$INSTALL_DIR"
printf '%s  %s\n' \
  "$CLI_BINARY_SHA256" "$INSTALL_DIR/bin/best-agent" \
  "$CLI_NODE_SHA256" "$INSTALL_DIR/runtime/bin/node" \
  "$CLI_RUNTIME_LOCK_SHA256" "$INSTALL_DIR/package-lock.json" | sha256sum --check
test "$("$INSTALL_DIR/runtime/bin/node" --version)" = "$CLI_NODE_VERSION"
