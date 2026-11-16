"""Réglages des équipes, modifiables depuis la PWA (demandé par Yoan le 2026-11-13).

Ils vivent dans ``~/.hermes/config.yaml`` sous ``hosted_rooms.discussion`` : ``max_members`` (taille
d'une équipe, lue par la PWA et par ``group_create``), ``max_rounds`` et ``max_messages`` (lus par le
gateway au début de chaque discussion, sans redémarrage). L'écriture passe par ``hermes config set``.
"""
from __future__ import annotations

import subprocess

from . import ROOT, _hub, _log

# Bornes : membres plafonnés par le gateway (MAX_DISCUSSION_MEMBERS = 16).
FIELDS = {"max_members": (2, 16, 10), "max_rounds": (1, 10, 3), "max_messages": (2, 200, 10)}
HERMES = ROOT / "hermes-agent" / "venv" / "bin" / "hermes"


def read() -> dict:
    import yaml
    try:
        cfg = yaml.safe_load((ROOT / "config.yaml").read_text()) or {}
    except (OSError, yaml.YAMLError):
        cfg = {}
    raw = ((cfg.get("hosted_rooms") or {}).get("discussion") or {}) if isinstance(cfg, dict) else {}
    out = {}
    for key, (lo, hi, default) in FIELDS.items():
        val = raw.get(key) if isinstance(raw, dict) else None
        out[key] = val if isinstance(val, int) and not isinstance(val, bool) and lo <= val <= hi else default
    return out


def max_members() -> int:
    return read()["max_members"]


def rpc_get(params: dict, **_) -> dict:
    return {**read(), "bounds": {k: [lo, hi] for k, (lo, hi, _d) in FIELDS.items()}}


def rpc_set(params: dict, **_) -> dict:
    changes = {}
    for key, (lo, hi, _d) in FIELDS.items():
        if key not in params:
            continue
        val = params[key]
        if not isinstance(val, int) or isinstance(val, bool) or not lo <= val <= hi:
            raise ValueError(f"{key} doit être un entier entre {lo} et {hi}")
        changes[key] = val
    if not changes:
        raise ValueError("aucun réglage reçu")
    before = read()
    for key, val in changes.items():
        if before.get(key) == val:
            continue
        r = subprocess.run([str(HERMES), "config", "set", "--force", f"hosted_rooms.discussion.{key}", str(val)],
                           env={"HOME": str(ROOT.parent), "HERMES_HOME": str(ROOT), "PATH": "/usr/bin:/bin"},
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0 or "✓" not in r.stdout:
            err = (r.stderr or r.stdout).strip()[-300:]
            _log("settings_set", False, key=key, value=val, error=err)
            _hub("Réglages équipes : échec", f"{key}={val} : {err}", "4")
            raise RuntimeError(f"écriture de {key} refusée : {err}")
    after = read()
    _log("settings_set", True, before=before, after=after)
    return after
