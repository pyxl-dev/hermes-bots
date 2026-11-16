"""Parallèle forcé (1.15.0, décidé le 2026-11-15) : un message du meneur qui cite au moins deux coéquipiers par
@handle part en group_dispatch au lieu d'une file de tours. Depuis 1.17.0, un message de n'importe quel autre bot
qui cite au moins un coéquipier (hors meneur) aussi, et une citation à la négative perd son @.

Le moteur du gateway joue les @mentions une par une ; le meneur oubliait group_dispatch malgré la consigne. La
réécriture se fait dans transform_llm_output : les bots lancés sont cités sans @ (le moteur ne les fait donc pas
parler en plus), et une ligne dit qui travaille en parallèle. Si le dispatch refuse (bot déjà occupé, limite de
tâches), le message reste tel quel et les tours restent en file : rien n'est perdu.
"""

from __future__ import annotations

import json
import re

from . import _log

MIN_BOTS = 2


def _live(text: str) -> list[tuple[int, int]]:
    """Plages du texte où une mention compte : hors blocs de code, code en ligne et citations."""
    spans, pos = [], 0
    for m in re.finditer(r"```.*?(?:```|\Z)|`[^`\n]*`|^>.*$", text, re.S | re.M):
        spans.append((pos, m.start()))
        pos = m.end()
    spans.append((pos, len(text)))
    return spans


# « sans passer par @x », « pas besoin de @x », « ni @x » : x est nommé, pas sollicité (vu le 2026-11-15).
NEG_RE = re.compile(r"(?:\bsans\b|\bpas besoin\b|\bpas la peine\b|\binutile\b|\bni\b|\bhors\b|\bsauf\b)[^.!?;:\n]{0,40}$", re.I)


def negated(text: str, start: int) -> bool:
    return bool(NEG_RE.search(text[max(0, start - 60):start]))


def strip_negated(text: str, members: list[dict]) -> str:
    """Retire le @ des coéquipiers cités à la négative, hors code et citations : le moteur ne leur donne pas de tour."""
    hs = [str(m.get("handle")) for m in members if m.get("handle")]
    if not hs:
        return text
    rx = re.compile(r"(?<![\w@])@(" + "|".join(re.escape(h) for h in sorted(hs, key=len, reverse=True)) + r")(?![\w-])", re.I)
    cuts = [m for a, b in _live(text) for m in rx.finditer(text, a, b) if negated(text, m.start())]
    for m in reversed(cuts):
        text = text[:m.start()] + m.group(1) + text[m.end():]
    return text


def plan(text: str, members: list[dict], lead_id: str, skip: tuple = ()) -> list[tuple[dict, str]]:
    """[(membre, sa part)] pour chaque coéquipier cité par @handle, dans l'ordre du message. Sa part = les
    paragraphes qui le citent."""
    by = {str(m.get("handle") or "").casefold(): m for m in members
          if m.get("handle") and m.get("member_id") != lead_id and m.get("member_id") not in skip}
    if not by:
        return []
    rx = re.compile(r"(?<![\w@])@(" + "|".join(re.escape(h) for h in sorted(by, key=len, reverse=True)) + r")(?![\w-])",
                    re.I)
    paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    order: list[dict] = []
    parts: dict[str, list[str]] = {}
    for a, b in _live(text):
        for m in rx.finditer(text, a, b):
            who = by[m.group(1).casefold()]
            if negated(text, m.start()):
                continue
            if who not in order:
                order.append(who)
    for who in order:
        h = re.compile(r"(?<![\w@])@" + re.escape(who["handle"]) + r"(?![\w-])", re.I)
        parts[who["member_id"]] = [p.strip() for p in paras if h.search(p)]
    return [(w, "\n\n".join(parts[w["member_id"]]) or text.strip()) for w in order]


def strip_at(text: str, handles: list[str]) -> str:
    """Neutralise la mention (le moteur ne relance pas le bot) en gardant le @ visible : un @ retiré faisait croire à
    Yoan que la mention n'était pas passée (2026-11-16). Un espace sans chasse sépare @ du handle."""
    for h in sorted(handles, key=len, reverse=True):
        text = re.sub(r"(?<![\w@])@(" + re.escape(h) + r")(?![\w-])", "@​\\1", text, flags=re.I)
    return text


