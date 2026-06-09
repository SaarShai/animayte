#!/usr/bin/env python3
"""provenance — memory-integrity layer: trust tiers + conflict-aware writes +
trust-ranked retrieval.

Closes the exp5_adversarial finding that the write-gate scores SIGNAL, not TRUTH —
so a confident, well-formed WRONG lesson passes it (gate score 4.88) and corrupts
retrieval. The gate is the wrong layer to defend truth; this is the right one.

Three layers (the user picked "build all three, layered"):

  1. TRUST TIERS — every fact carries a provenance tier, stamped at write:
       asserted (1.0)        an agent said so (default; cheap, untrusted)
       corroborated (2.0+)   the same value re-asserted from K independent sources
       verified (3.0)        the value checked against ground truth (fs / code / test)
       user_confirmed (4.0)  a human confirmed it (highest)

  2. CONFLICT-AWARE WRITE — on a same-subject value-conflict (found via `wiki overlap`):
       candidate.trust >  existing.trust  -> REPLACE   (a legit higher-trust correction)
       candidate.trust <  existing.trust  -> REJECT    (poison cannot overwrite truth)
       candidate.trust == existing.trust  -> DISPUTE   (keep both, mark contested)
     Same value -> CORROBORATE (bump the existing fact's trust).

  3. TRUST-RANKED RETRIEVAL + DISPUTED-SURFACING — rank hits by trust; serve the
     highest-trust fact; if it is DISPUTED or merely low-trust-unverified, HEDGE rather
     than confidently assert it.

Honest limit (named, not papered over): the *poison-only* case — a confident lie is the
ONLY thing ever learned, with no competing truth and no verifier — cannot be fixed by
ranking. The defense degrades it from "confidently serves the lie" to "serves it flagged
as unverified", and otherwise defers to write-time verification / verify-before-completion.
A pure memory layer must not pretend to adjudicate truth it cannot check.

Pure functions + a tiny CLI for inspection. No wiki/network deps, so it is trivially
unit-testable and reusable from the wiki write path and the eval harnesses alike.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from typing import Iterable

TRUST_TIERS = {
    "asserted": 1.0,
    "corroborated": 2.0,
    "verified": 3.0,
    "user_confirmed": 4.0,
}
_EPS = 1e-6
# A fact is "confident-servable" only at/above this trust, else retrieval hedges.
CONFIDENT_TRUST = TRUST_TIERS["verified"]


def trust_for(source: str = "agent", corroboration: int = 1, verified: bool = False) -> float:
    """Map provenance signals to a numeric trust tier (layers 1 feeds: corroboration, verify)."""
    if source == "user":
        return TRUST_TIERS["user_confirmed"]
    if verified:
        return TRUST_TIERS["verified"]
    if corroboration >= 2:
        # corroboration feeds trust: each extra independent source nudges it up, capped
        # just under `verified` so corroboration never silently masquerades as a real check.
        return min(TRUST_TIERS["corroborated"] + 0.3 * (corroboration - 2), 2.9)
    return TRUST_TIERS["asserted"]


def _norm(v: str) -> str:
    return " ".join(str(v).strip().lower().split())


def same_value(a: str, b: str) -> bool:
    """Normalized value equality (whitespace/case-insensitive)."""
    return _norm(a) == _norm(b)


@dataclass
class Fact:
    subject: str
    value: str
    trust: float = TRUST_TIERS["asserted"]
    source: str = "agent"
    verified: bool = False
    corroboration: int = 1
    disputed: bool = False
    alt_values: list[str] = field(default_factory=list)  # contested alternatives, if disputed

    def to_dict(self) -> dict:
        return {
            "subject": self.subject, "value": self.value, "trust": round(self.trust, 3),
            "source": self.source, "verified": self.verified,
            "corroboration": self.corroboration, "disputed": self.disputed,
            "alt_values": self.alt_values,
        }


def resolve(existing: Fact | None, candidate: Fact) -> tuple[str, str]:
    """Decide what to do with `candidate` given the `existing` fact on the same subject.

    Returns (action, reason) where action ∈ {create, corroborate, replace, reject, dispute}.
    """
    if existing is None:
        return "create", "no prior fact on this subject"
    if same_value(existing.value, candidate.value):
        return "corroborate", "same value re-asserted — bump trust"
    # value conflict
    if candidate.trust > existing.trust + _EPS:
        return "replace", (f"higher-trust correction ({candidate.trust:.1f} > "
                           f"{existing.trust:.1f})")
    if candidate.trust < existing.trust - _EPS:
        return "reject", (f"lower-trust contradicts established fact ({candidate.trust:.1f} < "
                          f"{existing.trust:.1f}) — quarantined as possible poison")
    return "dispute", f"equal-trust conflict ({candidate.trust:.1f}) — contested"


def apply(existing: Fact | None, candidate: Fact) -> tuple[Fact, str, str]:
    """Apply `resolve`'s decision, returning (new_fact_state, action, reason)."""
    action, reason = resolve(existing, candidate)
    if action == "create":
        return candidate, action, reason
    if action == "corroborate":
        existing.corroboration += 1
        existing.trust = max(existing.trust,
                             trust_for(existing.source, existing.corroboration, existing.verified))
        return existing, action, reason
    if action == "replace":
        return candidate, action, reason
    if action == "reject":
        return existing, action, reason  # store unchanged; candidate dropped
    # dispute: keep the existing-as-top but mark both contested
    existing.disputed = True
    if candidate.value not in existing.alt_values:
        existing.alt_values.append(candidate.value)
    return existing, action, reason


