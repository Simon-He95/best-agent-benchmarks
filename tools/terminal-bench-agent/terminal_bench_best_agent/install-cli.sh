#!/usr/bin/env bash
# Installs the pinned best-agent CLI tarball into the task container.
#
# Environment contract (set by the harbor plugin before exec):
#   CLI_PACKAGE          npm package name, e.g. @best-agent/cli-linux-x64-gnu
#   CLI_VERSION          pinned version, e.g. 0.0.3-beta.1
#   CLI_INTEGRITY_B64    base64 sha512 of the tarball (npm dist.integrity body)
#   CLI_REGISTRY         registry base URL for the CLI tarball
#   CLI_RUNTIME_DEPS     space-separated "name@version" runtime dependencies
#   NPM_REGISTRY         registry used for the runtime deps
#   NODE_MIRROR          nodejs.org mirror used by nvm (e.g. npmmirror)
#
# The CLI tarball is a Node single-executable-app (SEA); its externalized
# runtime deps must sit in node_modules next to the extracted package, which is
# where Node's resolution walks up from the executable. node/npm are only
# needed once, at install time.

set -euo pipefail

CLI_PACKAGE="${CLI_PACKAGE:?CLI_PACKAGE is required}"
CLI_VERSION="${CLI_VERSION:?CLI_VERSION is required}"
CLI_INTEGRITY_B64="${CLI_INTEGRITY_B64:?CLI_INTEGRITY_B64 is required}"
CLI_REGISTRY="${CLI_REGISTRY:-https://registry.npmjs.org}"
CLI_RUNTIME_DEPS="${CLI_RUNTIME_DEPS:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
NODE_MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"

MARKER="${HOME}/.best-agent-cli/.cli-installed-${CLI_VERSION}"

if [ -f "${MARKER}" ] && command -v best-agent >/dev/null 2>&1; then
  echo "best-agent ${CLI_VERSION} already installed"
  exit 0
fi

# Registry URL for a scoped package: @scope/name -> @scope%2fname.
ESCAPED_PACKAGE="${CLI_PACKAGE/\//%2f}"
TARBALL_URL="${CLI_REGISTRY%/}/${ESCAPED_PACKAGE}/-/${CLI_PACKAGE##*/}-${CLI_VERSION}.tgz"

INSTALL_DIR="$HOME/.best-agent-cli"
mkdir -p "${INSTALL_DIR}"
rm -f "${INSTALL_DIR}/cli.tgz"

for attempt in 1 2 3 4 5; do
  if curl -fsSL -C - -o "${INSTALL_DIR}/cli.tgz" "${TARBALL_URL}"; then
    echo "download ok on attempt ${attempt}"
    break
  fi
  echo "download attempt ${attempt} failed rc=$?"
  sleep 3
done

if [ ! -f "${INSTALL_DIR}/cli.tgz" ]; then
  echo "cli.tgz download failed after 5 attempts" >&2
  exit 1
fi
stat -c "cli.tgz bytes=%s" "${INSTALL_DIR}/cli.tgz"

GOT="$(openssl dgst -sha512 -binary "${INSTALL_DIR}/cli.tgz" | base64 -w0)"
if [ "${GOT}" != "${CLI_INTEGRITY_B64}" ]; then
  echo "cli.tgz sha512 mismatch: ${GOT}" >&2
  exit 1
fi
echo "cli.tgz sha512 verified"

tar xzf "${INSTALL_DIR}/cli.tgz" -C "${INSTALL_DIR}" --strip-components=1
chmod +x "${INSTALL_DIR}/bin/best-agent"
BIN="$(readlink -f "${INSTALL_DIR}/bin/best-agent")"
ln -sf "${BIN}" /usr/local/bin/best-agent

# Runtime deps for the SEA (see config/terminal-bench.json cli.runtimeDependencies).
if [ -n "${CLI_RUNTIME_DEPS}" ]; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "${NVM_DIR}/nvm.sh" ]; then
      for attempt in 1 2 3; do
        if curl -fsSL -o "${NVM_DIR}-install.sh" \
          https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh; then
          bash "${NVM_DIR}-install.sh"
          break
        fi
        echo "nvm installer attempt ${attempt} failed rc=$?"
        sleep 3
      done
    fi
    # shellcheck disable=SC1091
    . "${NVM_DIR}/nvm.sh"
    NODE_INSTALLED=0
    # Try the configured mirror first, then the CN mirror, then nodejs.org.
    for mirror in "${NODE_MIRROR}" https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
      for attempt in 1 2 3; do
        if NVM_NODEJS_ORG_MIRROR="${mirror}" nvm install 22 >/dev/null 2>&1; then
          NODE_INSTALLED=1
          break
        fi
        echo "node install attempt ${attempt} on ${mirror} failed"
        sleep 3
      done
      if [ "${NODE_INSTALLED}" -eq 1 ]; then
        break
      fi
    done
    if [ "${NODE_INSTALLED}" -ne 1 ]; then
      echo "node 22 could not be installed from any mirror" >&2
      exit 1
    fi
    nvm alias default 22 >/dev/null 2>&1 || true
  fi
  for dep in ${CLI_RUNTIME_DEPS}; do
    echo "installing runtime dep ${dep}"
    npm install --prefix "${INSTALL_DIR}" --no-audit --no-fund --loglevel=error \
      --registry "${NPM_REGISTRY}" "${dep}"
  done
fi

# The CLI's --version/--help print usage and exit non-zero by design, so
# verify by output content instead of exit code: a started SEA prints its
# usage banner; a broken one dies with "Cannot find module".
START_OUTPUT="$(best-agent --version 2>&1 || true)"
if ! printf '%s' "${START_OUTPUT}" | grep -q "Usage: best-agent"; then
  echo "best-agent failed to start after installation" >&2
  printf '%s\n' "${START_OUTPUT}" | tail -5 >&2
  exit 1
fi
echo "best-agent ${CLI_VERSION} ready"
touch "${MARKER}"
best-agent --version 2>&1 || true