#!/usr/bin/env bash
# compliance-canary self-test.
set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="bash $TOOLS_DIR/hook.sh"
STATE_ROOT="$(mktemp -d -t cc-test-XXXX)"
SKILLS_ROOT="$(mktemp -d -t cc-skills-XXXX)"
TRANSCRIPT_DIR="$(mktemp -d -t cc-tx-XXXX)"
trap 'rm -rf "$STATE_ROOT" "$SKILLS_ROOT" "$TRANSCRIPT_DIR"' EXIT

PASS=0; FAIL=0
declare -a FAIL_NAMES
ok() { echo "  [PASS] $1"; PASS=$((PASS+1)); }
no() { echo "  [FAIL] $1${2:+  | $2}"; FAIL=$((FAIL+1)); FAIL_NAMES+=("$1"); }

# Helpers ---------------------------------------------------------------

make_skill_with_probes() {
  # make_skill_with_probes <skills_subdir> <skill_name> <probes_json>
  local sk_root="$SKILLS_ROOT/$1"
  local name="$2"
  local probes="$3"
  mkdir -p "$sk_root/$name"
  cat > "$sk_root/$name/drift_probes.json" <<EOF
$probes
EOF
}

write_transcript() {
  # write_transcript <file> <jsonl-body>
  local file="$1"; shift
  printf '%s\n' "$@" > "$file"
}

assistant_text() {
  # emit one JSONL line for an assistant message with text content
  python3 -c "
import json,sys
text=sys.argv[1]
uuid=sys.argv[2]
print(json.dumps({'type':'assistant','uuid':uuid,
                  'message':{'role':'assistant','content':[{'type':'text','text':text}]}}))
" "$1" "$2"
}

assistant_tool_use() {
  # emit one JSONL line for an assistant tool_use
  python3 -c "
import json,sys
name=sys.argv[1]; inp=json.loads(sys.argv[2])
print(json.dumps({'type':'assistant',
                  'message':{'role':'assistant','content':[{'type':'tool_use','name':name,'input':inp}]}}))
" "$1" "$2"
}

