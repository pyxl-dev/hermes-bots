"""Rechargement à chaud du plugin (Yoan, 2026-11-18 : « des releases sans redémarrer le gateway »).

Hermes recharge un plugin en réimportant son code : l'état d'un module est perdu et les threads lancés par
l'ancien code continuent. Ce module tient, pour tout le processus (``sys.modules``, hors du paquet rechargé) :

- une génération : chaque chargement en ouvre une ; une boucle de fond lancée par un chargement s'arrête dès
  qu'un chargement plus récent existe (``wait`` rend False), la nouvelle prend la suite avec le nouveau code ;
- les caches qui doivent survivre (``shared``) : rôle du tour en cours, recadrages déjà faits, essais ;
- les actions à faire une seule fois par processus (``once``), même si Hermes charge une copie par profil.

``rpc_reload`` (``plugin.bot-groups.reload``) recharge ce plugin seul, dans chaque profil du gateway, sans
toucher aux autres plugins (un rechargement complet doublerait les threads de hindsight, homeassistant...).
Les tours et tables rondes en cours finissent avec l'ancien code ; leur état (``dispatch._SHARED``) est partagé.
"""
from __future__ import annotations

import hashlib
import sys
import threading
import time
import types
from pathlib import Path

NAME = "bot-groups"
_L = sys.modules.get("_hermes_bot_groups_life")
if _L is None:
    _L = types.ModuleType("_hermes_bot_groups_life")
    _L.gen, _L.loads, _L.cond = 0, 0, threading.Condition()
    _L.state, _L.done, _L.reloads = {}, set(), []
    sys.modules["_hermes_bot_groups_life"] = _L


def begin() -> int:
    """Un chargement commence : nouvelle génération, les boucles des anciennes s'arrêtent."""
    code = code_id()
    with _L.cond:
        _L.gen += 1
        _L.loads += 1
        _L.loaded = code  # empreinte prise au chargement : le disque peut changer ensuite (git pull) sans que le code tourne
        _L.cond.notify_all()
        return _L.gen


def retire(gen: int) -> None:
    """Déchargement (``ctx.on_unload``) : si ce chargement était le plus récent, ses boucles s'arrêtent."""
    with _L.cond:
        if _L.gen == gen:
            _L.gen += 1
            _L.cond.notify_all()


def current() -> int:
    return _L.gen


def wait(gen: int, seconds: float) -> bool:
    """Attend ``seconds`` ; False dès qu'un chargement plus récent existe (la boucle doit s'arrêter)."""
    with _L.cond:
        _L.cond.wait_for(lambda: _L.gen != gen, timeout=seconds)
        return _L.gen == gen


def shared(name: str, factory):
    """Objet gardé à travers les rechargements (un par processus)."""
    with _L.cond:
        if name not in _L.state:
            _L.state[name] = factory()
        return _L.state[name]


def once(name: str) -> bool:
    """True la première fois seulement dans ce processus."""
    with _L.cond:
        if name in _L.done:
            return False
        _L.done.add(name)
        return True


def code_id() -> str:
    """Empreinte des fichiers sur le disque. Le code qui tourne est ``loaded()`` : après un ``git pull`` de la copie
    servie, le disque change mais pas le code chargé (2026-11-18 : la release a lu « déjà à jour » sans rechargement)."""
    h = hashlib.sha256()
    for f in sorted(Path(__file__).parent.glob("*.py")):
        h.update(f.name.encode() + b"\0" + f.read_bytes())
    return h.hexdigest()[:12]


def loaded() -> str | None:
    """Empreinte du code chargé, prise au dernier chargement (``begin``)."""
    return getattr(_L, "loaded", None)


def threads() -> dict[str, int]:
    out: dict[str, int] = {}
    for t in threading.enumerate():
        if t.name.startswith("bot-groups-") and t.is_alive():
            out[t.name] = out.get(t.name, 0) + 1
    return out


def health(params: dict | None = None, **_) -> dict:
    """``plugin.bot-groups.health`` : génération, empreinte du code chargé (``code``) et du disque (``disk``), boucles de
    fond vivantes, rechargements."""
    return {"gen": _L.gen, "loads": _L.loads, "code": loaded() or code_id(), "disk": code_id(), "threads": threads(),
            "reloads": _L.reloads[-5:]}


def _managers() -> list:
    from hermes_cli import plugins as hp  # API interne de Hermes : vérifiée ici, sinon erreur claire
    known = getattr(hp, "_known_plugin_managers", None)
    if known is None:
        raise RuntimeError("Hermes n'expose plus _known_plugin_managers : rechargement impossible, redémarrer le gateway")
    return known()


def rpc_reload(params: dict | None = None, **_) -> dict:
    """``plugin.bot-groups.reload`` : décharge puis recharge ce plugin seul, dans chaque profil chargé."""
    from . import _hub, _log
    t0, before, out = time.time(), loaded(), []
    try:
        for mgr in _managers():
            plugins = getattr(mgr, "_plugins", None)
            if not isinstance(plugins, dict) or not hasattr(mgr, "_load_plugin") or not hasattr(mgr, "unload"):
                raise RuntimeError("API de PluginManager inattendue (_plugins, _load_plugin, unload)")
            key = next((k for k, lp in plugins.items()
                        if getattr(getattr(lp, "manifest", None), "name", None) == NAME and not getattr(lp, "error", None)), None)
            if key is None:
                continue
            manifest = plugins[key].manifest
            mgr.unload(key)
            mgr._load_plugin(manifest)
            lp = getattr(mgr, "_plugins", {}).get(key)
            err = getattr(lp, "error", None) if lp is not None else "absent après rechargement"
            out.append({"home": str(getattr(mgr, "home_path", "")), "ok": not err, **({"error": str(err)[:300]} if err else {})})
        if not out:
            raise RuntimeError("aucune copie chargée de bot-groups dans ce gateway")
        failed = [x for x in out if not x["ok"]]
        rec = {"ts": round(t0), "copies": len(out), "failed": len(failed), "before": before, "after": loaded(),
               "ms": round((time.time() - t0) * 1000)}
        _L.reloads.append(rec)
        _log("plugin_reload", not failed, **rec, **({"cause": failed[0].get("error")} if failed else {}))
        if failed:
            _hub("bot-groups : rechargement en échec", f"{len(failed)}/{len(out)} copie(s) : {failed[0].get('error')}", "4")
        return {"ok": not failed, **rec, "gen": _L.gen, "copies_detail": out[:50]}
    except Exception as exc:
        _log("plugin_reload", False, cause=f"{type(exc).__name__}: {exc}"[:300])
        _hub("bot-groups : rechargement en échec", str(exc)[:200], "4")
        raise
