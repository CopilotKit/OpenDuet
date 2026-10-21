#!/usr/bin/env bash
#
# Start OpenDuet. The platform underneath is OpenBot, in openbot/; this runs its start script with
# this repository's .env. See scripts/env.sh for where that file lives.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/env.sh
link_env
if [ ! -d openbot/node_modules ]; then
  bun install --cwd openbot
fi
exec bash openbot/scripts/start.sh "$@"
