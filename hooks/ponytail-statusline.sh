#!/usr/bin/env bash
# CLAUDE_CONFIG_DIR overrides ~/.claude, matching where the hooks write the flag (issue #34)
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
flag="$dir/.ponytail-active"
# Claude Code hands the statusline its session as JSON on stdin; that session's own
# level wins over the shared flag, which shows whichever session switched last.
if [ ! -t 0 ]; then
    id=$(tr -d '\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p')
    [ -n "$id" ] && [ -f "$dir/ponytail-modes/session/$id" ] && flag="$dir/ponytail-modes/session/$id"
fi
[ -f "$flag" ] || exit 0

mode=$(head -n1 "$flag" | tr -d '[:space:]')
[ "$mode" = "off" ] && exit 0

# ultra is the high-intensity mode; flag it amber so it stands out from the
# default green at a glance. The level is still in the text, so color is a
# redundant cue, not the only one.
color=108
[ "$mode" = "ultra" ] && color=173

if [ -z "$mode" ] || [ "$mode" = "full" ]; then
    printf '\033[38;5;%sm[PONYTAIL]\033[0m' "$color"
else
    printf '\033[38;5;%sm[PONYTAIL:%s]\033[0m' "$color" "$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')"
fi
