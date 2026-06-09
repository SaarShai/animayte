#!/usr/bin/env bash
# skill-pulse self-test. Exits 0 only if every assertion passes.
set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="bash $TOOLS_DIR/hook.sh"
STATE_ROOT="$(mktemp -d -t sp-test-XXXX)"
SKILLS_ROOT="$(mktemp -d -t sp-skills-XXXX)"
trap 'rm -rf "$STATE_ROOT" "$SKILLS_ROOT"' EXIT

PASS=0
FAIL=0
declare -a FAIL_NAMES

ok() { echo "  [PASS] $1"; PASS=$((PASS+1)); }
no() { echo "  [FAIL] $1${2:+  | $2}"; FAIL=$((FAIL+1)); FAIL_NAMES+=("$1"); }

# Helpers
make_skill() {
  # make_skill <subdir> <name> <pulse_reminder OR empty> <description>
  local sk_root="$1" name="$2" reminder="$3" desc="$4"
  mkdir -p "$sk_root/$name"
  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    [ -n "$reminder" ] && echo "pulse_reminder: $reminder"
    echo "---"
    echo "# $name"
  } > "$sk_root/$name/SKILL.md"
}

call() {
  # call <state-subdir> <skills-subdir-or-empty> <env-overrides...> -- <session_id>
  local state_sub="$1"; shift
  local skills_sub="$1"; shift
  local env_overrides=()
  while [ "$1" != "--" ]; do env_overrides+=("$1"); shift; done
  shift
  local sid="$1"
  local payload="{\"session_id\":\"$sid\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"hello\"}"
  local env_args=(LOOP_BREAKER_DISABLED=1
                  SKILL_PULSE_STATE_DIR="$STATE_ROOT/$state_sub"
                  SKILL_PULSE_SKILLS_ROOT="$SKILLS_ROOT/$skills_sub")
  if [ ${#env_overrides[@]} -gt 0 ]; then
    printf '%s' "$payload" | env "${env_args[@]}" "${env_overrides[@]}" $HOOK
  else
    printf '%s' "$payload" | env "${env_args[@]}" $HOOK
  fi
}

emitted() {
  [ -n "$1" ] && echo "$1" | grep -q '<system-reminder>'
}

# -----------------------------------------------------------------------------
echo "[1] Cadence default=4: silent on turns 1-3, pulse on turn 4"
make_skill "$SKILLS_ROOT/sk1" "cv" "be terse" "Terse style."
for t in 1 2 3; do
  out=$(call sp1 sk1 -- s1)
  if [ -n "$out" ]; then no "turn $t silent (default cadence)" "got: $(echo "$out" | head -c80)"; break; fi
done
[ -z "$out" ] && ok "turns 1-3 silent"
out=$(call sp1 sk1 -- s1)
if emitted "$out"; then ok "turn 4 emits pulse"; else no "turn 4 emits pulse" "got empty"; fi
if echo "$out" | grep -q "cv: be terse"; then ok "pulse includes skill rule"; else no "pulse includes skill rule"; fi

# -----------------------------------------------------------------------------
echo "[2] Cadence repeats: pulse on turn 8, 12 — silent in between"
SUB=sp2
out=$(call $SUB sk1 -- s2)  # turn 1 (cold)
for _ in 2 3 4; do out=$(call $SUB sk1 -- s2); done  # turn 4 emits
silent_block=1
for _ in 5 6 7; do
  out=$(call $SUB sk1 -- s2)
  [ -n "$out" ] && silent_block=0
done
out=$(call $SUB sk1 -- s2)  # turn 8
if [ $silent_block -eq 1 ]; then ok "turns 5-7 silent"; else no "turns 5-7 silent"; fi
if emitted "$out"; then ok "turn 8 emits second pulse"; else no "turn 8 emits second pulse"; fi

# -----------------------------------------------------------------------------
echo "[3] SKILL_PULSE_EVERY=2 fires more often"
SUB=sp3
out=$(call $SUB sk1 SKILL_PULSE_EVERY=2 -- s3)  # turn 1 silent
if [ -n "$out" ]; then no "turn 1 silent w/ EVERY=2" "got: $(echo "$out" | head -c80)"; fi
out=$(call $SUB sk1 SKILL_PULSE_EVERY=2 -- s3)  # turn 2 → pulse
if emitted "$out"; then ok "EVERY=2 fires on turn 2"; else no "EVERY=2 fires on turn 2"; fi

# -----------------------------------------------------------------------------
echo "[4] Cadence clamps below 2 to floor=2"
SUB=sp4
out=$(call $SUB sk1 SKILL_PULSE_EVERY=1 -- s4)  # turn 1
if [ -z "$out" ]; then ok "EVERY=1 clamped: turn 1 silent"; else no "EVERY=1 clamped: turn 1 silent" "got: $(echo "$out" | head -c80)"; fi
out=$(call $SUB sk1 SKILL_PULSE_EVERY=1 -- s4)  # turn 2
if emitted "$out"; then ok "EVERY=1 clamped: turn 2 emits (as if EVERY=2)"; else no "EVERY=1 clamped: turn 2 emits"; fi

# -----------------------------------------------------------------------------
echo "[5] SKILL_PULSE_DISABLED=1 never fires"
SUB=sp5
silent=1
for _ in 1 2 3 4 5 6 7 8 9 10; do
  out=$(call $SUB sk1 SKILL_PULSE_DISABLED=1 -- s5)
  [ -n "$out" ] && silent=0
done
if [ $silent -eq 1 ]; then ok "10 turns all silent when DISABLED=1"; else no "DISABLED=1 silences pulse"; fi

# -----------------------------------------------------------------------------
echo "[6] Skill with NO pulse_reminder is excluded by default"
make_skill "$SKILLS_ROOT/sk6" "passive" "" "A passive skill with no pulse rule."
SUB=sp6
for _ in 1 2 3 4; do out=$(call $SUB sk6 -- s6); done
if emitted "$out"; then no "pulse fired despite no opted-in skill" "got: $(echo "$out" | head -c80)"; else ok "no opted-in skill → no pulse"; fi

# -----------------------------------------------------------------------------
echo "[7] SKILL_PULSE_SKILLS allowlist forces inclusion w/ description fallback"
SUB=sp7
for _ in 1 2 3 4; do out=$(call $SUB sk6 SKILL_PULSE_SKILLS=passive -- s7); done
if emitted "$out" && echo "$out" | grep -q "passive: A passive skill"; then
  ok "allowlist includes skill + uses description fallback"
else
  no "allowlist + description fallback" "got: $(echo "$out" | head -c150)"
fi

# -----------------------------------------------------------------------------
echo "[8] Multiple skills with pulse_reminder all appear"
make_skill "$SKILLS_ROOT/sk8" "alpha" "rule A" "Alpha skill."
make_skill "$SKILLS_ROOT/sk8" "beta" "rule B" "Beta skill."
make_skill "$SKILLS_ROOT/sk8" "gamma" "" "Passive, no pulse."
SUB=sp8
for _ in 1 2 3 4; do out=$(call $SUB sk8 -- s8); done
has_a=$(echo "$out" | grep -c "alpha: rule A" || true)
has_b=$(echo "$out" | grep -c "beta: rule B" || true)
has_g=$(echo "$out" | grep -c "gamma:" || true)
if [ "$has_a" = "1" ] && [ "$has_b" = "1" ] && [ "$has_g" = "0" ]; then
  ok "alpha + beta present, gamma absent"
else
  no "alpha + beta present, gamma absent" "alpha=$has_a beta=$has_b gamma=$has_g"
fi

# -----------------------------------------------------------------------------
echo "[9] Dedup by name field across multiple skill dirs"
make_skill "$SKILLS_ROOT/sk9" "dup" "first" "first copy"
mkdir -p "$SKILLS_ROOT/sk9/dup-alias"
{ echo "---"; echo "name: dup"; echo "pulse_reminder: second"; echo "---"; } > "$SKILLS_ROOT/sk9/dup-alias/SKILL.md"
SUB=sp9
for _ in 1 2 3 4; do out=$(call $SUB sk9 -- s9); done
dup_count=$(echo "$out" | grep -c "dup:" || true)
if [ "$dup_count" = "1" ]; then ok "dedup by name: only one 'dup:' line"; else no "dedup" "got $dup_count"; fi

# -----------------------------------------------------------------------------
echo "[10] No .claude/skills dir → silent (graceful)"
SUB=sp10
NONEXISTENT="$SKILLS_ROOT/sk-DOES-NOT-EXIST"
out=$(printf '%s' '{"session_id":"s10","hook_event_name":"UserPromptSubmit","prompt":"x"}' \
  | env SKILL_PULSE_STATE_DIR="$STATE_ROOT/$SUB" SKILL_PULSE_SKILLS_ROOT="$NONEXISTENT" $HOOK)
# Run turn 4
for _ in 2 3 4; do
  out=$(printf '%s' '{"session_id":"s10","hook_event_name":"UserPromptSubmit","prompt":"x"}' \
    | env SKILL_PULSE_STATE_DIR="$STATE_ROOT/$SUB" SKILL_PULSE_SKILLS_ROOT="$NONEXISTENT" $HOOK)
done
if [ -z "$out" ]; then ok "missing skills dir → silent at turn 4"; else no "missing skills dir → silent" "got: $(echo "$out" | head -c80)"; fi

# -----------------------------------------------------------------------------
echo "[11] Empty / malformed stdin → exit 0"
out=$(printf '' | $HOOK); ec=$?
if [ $ec -eq 0 ]; then ok "empty stdin exit 0"; else no "empty stdin exit 0" "got $ec"; fi
out=$(printf 'not json' | $HOOK 2>/dev/null); ec=$?
if [ $ec -eq 0 ]; then ok "malformed stdin exit 0"; else no "malformed stdin exit 0" "got $ec"; fi

# -----------------------------------------------------------------------------
echo "[12] Corrupt state file → recover"
SUB=sp12
mkdir -p "$STATE_ROOT/$SUB"
# hook.py names state files by SHA-256(session_id)[:16].json, not the raw id
sid_hash=$(python3 -c "import hashlib;print(hashlib.sha256('s12'.encode('utf-8',errors='replace')).hexdigest()[:16])")
echo 'not { json' > "$STATE_ROOT/$SUB/$sid_hash.json"
out=$(call $SUB sk1 -- s12)
ec=$?
if [ $ec -eq 0 ]; then ok "corrupt state → exit 0"; else no "corrupt state → exit 0" "got $ec"; fi
if python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$STATE_ROOT/$SUB/$sid_hash.json" 2>/dev/null; then
  ok "state file recovered to valid JSON"
else
  no "state file recovered to valid JSON"
fi

# -----------------------------------------------------------------------------
echo "[13] Two sessions interleaved → independent turn counts"
SUB=sp13
# alpha turns 1-3, beta turns 1-3, alpha turn 4 → alpha should pulse, beta still at 3
for _ in 1 2 3; do call $SUB sk1 -- alpha-session >/dev/null; done
for _ in 1 2 3; do call $SUB sk1 -- beta-session  >/dev/null; done
out_a=$(call $SUB sk1 -- alpha-session)
out_b=$(call $SUB sk1 -- beta-session)
if emitted "$out_a"; then ok "alpha pulses at its own turn 4"; else no "alpha pulses at its own turn 4"; fi
# beta should now be at turn 4 too (3+1) — also pulse
if emitted "$out_b"; then ok "beta pulses at its own turn 4 (independent counter)"; else no "beta pulses at its own turn 4"; fi

# -----------------------------------------------------------------------------
echo "[14] State GC at session-start: 8-day-old files purged, fresh kept"
SUB=sp14
mkdir -p "$STATE_ROOT/$SUB"
for old in old1 old2 old3; do
  echo '{"turn_count":1}' > "$STATE_ROOT/$SUB/$old.json"
  python3 -c "import os,time;os.utime('$STATE_ROOT/$SUB/$old.json', (time.time()-8*86400, time.time()-8*86400))"
done
echo '{"turn_count":1}' > "$STATE_ROOT/$SUB/keep.json"
# Trigger session-start by using a new session_id ("brand-new")
out=$(call $SUB sk1 -- brand-new)
old_count=$(ls "$STATE_ROOT/$SUB"/{old1,old2,old3}.json 2>/dev/null | wc -l | tr -d ' ')
fresh_count=$(ls "$STATE_ROOT/$SUB"/keep.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$old_count" = "0" ]; then ok "stale files purged"; else no "stale files purged" "still: $old_count"; fi
if [ "$fresh_count" = "1" ]; then ok "fresh file kept"; else no "fresh file kept"; fi

# -----------------------------------------------------------------------------
echo "[15] Concurrent invocations → flock-safe"
SUB=sp15
mkdir -p "$STATE_ROOT/$SUB"
# Fire 10 parallel
PAYLOAD='{"session_id":"concur","hook_event_name":"UserPromptSubmit","prompt":"x"}'
for _ in 1 2 3 4 5 6 7 8 9 10; do
  printf '%s' "$PAYLOAD" | env SKILL_PULSE_STATE_DIR="$STATE_ROOT/$SUB" SKILL_PULSE_SKILLS_ROOT="$SKILLS_ROOT/sk1" $HOOK > /dev/null &
done
wait
# hook.py names state files by SHA-256(session_id)[:16].json, not the raw id
sid_hash=$(python3 -c "import hashlib;print(hashlib.sha256('concur'.encode('utf-8',errors='replace')).hexdigest()[:16])")
turn_after=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["turn_count"])' "$STATE_ROOT/$SUB/$sid_hash.json")
if [ "$turn_after" = "10" ]; then ok "10 parallel hooks → turn_count=10"; else no "10 parallel hooks → turn_count=10" "got $turn_after"; fi

# -----------------------------------------------------------------------------
echo "[16] Skill cap: MAX_SKILLS_IN_PULSE=8 (output truncated when more)"
mkdir -p "$SKILLS_ROOT/sk16"
for n in s00 s01 s02 s03 s04 s05 s06 s07 s08 s09; do
  make_skill "$SKILLS_ROOT/sk16" "$n" "rule-$n" "Description for $n."
done
SUB=sp16
for _ in 1 2 3 4; do out=$(call $SUB sk16 -- s16); done
count=$(echo "$out" | grep -c '^- ' || true)
if [ "$count" = "8" ]; then ok "exactly 8 skills in pulse despite 10 available"; else no "skill cap" "got $count"; fi

# -----------------------------------------------------------------------------
echo
if [ $FAIL -eq 0 ]; then
  echo "skill-pulse test.sh: $PASS/$((PASS+FAIL)) PASS"
  exit 0
else
  echo "skill-pulse test.sh: $PASS/$((PASS+FAIL)) — failures:"
  for n in "${FAIL_NAMES[@]}"; do echo "  - $n"; done
  exit 1
fi
