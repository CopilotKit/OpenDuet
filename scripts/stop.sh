#!/usr/bin/env bash
#
# Stop OpenDuet: the app, the worker, the API server, the Docker services and this install's Bot
# computers (the ones with its COMPUTER_NAMESPACE, never another install's). The database, the files
# and the browser profiles are Docker volumes, so no data is deleted. Passes its arguments to
# openbot/scripts/stop.sh (for example --keep-computers).
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash openbot/scripts/stop.sh "$@"