call() {
  # call <state_sub> <skills_sub> <transcript_file> <session_id> [env_overrides...]
  local state_sub="$1" skills_sub="$2" tx="$3" sid="$4"; shift 4
  local payload
  payload=$(python3 -c "
import json,sys
print(json.dumps({'session_id':sys.argv[1],'transcript_path':sys.argv[2],'hook_event_name':'UserPromptSubmit','prompt':'next'}))
" "$sid" "$tx")
  local env_args=(COMPLIANCE_CANARY_STATE_DIR="$STATE_ROOT/$state_sub"
                  COMPLIANCE_CANARY_SKILLS_ROOT="$SKILLS_ROOT/$skills_sub")
  if [ "$#" -gt 0 ]; then
    printf '%s' "$payload" | env "${env_args[@]}" "$@" $HOOK
  else
    printf '%s' "$payload" | env "${env_args[@]}" $HOOK
  fi
}

emitted() {
  [ -n "$1" ] && echo "$1" | grep -q '<system-reminder>'
}

# Tests -----------------------------------------------------------------

echo "[1] forbidden_regex fires when filler phrase present"
PROBES='[{"id":"filler","kind":"forbidden_regex","pattern":"(?i)\\bcertainly\\b","message":"no certainly"}]'
make_skill_with_probes sk1 cv "$PROBES"
TX="$TRANSCRIPT_DIR/t1.jsonl"
write_transcript "$TX" "$(assistant_text 'Certainly! I will do that right away.' u1)"
out=$(call cc1 sk1 "$TX" s1)
if emitted "$out" && echo "$out" | grep -q 'forbidden_regex'; then ok "filler regex fires"; else no "filler regex fires" "got: $(echo "$out" | head -c120)"; fi

echo "[2] forbidden_regex stays silent when phrase absent"
TX="$TRANSCRIPT_DIR/t2.jsonl"
write_transcript "$TX" "$(assistant_text 'Hash signature mismatch on call 5. Trying ls -la.' u2)"
out=$(call cc2 sk1 "$TX" s2)
if [ -z "$out" ]; then ok "no filler → silent"; else no "no filler → silent" "got: $(echo "$out" | head -c80)"; fi

echo "[3] word_count_per_message: avg over threshold fires"
PROBES='[{"id":"creep","kind":"word_count_per_message","threshold":15,"window":3}]'
make_skill_with_probes sk3 cv "$PROBES"
LONG="this is a quite long message intended to push the average word count above the threshold set in the probe"
TX="$TRANSCRIPT_DIR/t3.jsonl"
write_transcript "$TX" \
  "$(assistant_text "$LONG" u1)" \
  "$(assistant_text "$LONG also more words" u2)" \
  "$(assistant_text "$LONG plus extra padding text here" u3)"
out=$(call cc3 sk3 "$TX" s3)
if emitted "$out" && echo "$out" | grep -q 'word_count_per_message'; then ok "word-count probe fires"; else no "word-count probe fires"; fi

echo "[4] word_count_per_message: short messages → silent"
TX="$TRANSCRIPT_DIR/t4.jsonl"
write_transcript "$TX" \
  "$(assistant_text 'ok' u1)" \
  "$(assistant_text 'done' u2)" \
  "$(assistant_text 'next' u3)"
out=$(call cc4 sk3 "$TX" s4)
if [ -z "$out" ]; then ok "short msgs → silent"; else no "short msgs → silent" "got: $(echo "$out" | head -c80)"; fi

echo "[5] claim_without_evidence: claim present, no recent verify tool → fires"
PROBES='[{"id":"unverified","kind":"claim_without_evidence","claim_pattern":"(?i)\\b(done|fixed)\\b","verify_tools":["Bash"],"verify_keywords":["test","make","build"]}]'
make_skill_with_probes sk5 vbc "$PROBES"
TX="$TRANSCRIPT_DIR/t5.jsonl"
# Last assistant message contains "done" — but no Bash tool_use with verify keyword
write_transcript "$TX" \
  "$(assistant_tool_use Edit '{"file_path":"/x","old_string":"a","new_string":"b"}')" \
  "$(assistant_text 'all done!' u1)"
out=$(call cc5 sk5 "$TX" s5)
if emitted "$out" && echo "$out" | grep -q 'claim_without_evidence'; then ok "unverified-done fires"; else no "unverified-done fires" "got: $(echo "$out" | head -c200)"; fi

echo "[6] claim_without_evidence: verify tool_use present → silent"
TX="$TRANSCRIPT_DIR/t6.jsonl"
write_transcript "$TX" \
  "$(assistant_tool_use Bash '{"command":"npm test"}')" \
  "$(assistant_text 'all done!' u1)"
out=$(call cc6 sk5 "$TX" s6)
if [ -z "$out" ]; then ok "verified-done → silent"; else no "verified-done → silent" "got: $(echo "$out" | head -c200)"; fi

echo "[7] cooldown: same probe fires once, suppressed on consecutive turns"
PROBES='[{"id":"filler","kind":"forbidden_regex","pattern":"(?i)\\bcertainly\\b"}]'
make_skill_with_probes sk7 cv "$PROBES"
TX="$TRANSCRIPT_DIR/t7.jsonl"
write_transcript "$TX" "$(assistant_text 'Certainly!' u1)"
out1=$(call cc7 sk7 "$TX" s7)
out2=$(call cc7 sk7 "$TX" s7)
out3=$(call cc7 sk7 "$TX" s7)
if emitted "$out1" && ! emitted "$out2" && ! emitted "$out3"; then
  ok "fires on turn 1, suppressed on 2 + 3 (cooldown=3)"
else
  no "cooldown behaviour" "t1=$(emitted "$out1" && echo y || echo n) t2=$(emitted "$out2" && echo y || echo n) t3=$(emitted "$out3" && echo y || echo n)"
fi

echo "[8] cooldown expires: 4th turn fires again"
out4=$(call cc7 sk7 "$TX" s7)
if emitted "$out4"; then ok "fires again on turn 4 (cooldown expired)"; else no "fires again on turn 4"; fi

echo "[9] COMPLIANCE_CANARY_COOLDOWN=0 → no suppression"
make_skill_with_probes sk9 cv "$PROBES"
TX="$TRANSCRIPT_DIR/t9.jsonl"
write_transcript "$TX" "$(assistant_text 'Certainly again' u1)"
out_a=$(call cc9 sk9 "$TX" s9 COMPLIANCE_CANARY_COOLDOWN=0)
out_b=$(call cc9 sk9 "$TX" s9 COMPLIANCE_CANARY_COOLDOWN=0)
if emitted "$out_a" && emitted "$out_b"; then ok "cooldown=0 → fires every turn"; else no "cooldown=0 → fires every turn"; fi

echo "[10] COMPLIANCE_CANARY_DISABLED=1 → never fires"
TX="$TRANSCRIPT_DIR/t10.jsonl"
write_transcript "$TX" "$(assistant_text 'Certainly!' u1)"
out=$(call cc10 sk1 "$TX" s10 COMPLIANCE_CANARY_DISABLED=1)
if [ -z "$out" ]; then ok "DISABLED=1 silences"; else no "DISABLED=1 silences"; fi

echo "[11] No drift_probes.json files → silent"
mkdir -p "$SKILLS_ROOT/empty"
out=$(call cc11 empty "$TX" s11)
if [ -z "$out" ]; then ok "no probes → silent"; else no "no probes → silent" "got: $(echo "$out" | head -c80)"; fi

echo "[12] Malformed drift_probes.json → skipped, hook proceeds"
mkdir -p "$SKILLS_ROOT/sk12/bad" "$SKILLS_ROOT/sk12/good"
echo 'not json {' > "$SKILLS_ROOT/sk12/bad/drift_probes.json"
echo '[{"id":"filler","kind":"forbidden_regex","pattern":"(?i)certainly"}]' > "$SKILLS_ROOT/sk12/good/drift_probes.json"
TX="$TRANSCRIPT_DIR/t12.jsonl"
write_transcript "$TX" "$(assistant_text 'certainly!' u1)"
out=$(call cc12 sk12 "$TX" s12)
if emitted "$out" && echo "$out" | grep -q 'good'; then ok "good probe still fires despite malformed sibling"; else no "good probe fires" "got: $(echo "$out" | head -c200)"; fi

echo "[13] Empty transcript → silent"
TX="$TRANSCRIPT_DIR/t13.jsonl"
: > "$TX"
out=$(call cc13 sk1 "$TX" s13)
if [ -z "$out" ]; then ok "empty transcript → silent"; else no "empty transcript → silent"; fi

echo "[14] Missing transcript file → silent (graceful)"
out=$(call cc14 sk1 "$TRANSCRIPT_DIR/does-not-exist.jsonl" s14)
if [ -z "$out" ]; then ok "missing transcript → silent"; else no "missing transcript → silent"; fi

echo "[15] Empty / malformed stdin → exit 0"
out=$(printf '' | $HOOK); ec=$?
if [ $ec -eq 0 ]; then ok "empty stdin exit 0"; else no "empty stdin exit 0"; fi
out=$(printf 'garbage' | $HOOK 2>/dev/null); ec=$?
if [ $ec -eq 0 ]; then ok "malformed stdin exit 0"; else no "malformed stdin exit 0"; fi

echo "[16] Two sessions: independent probe_history"
PROBES='[{"id":"filler","kind":"forbidden_regex","pattern":"(?i)\\bcertainly\\b"}]'
make_skill_with_probes sk16 cv "$PROBES"
TX_A="$TRANSCRIPT_DIR/t16a.jsonl"
TX_B="$TRANSCRIPT_DIR/t16b.jsonl"
write_transcript "$TX_A" "$(assistant_text 'Certainly A' u1)"
write_transcript "$TX_B" "$(assistant_text 'Certainly B' u1)"
out_a=$(call cc16 sk16 "$TX_A" sess-alpha)  # fires
out_a2=$(call cc16 sk16 "$TX_A" sess-alpha) # suppressed
out_b=$(call cc16 sk16 "$TX_B" sess-beta)   # fires (different session)
if emitted "$out_a" && ! emitted "$out_a2" && emitted "$out_b"; then
  ok "two sessions independent"
else
  no "two sessions independent" "a1=$(emitted "$out_a" && echo y || echo n) a2=$(emitted "$out_a2" && echo y || echo n) b=$(emitted "$out_b" && echo y || echo n)"
fi

echo "[17] Concurrent invocations → flock-safe (10 parallel)"
make_skill_with_probes sk17 cv '[]'  # no probes, just exercising state lock
mkdir -p "$STATE_ROOT/cc17"
TX="$TRANSCRIPT_DIR/t17.jsonl"
write_transcript "$TX" "$(assistant_text 'x' u1)"
PAYLOAD=$(python3 -c "
import json,sys
print(json.dumps({'session_id':'cc-concur','transcript_path':sys.argv[1],'hook_event_name':'UserPromptSubmit','prompt':'x'}))
" "$TX")
for _ in 1 2 3 4 5 6 7 8 9 10; do
  printf '%s' "$PAYLOAD" | env COMPLIANCE_CANARY_STATE_DIR="$STATE_ROOT/cc17" COMPLIANCE_CANARY_SKILLS_ROOT="$SKILLS_ROOT/sk17" $HOOK > /dev/null &
done
wait
# hook.py names state files by SHA-256(session_id)[:16].json, not the raw id
sid_hash=$(python3 -c "import hashlib;print(hashlib.sha256('cc-concur'.encode('utf-8',errors='replace')).hexdigest()[:16])")
turn_after=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["turn_count"])' "$STATE_ROOT/cc17/$sid_hash.json")
if [ "$turn_after" = "10" ]; then ok "10 parallel → turn_count=10"; else no "10 parallel → turn_count=10" "got $turn_after"; fi

echo "[18] State GC: 8-day-old state files purged at session-start"
mkdir -p "$STATE_ROOT/cc18"
for old in old1 old2; do
  echo '{"turn_count":1}' > "$STATE_ROOT/cc18/$old.json"
  python3 -c "import os,time;os.utime('$STATE_ROOT/cc18/$old.json', (time.time()-8*86400, time.time()-8*86400))"
done
echo '{"turn_count":1}' > "$STATE_ROOT/cc18/keep.json"
TX="$TRANSCRIPT_DIR/t18.jsonl"
write_transcript "$TX" "$(assistant_text 'x' u1)"
out=$(call cc18 sk1 "$TX" cc-new-sid)  # triggers session-start GC
old_count=$(ls "$STATE_ROOT/cc18"/{old1,old2}.json 2>/dev/null | wc -l | tr -d ' ')
keep=$(ls "$STATE_ROOT/cc18"/keep.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$old_count" = "0" ] && [ "$keep" = "1" ]; then ok "stale purged, fresh kept"; else no "GC" "old=$old_count keep=$keep"; fi

echo "[20] Code-block strip: filler word inside fenced code → silent (false-positive fix)"
PROBES='[{"id":"filler","kind":"forbidden_regex","pattern":"(?i)\\bcertainly\\b"}]'
make_skill_with_probes sk20 cv "$PROBES"
TX="$TRANSCRIPT_DIR/t20.jsonl"
# Build a message with the filler word ONLY inside a fenced code block.
# Use Python (no shell quoting) to write the transcript so backticks survive.
python3 <<PY > "$TX"
import json
fence = chr(96) * 3
msg = f"Here is the change:\n\n{fence}python\nprint(\"Certainly!\")  # literal\n{fence}\n\nDone."
print(json.dumps({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":msg}]}}))
PY
out=$(call cc20 sk20 "$TX" s20)
if [ -z "$out" ]; then ok "code-block 'Certainly' does NOT trigger"; else no "code-block 'Certainly' does NOT trigger" "got: $(echo "$out" | head -c150)"; fi

echo "[21] Code-block strip: filler in PROSE still triggers"
TX="$TRANSCRIPT_DIR/t21.jsonl"
write_transcript "$TX" "$(assistant_text 'Certainly! Glad to help.' u21)"
out=$(call cc21 sk20 "$TX" s21)
if emitted "$out"; then ok "prose 'Certainly' still triggers"; else no "prose 'Certainly' still triggers"; fi

echo "[22] Inline backtick code stripped: inline-coded 'done' does NOT trigger claim probe"
PROBES='[{"id":"unverified","kind":"claim_without_evidence","claim_pattern":"(?i)\\b(done|fixed)\\b","verify_tools":["Bash"]}]'
make_skill_with_probes sk22 vbc "$PROBES"
TX="$TRANSCRIPT_DIR/t22.jsonl"
python3 <<PY > "$TX"
import json
bt = chr(96)
msg = f"I added a {bt}done{bt} flag in the config"
print(json.dumps({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":msg}]}}))
PY
out=$(call cc22 sk22 "$TX" s22)
if [ -z "$out" ]; then ok "inline backtick 'done' does NOT trigger claim probe"; else no "inline backtick 'done' does NOT trigger" "got: $(echo "$out" | head -c200)"; fi

echo "[23] Multi-probe cooldown interleaving: A+B fire turn 1, C newly fires turn 2 (A+B suppressed)"
PROBES='[
  {"id":"a","kind":"forbidden_regex","pattern":"(?i)\\bfoo\\b"},
  {"id":"b","kind":"forbidden_regex","pattern":"(?i)\\bbar\\b"},
  {"id":"c","kind":"forbidden_regex","pattern":"(?i)\\bbaz\\b"}
]'
make_skill_with_probes sk23 multi "$PROBES"
TX="$TRANSCRIPT_DIR/t23a.jsonl"
write_transcript "$TX" "$(assistant_text 'foo and bar are here' u23)"
out1=$(call cc23 sk23 "$TX" s23)
if emitted "$out1" && echo "$out1" | grep -q ' a' && echo "$out1" | grep -q ' b'; then ok "turn 1: A + B both fire"; else no "turn 1: A + B both fire" "got: $(echo "$out1" | head -c200)"; fi
# Turn 2: text now has all three; A + B suppressed, C newly fires
TX="$TRANSCRIPT_DIR/t23b.jsonl"
write_transcript "$TX" "$(assistant_text 'foo bar baz' u23b)"
out2=$(call cc23 sk23 "$TX" s23)
if emitted "$out2" && echo "$out2" | grep -q "matched 'baz'" && ! echo "$out2" | grep -qE "matched 'foo'|matched 'bar'"; then
  ok "turn 2: C fires (matched 'baz'), A+B suppressed"
else
  no "turn 2: cooldown selective" "got: $(echo "$out2" | head -c300)"
fi

echo "[19] MAX_PROBES_TRIGGERED cap: 6 probes, only 4 in output"
mkdir -p "$SKILLS_ROOT/sk19/many"
python3 -c "
import json
probes = [{'id':f'p{i}','kind':'forbidden_regex','pattern':'(?i)x'} for i in range(6)]
print(json.dumps(probes))
" > "$SKILLS_ROOT/sk19/many/drift_probes.json"
TX="$TRANSCRIPT_DIR/t19.jsonl"
write_transcript "$TX" "$(assistant_text 'x' u1)"
out=$(call cc19 sk19 "$TX" s19)
count=$(echo "$out" | grep -c '^- ' || true)
if [ "$count" -le 4 ]; then ok "probe count capped at 4 (got $count)"; else no "probe cap" "got $count"; fi

# ----------------------------------------------------------------------
echo
if [ $FAIL -eq 0 ]; then
  echo "compliance-canary test.sh: $PASS/$((PASS+FAIL)) PASS"
  exit 0
else
  echo "compliance-canary test.sh: $PASS/$((PASS+FAIL)) — failures:"
  for n in "${FAIL_NAMES[@]}"; do echo "  - $n"; done
  exit 1
fi
