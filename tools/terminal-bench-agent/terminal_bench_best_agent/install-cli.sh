#!/usr/bin/env bash

set -euo pipefail

CLI_TARBALL="${CLI_TARBALL:?CLI_TARBALL is required}"
CLI_TARBALL_SHA256="${CLI_TARBALL_SHA256:?CLI_TARBALL_SHA256 is required}"
CLI_BINARY_SHA256="${CLI_BINARY_SHA256:?CLI_BINARY_SHA256 is required}"
CLI_RUNTIME_LOCK_SHA256="${CLI_RUNTIME_LOCK_SHA256:?CLI_RUNTIME_LOCK_SHA256 is required}"
CLI_VERSION="${CLI_VERSION:?CLI_VERSION is required}"

INSTALL_DIR="$HOME/.best-agent-cli"
MARKER="$INSTALL_DIR/.cli-installed-$CLI_VERSION-$CLI_BINARY_SHA256"

if [ -f "$MARKER" ] && [ -x "$INSTALL_DIR/bin/best-agent" ]; then
  exit 0
fi

test "$(sha256sum "$CLI_TARBALL" | cut -d' ' -f1)" = "$CLI_TARBALL_SHA256"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar xzf "$CLI_TARBALL" -C "$INSTALL_DIR" --strip-components=1
chmod +x "$INSTALL_DIR/bin/best-agent"
test "$(sha256sum "$INSTALL_DIR/bin/best-agent" | cut -d' ' -f1)" = "$CLI_BINARY_SHA256"
test "$(sha256sum "$INSTALL_DIR/package-lock.json" | cut -d' ' -f1)" = "$CLI_RUNTIME_LOCK_SHA256"

touch "$MARKER"