def rewrite(text: str, info: dict) -> str | None:
    """Texte réécrit si le parallèle a démarré ou si une citation à la négative a perdu son @, sinon None.
    Jamais d'exception.

    Meneur : au moins MIN_BOTS coéquipiers cités. Autre bot (1.17.0, décidé le 2026-11-15) : dès un coéquipier
    cité, sauf le meneur, qui reste dans le tour du moteur pour coordonner. Un bot déjà occupé par une tâche
    parallèle de ce groupe garde son tour en file."""
    if not info or text.lstrip().startswith("{"):
        return None
    from . import dispatch
    is_lead = bool(info.get("has_lead") and info.get("is_lead"))
    try:
        room, _ctx, lead = dispatch._room_and_lead(info["room_id"])
        members = room.get("members", [])
        cleaned = strip_negated(text, members)
        me = info.get("member_id") or ""
        lead_id = (lead or {}).get("member_id", "")
        with dispatch._jobs_lock:
            busy = {v["bot"] for v in dispatch._jobs.values() if v["status"] == "running" and v["room_id"] == info["room_id"]}
        picked = [(m, part) for m, part in plan(cleaned, members, lead_id if is_lead else me, skip=(me, lead_id))
                  if (m.get("profile") or m.get("member_id")) not in busy]
        if len(picked) < (MIN_BOTS if is_lead else 1):
            return cleaned if cleaned != text else None
        who = "du meneur" if is_lead else f"de {info.get('handle') or info.get('member_id')}"
        assignments = [{"bot": m["handle"], "task": (
            f"Message {who} au groupe :\n{cleaned.strip()}\n\nCe qui te concerne :\n{part}")} for m, part in picked]
        res = json.loads(dispatch.group_dispatch({"room_id": info["room_id"], "assignments": assignments},
                                                 _peer_ok=not is_lead))
    except Exception as exc:
        _log("fanout", False, room_id=info.get("room_id"), cause=str(exc)[:200])
        return None
    if not res.get("ok"):
        _log("fanout", False, room_id=info["room_id"], cause=str(res.get("error"))[:200],
             bots=[m["handle"] for m, _ in picked])
        return cleaned if cleaned != text else None
    started = list(res.get("started") or [])
    names = [m.get("display_name") or m["handle"] for m, _ in picked if m["handle"] in started]
    _log("fanout", True, room_id=info["room_id"], bots=started, by_lead=is_lead)
    return strip_at(cleaned, started).rstrip() + (
        f"\n\n_En parallèle : {', '.join(names)}. "
        + ("Son résultat arrive" if len(names) == 1 else "Leurs résultats arrivent") + " dans le groupe._")


def rewrite_assign(text: str, info: dict, message: str) -> str | None:
    """Tour de répartition du meneur ({"assign": [...]}) : le moteur jouerait les bots choisis un par un. Un seul
    reste dans le tour du moteur (le meneur s'il s'est choisi, sinon le premier) ; les autres partent tout de suite
    en group_dispatch avec le message de Yoan. Réponse JSON réécrite, ou None (inchangée). Jamais d'exception."""
    if not (info and info.get("has_lead") and info.get("is_lead")) or not message.strip():
        return None
    from . import dispatch
    try:
        obj = json.loads(text[text.index("{"):text.rindex("}") + 1])
        names = [str(h).lstrip("@").casefold() for h in obj.get("assign") or [] if isinstance(h, str)]
        room, _ctx, lead = dispatch._room_and_lead(info["room_id"])
        members = room.get("members", [])
        picked = [m for m in members if str(m.get("handle") or "").casefold() in names]
        if len(picked) < MIN_BOTS:
            return None
        lead_id = (lead or {}).get("member_id")
        keep = next((m for m in picked if m.get("member_id") == lead_id), picked[0])
        others = [m for m in picked if m is not keep]
        res = json.loads(dispatch.group_dispatch({"room_id": info["room_id"], "assignments": [
            {"bot": m["handle"], "task": f"Message de Yoan au groupe (le meneur te l'a confié) :\n{message.strip()}"}
            for m in others]}))
    except Exception as exc:
        _log("fanout_assign", False, room_id=info.get("room_id"), cause=str(exc)[:200])
        return None
    if not res.get("ok"):
        _log("fanout_assign", False, room_id=info["room_id"], cause=str(res.get("error"))[:200])
        return None
    _log("fanout_assign", True, room_id=info["room_id"], engine=keep["handle"], bots=res.get("started"))
    return json.dumps({"assign": [keep["handle"]]})


