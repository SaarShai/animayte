# EVAL — `think`

`think` is a pure-prompt **mindset** skill (no hook, no tool). It is the hardest
category to measure: unlike `caveman-ultra` (−% output) or `semantic-diff`
(token savings) there is no crisp metric, and the behaviors it targets
(challenge premises, reduce-before-add, first-principles) only surface in a
model capable enough to recognize a flawed framing. **Read the interpretation
section before trusting the A/B delta.**

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (frontmatter; resident part is the catalog one-liner) | **81 tokens** (376 chars) |
| body (loaded on `/think`)      | **1,238 tokens** (5,397 chars) |
| tools/ payload                 | 0.0 KB |
| model pin                      | `any` |
| effort pin                     | `medium` |

Source: [`eval/results/static_cost.json`](../../eval/results/static_cost.json).
As a slash-only skill the always-resident part is just the catalog one-liner
(the first sentence, ~40 tok); the full 81-tok description and 1,238-tok body
load only on `/think`. Cheap either way.

## Trigger accuracy (measured) — the solid result

`eval/exp8_trigger/run_trigger.py`, live 16-skill catalog, qwen2.5:7b router,
one canonical should-fire prompt per skill:

| metric | value |
|---|---|
| top-1 accuracy | **14/14 = 1.0** |
| `think` self-fire | ✅ correct |
| regression on other 15 skills | **none** — adding `think`'s broad description stole no other skill's prompt (incl. `plan-first-execute`, `lean-execution`) |

Raw: [`eval/exp8_trigger/results/with-think.json`](../../eval/exp8_trigger/results/with-think.json).
Caveat: this is the one-prompt-per-skill design; it does **not** probe ambiguous
boundary prompts (think-vs-plan-first). Boundary/negative trigger cases are a
follow-up.

## A/B (smoke — NON-CONFIRMING) — N=3 × 5 trap probes

- Subject model: **qwen2.5:7b-instruct** (local Ollama).
- Judge model: **gemma2:9b** (distinct family → no self-judge; `gemma4:26b`, the
  repo default judge, is a broken local pull — 404s on `/api/generate`).
- Tasks: [`eval/tasks/think.yaml`](../../eval/tasks/think.yaml) — each prompt is a
  TRAP (false premise / unnecessary work / reinvention / cargo-cult / XY-problem);
  pass = catch the trap.

| metric | without skill | with skill | Δ |
|---|---|---|---:|
| input tokens (mean)  | 61 | 1,406 | +2,219% (the 1.3k body when loaded) |
| **output tokens (mean)** | 690 | 854 | **+23.7%** |
| latency (ms)         | 12,222 | 15,435 | +26% |
| **judge score (0–5)**    | **3.4** | **2.8** | **−0.6** |

Raw: [`eval/results/think.json`](../../eval/results/think.json) ·
[`eval/results/think.judged.json`](../../eval/results/think.judged.json).

### Per-probe trap-catch (judge gemma2:9b)

| probe | trap | without | with | Δ |
|---|---|---:|---:|---:|
| 0 | GIL ≠ "threads can't help I/O-bound" | 4 | 4 | 0 |
| 1 | cache a once-at-startup 12-row read | 4 | 4 | 0 |
| 2 | hand-roll RFC-3339 parsing | 1 | 1 | 0 |
| 3 | microservices for ~500 DAU | 3 | **1** | **−2** |
| 4 | regex micro-opt vs per-keystroke | 5 | 4 | −1 |

The whole −0.6 comes from probe 3 (−2) and probe 4 (−1); probes 0–2 are flat.

## Interpretation — why the smoke is non-confirming, not a verdict

1. **`think` is token-positive (+23.7% output).** Ideation, premise-challenging,
   and the named methods add prose. Its justification therefore **cannot** be
   token economy — it is the one discipline skill expected to *increase* output.
   It composes badly on the same axis as `caveman-ultra`/`lean-execution`; if
   stacked, expect the output reducers to claw most of it back. Measure the
   `think + caveman` interaction before relying on it in a terse stack.
2. **The −0.6 is dominated by method-theater, not reasoning harm.** Manual read
   of the raw outputs: with `think`, the 7b model *recites* the skill's
   vocabulary ("Step 2: Brain Blizzard + Scout Tests + Sieve…") as ritual, then
   on probe 3 still lands on a confidently-wrong answer (recommends
   Linkerd + RabbitMQ for 500 users) — which the judge penalized harder than the
   hedged baseline. The skill induced *ceremony* the model couldn't cash into
   *insight*.
3. **Small models are an invalid testbed here — as subject AND as judge.**
   - Subject (7b-instruct) is too literal/compliant: it obeyed "don't use date
     libraries" (probe 2) and "design cache invalidation" (probe 1) instead of
     challenging the premise — the exact behavior `think` exists to override.
   - Judge (9b) is too weak to *detect* trap-catching: it scored probe 1 a 4/4
     when **neither** answer caught the trap, and tied probe 0 where `think`
     clearly corrected the premise harder. A judge that can't see the trap can't
     credit catching it.
   Net: this smoke mostly measured "does a 7b perform the rituals and does a 9b
   like the result," not "does `think` improve frontier reasoning."

