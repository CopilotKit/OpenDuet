#!/usr/bin/env bash
#
# Stop OpenDuet: the app, the worker, the API server, the Docker services and each Bot's computer.
# Deletes nothing. Passes its arguments to openbot/scripts/stop.sh (for example --keep-computers).
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash openbot/scripts/stop.sh "$@"