# ---------- @ oubliés (1.18.0, 2026-11-16) ----------
# Les bots adressent un coéquipier par son nom sans @ (« uncensored : … », « rea, … », tableau « poste » d'un bloc
# bots-ui) : le moteur ne lui donne alors aucun tour. On remet le @ dans les seules positions d'adresse.
ASSIGN_COL = re.compile(r"poste|bot|membre|qui|assign|responsable|pour", re.I)


def _names(members: list[dict], me: str) -> dict[str, str]:
    """nom écrit -> handle. Handle sensible à la casse (« dofus » le bot, pas « Dofus » le jeu), nom affiché exact."""
    out = {}
    for m in members:
        h = str(m.get("handle") or "")
        if not h or m.get("member_id") == me:
            continue
        out[h] = h
        dn = str(m.get("display_name") or "")
        if dn and dn != h:
            out[dn] = h
    return out


def _ui_assignees(text: str, names: dict[str, str]) -> list[str]:
    """Handles en première colonne d'un tableau bots-ui dont l'en-tête désigne un poste (répartition du travail)."""
    found = []
    for blk in re.finditer(r"```bots-ui\s*\n(.*?)```", text, re.S):
        try:
            data = json.loads(blk.group(1))
        except Exception:
            continue
        for t in (data if isinstance(data, list) else [data]):
            if not isinstance(t, dict) or t.get("type") != "table" or not t.get("columns"):
                continue
            if not ASSIGN_COL.search(str(t["columns"][0])):
                continue
            for row in t.get("rows") or []:
                cell = str(row[0]).strip().lstrip("@").strip("*` ") if isinstance(row, list) and row else ""
                h = names.get(cell)
                if h and h not in found:
                    found.append(h)
    return found


def add_at(text: str, info: dict) -> str | None:
    """Texte avec les @ manquants, ou None s'il n'y a rien à ajouter. Jamais d'exception."""
    if not info or text.lstrip().startswith("{"):
        return None
    from . import dispatch
    try:
        room, _ctx, _lead = dispatch._room_and_lead(info["room_id"])
        names = _names(room.get("members", []), info.get("member_id") or "")
        if not names:
            return None
        alt = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
        # début de ligne (après puce, numéro, gras) ou début de phrase (après « . ; ! ? »), le nom, puis « : » ou « , »
        # (« ... entre chargement et tir. dofus-net : prépare ... » laissait dofus-net inactif le 2026-11-16)
        rx = re.compile(r"(?m)(^[ \t]*(?:[-*•>]|\d+[.)])?[ \t]*(?:\*\*|__)?|(?<=[.;!?])[ \t]+(?:\*\*|__)?)("
                        + alt + r")((?:\*\*|__)?[ \t]*[:,])")
        added: list[str] = []

        def sub(m: re.Match) -> str:
            h = names[m.group(2)]
            added.append(h)
            return f"{m.group(1)}@{h}{m.group(3)}"

        spans, out, pos = _live(text), [], 0
        for a, b in spans:
            out.append(text[pos:a])
            out.append(rx.sub(sub, text[a:b]))
            pos = b
        new = "".join(out) + text[pos:]
        cited = {h.casefold() for h in re.findall(r"(?<![\w@])@([\w.-]+)", "".join(new[a:b] for a, b in _live(new)))}
        missing = [h for h in _ui_assignees(text, names) if h.casefold() not in cited]
        if missing:
            new = new.rstrip() + "\n\n" + " ".join("@" + h for h in missing)
            added += missing
    except Exception as exc:
        _log("auto_at", False, room_id=info.get("room_id"), cause=str(exc)[:200])
        return None
    if not added:
        return None
    _log("auto_at", True, room_id=info["room_id"], by=info.get("handle"), added=sorted(set(added)))
    return new
