#!/usr/bin/env bash
set -euo pipefail

# Generic output filter with raw-output recovery and savings metrics.
# Use as a pipe:
#   noisy-command | TOKEN_ECONOMY_ROOT="$PWD" bash filter.sh
#
# CLI subcommands (filter is the default):
#   filter [--rules path] [--session-aware]   filter stdin -> stdout
#   stats                                      print per-session savings
#   rewind [id]                                restore raw output
#   rules --init                               write a default rules file

ROOT="${TOKEN_ECONOMY_ROOT:-$(pwd)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
python3 "$HERE/output_filter.py" --repo "$ROOT" "${@:-filter}"