def rank_hits(hits: Iterable[dict]) -> list[dict]:
    """Layer 3: sort retrieval hits by trust desc, disputed last among equals."""
    return sorted(hits, key=lambda h: (-float(h.get("trust", 0.0)), bool(h.get("disputed", False))))


def serve(hits: Iterable[dict], require_verified_for_confident: bool = True) -> tuple[str | None, bool, str]:
    """Pick what to serve from ranked hits. Returns (value, hedge, note).

    hedge=True means "surface but do NOT assert as confident truth" — the caller should
    phrase it as contested/unverified. This is what stops the poison-only case from being
    served as a confident lie.
    """
    ranked = rank_hits(hits)
    if not ranked:
        return None, False, "no memory"
    top = ranked[0]
    if top.get("disputed"):
        return top.get("value"), True, "DISPUTED — sources disagree"
    if require_verified_for_confident and float(top.get("trust", 0.0)) < CONFIDENT_TRUST \
            and not top.get("verified"):
        return top.get("value"), True, "low-trust / unverified — hedge"
    return top.get("value"), False, "confident"


def verify_against_oracle(value: str, oracle_values: Iterable[str]) -> bool:
    """Layer-1 top tier: a checkable fact confirmed against ground truth.

    In production the oracle is the filesystem / code / a test run (cf. `wiki audit-refs`,
    which already flags pages whose cited code paths no longer exist). In the eval harness
    the oracle is the set of true Project-Helios facts. A value matching the oracle earns
    the `verified` tier; one that does not is left low-trust (a likely poison).
    """
    return any(same_value(value, ov) for ov in oracle_values)


# --- tiny CLI for inspection / scripting -----------------------------------
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="provenance", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve", help="decide create/replace/reject/dispute for a candidate")
    r.add_argument("--existing-value"); r.add_argument("--existing-trust", type=float, default=1.0)
    r.add_argument("--value", required=True); r.add_argument("--trust", type=float, default=1.0)
    t = sub.add_parser("trust", help="compute a trust tier from provenance signals")
    t.add_argument("--source", default="agent"); t.add_argument("--corroboration", type=int, default=1)
    t.add_argument("--verified", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "trust":
        print(json.dumps({"trust": trust_for(args.source, args.corroboration, args.verified)}))
        return 0
    existing = None
    if args.existing_value:
        existing = Fact(subject="x", value=args.existing_value, trust=args.existing_trust)
    cand = Fact(subject="x", value=args.value, trust=args.trust)
    action, reason = resolve(existing, cand)
    print(json.dumps({"action": action, "reason": reason}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
