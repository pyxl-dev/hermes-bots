"""Routage d'un message de groupe : décisions pures, sans état ni import de Hermes ou du plugin.

Première brique (2026-11-19) : la lecture des citations @handle, qui était écrite quatre fois avec deux règles
différentes. steer._target, dispatch._neutralize et fanout.add_at lisaient « @dofus. » ou « @rea: » comme les handles
« dofus. » et « rea: », qui ne sont personne : le recadrage partait au meneur au lieu du bot cité, et une citation
suivie d'une ponctuation restait active dans un résultat de table ronde. La règle unique est celle de fanout : un
handle de membre, entier, précédé d'aucun mot ni @, suivi d'aucun caractère de mot ni tiret. La PWA applique la même
(web/src/data/groups.ts, citedMembers). Cas : test/routing_cases.py.

Aucun état de module : rien à garder dans lifecycle.shared au rechargement à chaud, entrées et sorties en dicts.
"""
from __future__ import annotations

import re


def cite_rx(handles) -> re.Pattern | None:
    """Motif des citations des handles donnés (le plus long d'abord : « fz.a » avant « fz »), sans casse."""
    hs = sorted({str(h) for h in handles if h}, key=len, reverse=True)
    if not hs:
        return None
    return re.compile(r"(?<![\w@])@(" + "|".join(re.escape(h) for h in hs) + r")(?![\w-])", re.I)


def cited(text: str, members: list[dict]) -> list[dict]:
    """Membres cités par @handle, dans l'ordre du texte, chacun une fois."""
    by = {str(m.get("handle") or "").casefold(): m for m in members if m.get("handle")}
    rx = cite_rx(by)
    out: list[dict] = []
    for m in rx.finditer(text or "") if rx else ():
        who = by.get(m.group(1).casefold())
        if who is not None and who not in out:
            out.append(who)
    return out


def cited_handles(text: str, handles) -> set[str]:
    """Handles (en minuscules) cités dans le texte, parmi ceux donnés."""
    rx = cite_rx(handles)
    return {m.group(1).casefold() for m in rx.finditer(text or "")} if rx else set()


def neutralize(text: str, handles) -> str:
    """Les citations de ces handles ne réveillent personne : un espace sans chasse sépare @ du handle."""
    rx = cite_rx(handles)
    return rx.sub(lambda m: "@​" + m.group(1), text) if rx else text
