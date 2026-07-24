#!/bin/sh
# Convenience wrapper around `npm install -g @heapcode/cli` — not a
# replacement packaging mechanism. Never installs or modifies Node/npm
# itself, never re-execs with sudo: a missing/too-old Node, or an npm global
# prefix that needs elevated permissions, is surfaced to the user to fix
# themselves rather than silently worked around.
#
#   curl -fsSL https://raw.githubusercontent.com/heaplabshq/heapcode/main/packages/cli/install.sh | sh
#
set -eu

MIN_NODE_MAJOR=20

if ! command -v node >/dev/null 2>&1; then
  echo "heapcode requires Node.js >= ${MIN_NODE_MAJOR}, but no 'node' was found on PATH." >&2
  echo "Install it from https://nodejs.org (or via nvm/fnm/volta) and re-run this script." >&2
  exit 1
fi

node_major=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  echo "heapcode requires Node.js >= ${MIN_NODE_MAJOR}; found $(node -v)." >&2
  echo "Upgrade Node (nodejs.org, or nvm/fnm/volta) and re-run this script." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found on PATH (usually ships with Node.js) — install it and re-run this script." >&2
  exit 1
fi

echo "Installing @heapcode/cli..."
if ! npm install -g @heapcode/cli; then
  echo "" >&2
  echo "npm install -g failed — this is often a permissions issue with npm's global" >&2
  echo "install location, not a problem with heapcode itself. Common fixes:" >&2
  echo "  - use a Node version manager (nvm/fnm/volta) so global installs don't need sudo" >&2
  echo "  - or reconfigure npm's global prefix: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally" >&2
  echo "This script deliberately does not retry with sudo." >&2
  exit 1
fi

echo ""
echo "Installed. Run 'heapcode' to get started."
