#!/usr/bin/env python3
"""Unit tests for provenance.py — the memory-integrity defense.

Run: python3 -m pytest skills/wiki-memory/tools/test_provenance.py -q
 or: python3 skills/wiki-memory/tools/test_provenance.py   (no pytest needed)
"""
from __future__ import annotations

import provenance as P


def _check(name, cond):
    assert cond, f"FAIL: {name}"
    print(f"  ok: {name}")


def test_trust_tiers():
    _check("user => user_confirmed", P.trust_for("user") == 4.0)
    _check("verified => verified", P.trust_for("agent", 1, True) == 3.0)
    _check("single assertion => asserted", P.trust_for("agent", 1, False) == 1.0)
    _check("2 sources => corroborated", P.trust_for("agent", 2, False) == 2.0)
    _check("corroboration capped < verified", P.trust_for("agent", 20, False) < 3.0)


def test_resolve_create_and_corroborate():
    _check("no prior => create", P.resolve(None, P.Fact("s", "v"))[0] == "create")
    e = P.Fact("s", "ship", trust=1.0)
    _check("same value => corroborate", P.resolve(e, P.Fact("s", "ship", trust=1.0))[0] == "corroborate")


def test_resolve_conflict_by_trust():
    truth = P.Fact("deploy", "helios ship --wave 3", trust=P.TRUST_TIERS["user_confirmed"])
    poison = P.Fact("deploy", "helios deploy --stage 3", trust=P.TRUST_TIERS["asserted"])
    # poison arriving against established truth -> REJECT (the Exp5 overwrite case)
    _check("low-trust poison vs truth => reject", P.resolve(truth, poison)[0] == "reject")
    # a genuine high-trust correction arriving against a low-trust prior -> REPLACE
    _check("high-trust correction => replace", P.resolve(poison, truth)[0] == "replace")
    # equal trust => dispute
    a = P.Fact("deploy", "A", trust=2.0); b = P.Fact("deploy", "B", trust=2.0)
    _check("equal-trust conflict => dispute", P.resolve(a, b)[0] == "dispute")


def test_apply_corroboration_bumps_trust():
    e = P.Fact("s", "v", trust=1.0, source="agent", corroboration=1)
    e2, action, _ = P.apply(e, P.Fact("s", "v", trust=1.0, source="agent"))
    _check("corroborate bumps count", e2.corroboration == 2 and action == "corroborate")
    _check("corroborate bumps trust >=2", e2.trust >= 2.0)


def test_apply_reject_keeps_truth():
    truth = P.Fact("deploy", "ship", trust=4.0)
    state, action, _ = P.apply(truth, P.Fact("deploy", "deploy", trust=1.0))
    _check("reject keeps established value", state.value == "ship" and action == "reject")


def test_apply_dispute_marks_contested():
    a = P.Fact("deploy", "ship", trust=2.0)
    state, action, _ = P.apply(a, P.Fact("deploy", "launch", trust=2.0))
    _check("dispute sets disputed flag", state.disputed and "launch" in state.alt_values)


def test_serve_hedges_on_dispute_and_lowtrust():
    # confident: verified top
    v, hedge, _ = P.serve([{"value": "ship", "trust": 3.0, "verified": True}])
    _check("verified top served confidently", v == "ship" and hedge is False)
    # hedge: disputed top
    v, hedge, _ = P.serve([{"value": "ship", "trust": 2.0, "disputed": True}])
    _check("disputed top hedges", hedge is True)
    # hedge: low-trust unverified (the poison-only mitigation)
    v, hedge, _ = P.serve([{"value": "deploy", "trust": 1.0, "verified": False}])
    _check("low-trust unverified hedges", hedge is True)
    # ranking: higher trust wins
    ranked = P.rank_hits([{"value": "lo", "trust": 1.0}, {"value": "hi", "trust": 4.0}])
    _check("rank_hits puts highest trust first", ranked[0]["value"] == "hi")


def test_verify_against_oracle():
    _check("true fact verifies", P.verify_against_oracle("helios ship --wave 3",
                                                          ["helios ship --wave 3"]))
    _check("poison does not verify", not P.verify_against_oracle("helios deploy --stage 3",
                                                                 ["helios ship --wave 3"]))


def run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    print(f"running {len(fns)} provenance test groups")
    for fn in fns:
        print(f"- {fn.__name__}")
        fn()
    print(f"\nALL {len(fns)} GROUPS PASSED")


if __name__ == "__main__":
    run_all()