**Do not read −0.6 as "think degrades reasoning."** Read it as: *unverified, and
local small models can't verify it.* The two trustworthy results are trigger
(1.0, no regression) and the tiny resident cost. **The frontier A/B below settles it.**

## Frontier A/B (Opus subject / Sonnet judge) — the decisive test, DONE

Ran the same 5 probes with a **frontier subject and a cross-model judge** via a
subagent workflow (no API key — uses session models): subject =
**claude-opus-4-8** (with vs without the skill; the `with` arm *reads the real
`skills/think/SKILL.md`*); judge = **claude-sonnet**, *told the trap* so it scores
reliably (fixing the 9b judge's blindness). N=3 × 5 × 2 = 30 subject runs.

| probe | without | with | Δ | caught w/o→with |
|---|---:|---:|---:|---|
| gil   | 5.00 | 5.00 | 0 | 3/3 → 3/3 |
| redis | 5.00 | 5.00 | 0 | 3/3 → 3/3 |
| dates | 1.33 | 1.33 | 0 | 0/3 → 0/3 |
| micro | 5.00 | 5.00 | 0 | 3/3 → 3/3 |
| regex | 4.67 | 5.00 | +0.33 | 3/3 → 3/3 |
| **overall** | **4.20** | **4.27** | **+0.07** | **80% → 80%** |

**Verdict: neutral.** Opus catches the traps equally well with or without the
skill — the *baseline already scores 4.20 / 80% caught*; the skill adds +0.07
(noise). This settles the 7b ambiguity both ways: the 7b "−0.6 harm" was
**method-theater** (Opus doesn't recite rituals), and there was never a lift to
find **on this one model** — Opus already does first-principles trap-catching
natively. But that is **N=1 model and proves nothing general**; the **7b *failed*
these traps**, so the posture content is **load-bearing for weaker models**, not
redundant. Read it as *Opus didn't need it here*, not *frontier models don't need
it* — which is exactly why the skill is now written for the weakest model that loads it.

`dates` (1.33/1.33, neither arm caught) is a **flawed probe**: the old prompt
ordered "do not use any date libraries" — a legitimate user constraint, so
complying isn't a trap-fail. Revised in `think.yaml` (the trap is now the
reinvention *impulse*, not disobeying an order); re-measure next run.

**Mode implication:** on Opus specifically, auto-loading `think` buys ~**zero**
posture benefit at **+23.7% output** per fire — but a weaker model *does* need the
posture, so the content stays. Manual `/think` is a **control** choice (you decide
when), not a 'redundant' claim. The body is now written for the weakest model that
loads it: **Always** (unconditional imperatives) + **When-relevant** (task-gated,
de-ritualized) — see SKILL.md. Shipped **`disable-model-invocation: true`**
(slash-only `/think`).

Raw: workflow run `wf_bd0b9813` (subject/judge transcripts under the session's
`subagents/workflows/`).

## What the skill currently rests on

- ✅ Triggers cleanly, zero regression (measured).
- ✅ Trivially cheap resident (slash-only; catalog one-liner ~40 tok, no hook/dep).
- ➖ Posture value: **neutral for Opus** on these 5 probes (+0.07) but
  **load-bearing for the 7b** (which failed them) — not redundant in general, only
  for a model already strong at first-principles. Manual `/think` is a *control*
  choice (you decide when), not a 'redundant' claim.
- ❓ The *situational methods* (ideation / 5-whys / pre-mortem) are **untested** —
  the trap probes exercise posture, not method. That half is what a deliberate
  `/think` is for; give it its own probe set if it's to earn more than a slot.

## Open follow-ups

- Re-run with the fixed `dates` probe (current 1.33 is a probe artifact).
- A probe set for the **methods** half: does a deliberate 5-whys / pre-mortem /
  structured ideation beat unstructured frontier reasoning on tasks that need
  them? The trap probes don't test this.
- `think + caveman` interaction (does the +23.7% output survive a terse style).

## Failure modes (observed at 7b — watch for them at scale)

- **Method-theater:** named methods ("Brain Blizzard", "5 Whys") recited as
  ritual headers without doing the underlying work. **Fixed:** the body was
  restructured into **Always** (unconditional imperatives) + **When-relevant**
  (task-gated, behaviour-first, method-names demoted to parenthetical labels) with
  an apply-note ("do it even if you'd already; don't announce — perform, don't
  recite"), to make directives land on weaker models and stop recitation.
- **Output inflation** on prompts that didn't need deliberation (the catalog's
  known weakness on terse/clear tasks — `think` should not fire there; trigger
  test suggests it doesn't).

## Methodology

- Sample size: N=3 local smoke (directional only). N≥50 + frontier model for any
  behavioral claim — none is made here.
- Backends: `runner.py` supports `ollama` / `anthropic` / `mimo` / `mlx`.
- Judge: `judge.py --backend ollama --model gemma2:9b` (default `mimo`/`gemma4:26b`
  unavailable — see above). Rubric embedded per-task in the YAML.
- Frontier A/B: subagent workflow (`think-frontier-ab`), Opus subject / Sonnet
  judge, N=3, judge *told the trap*. **Gotcha:** subjects have file tools — the
  `dates` probe made some write a parser to the repo root (`rfc3339.py` etc.),
  which had to be deleted before commit. A re-run must add "answer in text only;
  do not create files" to the subject prompt.
