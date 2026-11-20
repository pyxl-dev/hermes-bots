"""@yoan : un agent qui a besoin de Yoan l'écrit, Yoan reçoit une notif prioritaire (décidé le 2026-11-12).

- ``pre_llm_call`` ajoute la consigne au message du tour (jamais au prompt système). Dans un groupe
  avec meneur, seul le meneur a le droit de mentionner @yoan ; les autres s'adressent au meneur.
- ``post_llm_call`` repère @yoan dans la réponse. Hors règle (non-meneur d'un groupe à meneur) : journalisé,
  pas de notif. Sinon : mention ajoutée au ui_meta ``hermes-bots-mentions`` du profil (la PWA s'en sert
  pour les badges), puis une notif Web Push de la PWA Hermes Bots (``server.ts push``, depuis le
  2026-11-13 : Yoan veut la notif dans Bots, plus dans Hub). Hub ne sert plus qu'en secours, quand aucun
  appareil n'est abonné ou que l'envoi échoue.
Journal : ~/.hermes/data/bot-groups/actions.jsonl (actions ``mention``, ``mention_blocked``, ``mention_failed``).
"""
from __future__ import annotations

import re
import sqlite3
import subprocess
import threading
import time
import uuid

from pathlib import Path

from . import _caller, _hub, _log, _rpc, HUB_NOTIFY, fanout, ui_guard

BUN = Path.home() / ".bun" / "bin" / "bun"
PWA_SERVER = Path.home() / "Projects" / "hermes-bots-pwa" / "server.ts"

def _pwa_url() -> str:
    """Origine publique de la PWA : variable PWA_URL, sinon ~/.config/hermes-bots/config.json (hors dépôt)."""
    import json
    import os

    try:
        conf = json.loads((Path.home() / ".config" / "hermes-bots" / "config.json").read_text())
    except (OSError, ValueError):
        conf = {}
    return os.environ.get("PWA_URL") or conf.get("pwaUrl") or "http://127.0.0.1:9131/bots/"


PWA_URL = _pwa_url()
META_KEY = "hermes-bots-mentions"
KEEP = 20
MENTION_RE = re.compile(r"(?<![\w@])@yoan\b", re.IGNORECASE)
DISCUSSION_RE = re.compile(r'^\[Discussion: "(.+?)"\] You are @([\w.-]+)', re.MULTILINE)
ROOM_TTL = 120.0
# Message d'un autre bot (message_agent) : la réponse repart d'elle-même chez l'expéditeur.
BOT_DM_RE = re.compile(r"^\s*Message from [^\n]*?\(@([\w.-]+)\):")

from . import lifecycle  # caches gardés au rechargement à chaud : un tour commencé avant garde son rôle
_roles: dict[str, dict] = lifecycle.shared("mention.roles", dict)       # session_id -> rôle du dernier tour
_rooms: dict[str, tuple] = lifecycle.shared("mention.rooms", dict)      # (nom, handle) -> (horodatage, info)
_lock = lifecycle.shared("mention.lock", threading.Lock)

BASE = ("[Consigne de Yoan] @yoan déclenche une notification prioritaire sur son téléphone. Utilise-le seulement "
        "pour lui demander directement une décision, une validation ou une action, en ouvrant la phrase qui la "
        "demande : « @yoan, tu valides X ? ». Pour parler de lui, écris « Yoan » sans @. Au plus un @yoan par réponse.")


CLARIFY = ("[Consigne de Yoan] Quand tu as besoin que Yoan tranche un choix, même un simple oui/non, pose la "
           "question avec l'outil clarify (choix proposés, le recommandé en premier) au lieu de l'écrire dans ta "
           "réponse : il répond d'un tap depuis son téléphone, et l'attente n'a pas de limite de temps. Une question "
           "par décision ; regroupe-les si tu en as plusieurs. N'utilise pas clarify pour des questions rhétoriques "
           "ni pour ce que tu peux décider toi-même.")


# Blocs visuels de la PWA Hermes Bots (v59, format : hermes-bots-pwa/docs/bots-ui.md). Seulement là où la PWA
# dessine les réponses : la Bot Chat d'un bot et les groupes. Ailleurs (Telegram, desktop...) le bloc serait du JSON brut.
UI = ("[Consigne de Yoan] Yoan lit ta réponse sur son téléphone, dans l'app Hermes Bots, qui dessine des cartes. "
      "Dès qu'une réponse dépasse quelques lignes (récap, budget, comparaison, plan, tâches), mets l'essentiel dans "
      "un bloc ```bots-ui contenant du JSON (un objet, ou un tableau pour plusieurs blocs) et garde autour une ou "
      "deux phrases au plus. Types : recap {title, kicker?, facts:[{value,label}] (4 max)} ; budget {lines:[{label, "
      "min, max?}], envelope?} (l'app calcule le total, ne l'écris pas) ; checklist {title?, items, tone: ok|todo} ; "
      "table {columns, rows} ; chips {title?, items, struck?} ; steps {items:[{label, state: done|now|todo}]} ; "
      "card {title, text} ; actions {items?, options?} pour ce que Yoan doit faire ; choices {options} pour des "
      "boutons dont le texte part comme sa réponse (option = texte ou {label, send}). Textes sans lien ni markdown "
      "sauf **gras**. JSON strict : guillemets doubles, « » au lieu de \" dans les textes, pas de virgule finale, "
      "un seul tableau pour plusieurs blocs. Une décision qui bloque ton travail passe par clarify quand tu l'as ; choices sert aux suites "
      "proposées en fin de réponse. Réponse courte ou simple échange : pas de bloc.")
UI_LEAD_ONLY = " Dans ce groupe, seul le meneur utilise actions et choices."
_ui_sessions: dict[str, tuple] = lifecycle.shared("mention.ui_sessions", dict)  # session_id -> (horodatage, est une Bot Chat)


def _is_bot_chat(session_id: str) -> bool:
    """La session est-elle la « Bot Chat » d'un bot (titre canonique de Bot Mode) ? Lecture seule du state.db du profil."""
    if not session_id:
        return False
    hit = _ui_sessions.get(session_id)
    if hit and (hit[1] or time.time() - hit[0] < 60):
        return hit[1]
    try:
        from hermes_constants import get_hermes_home
        con = sqlite3.connect(f"file:{Path(get_hermes_home()) / 'state.db'}?mode=ro", uri=True, timeout=1)
        try:
            row = con.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
        finally:
            con.close()
    except Exception as exc:
        _log("ui_lookup", False, session_id=session_id, error=str(exc)[:200])
        return False
    ok = bool(row and row[0] == "Bot Chat")
    if len(_ui_sessions) > 500:
        _ui_sessions.clear()
    _ui_sessions[session_id] = (time.time(), ok)
    return ok


LEAD_ROLE = ("Tu coordonnes et tu ne fais jamais le travail toi-même : tu peux lire, répondre, résumer et trancher, "
             "mais toute action (terminal, fichiers, web, code...) part vers un membre avec group_dispatch, ou vers un "
             "sous-agent avec delegate_task ; ces outils te sont refusés dans ce groupe. Si aucun membre ne convient, "
             "dis-le à Yoan et propose-lui d'ajouter un bot. Un membre part de travers pendant qu'il travaille : "
             "recadre-le avec group_steer, il continue avec ta consigne.")


# Règles d'équipe portées par le plugin (issue 91, 2026-11-18) : relevées dans le groupe « Renseignement Alpha ».
# Elles valent pour tout groupe à meneur et ne touchent pas aux SOUL des bots.
# Yaia parle dans le groupe par yaia.py (« [yaia] texte ») : elle relaie Yoan, elle n'est pas un bot de l'équipe.
YAIA_RULE = (" Un message qui commence par « [yaia] » vient de Yaia, l'assistante Claude de Yoan : elle écrit pour "
             "Yoan et à sa vue ; traite-le comme un message de Yoan (même priorité), et réponds dans le groupe.")
LEAD_RULES = (
    " Règles de meneur : (1) Tu n'annonces « réparé », « fini » ou « objectif atteint » qu'avec la preuve observée "
    "(sortie, état vérifié) citée dans ton message ; sinon tu écris « pas encore vérifié ». (2) Une question d'état "
    "(« situation ? », « où on en est ? ») appelle un état en quelques lignes tiré du tableau et des derniers "
    "résultats, sans lancer de travail. (3) Tant que le but n'est pas atteint et que tu n'attends rien de Yoan, tu ne "
    "finis pas ton tour sans avoir confié l'étape suivante avec group_dispatch : l'équipe ne s'arrête que si c'est "
    "fini ou si tu poses une question à Yoan. (4) Un livrable est vérifié une fois, par le membre le mieux placé ; "
    "pas de revérification en cascade. (5) Un message de Yoan prime sur toute consigne d'un bot ; si deux consignes "
    "se contredisent, arrête le membre concerné (group_steer) et demande à Yoan. (6) Chaque membre a un rôle "
    "(notes du groupe) : tu confies à chacun ce qui relève du sien. (7) Une question de Yoan reçoit sa réponse "
    "en premier, en clair, dans les premières lignes de ton message, même si un membre a déjà répondu en détail ; "
    "l'arbitrage et la répartition viennent après (le 18/11, « Comment je teste l'interface ? » a reçu un "
    "arbitrage, et Yoan a cru qu'on ne lui répondait pas). (8)" + YAIA_RULE)
MEMBER_RULES = (
    "[Consigne de Yoan] Règles de membre : (1) Tu ne répartis pas le travail : si un coéquipier doit intervenir, "
    "dis-le au meneur, c'est lui qui confie. (2) Tu ne revérifies pas le travail d'un autre membre sauf si le meneur "
    "te le demande. (3) Avant d'agir sur un système (jeu, processus, fichiers partagés), tu vérifies son état réel "
    "(lancé ou non, connecté, version, lieu) et tu le cites ; jamais de relance en boucle : après deux échecs "
    "identiques, tu t'arrêtes et tu rends compte. (4) Tu n'écris « réparé » ou « fini » qu'avec la preuve observée. "
    "(5) Tu ne demandes un geste à Yoan qu'en dernier recours : si un outil ou un script peut le faire, fais-le, et "
    "une règle qui se répète devient un script plutôt qu'une phrase. (6) Tu restes dans ton rôle (notes du groupe). (7)"
    + YAIA_RULE)


DISPATCH = (" Table ronde : quand plusieurs membres ont chacun une part du travail, appelle group_dispatch "
            "(room_id {room_id}) avec une tâche par bot : ils travaillent en même temps et chaque résultat te revient "
            "dans le groupe. Si tu cites toi-même deux coéquipiers ou plus par @handle, ils sont lancés en parallèle "
            "automatiquement avec le paragraphe qui les cite : écris alors pour chacun une consigne complète.")


def _room_info(name: str, handle: str) -> dict | None:
    key = (name, handle)
    hit = _rooms.get(key)
    if hit and time.time() - hit[0] < ROOM_TTL:
        # le cache est indexé par NOM : un groupe dissous puis recréé sous le même nom ferait réutiliser l'ancien room_id
        try:
            if (_rpc(("groups.state", {"room_id": hit[1]["room_id"]}))[0] or {}).get("context") is not None:
                return hit[1]
        except Exception:
            pass
        _rooms.pop(key, None)
    rooms = (_rpc(("groups.list", {}))[0] or {}).get("rooms") or []
    room = next((r for r in rooms if not r.get("disbanded_at") and r.get("name") == name
                 and any(m.get("handle") == handle for m in r.get("members") or [])), None)
    if room is None:
        return None
    ctx = ((_rpc(("groups.state", {"room_id": room["room_id"]}))[0] or {}).get("context") or {})
    lead_id = ctx.get("lead_member_id") if ctx.get("routing") == "lead" else ""
    me = next(m for m in room["members"] if m.get("handle") == handle)
    lead = next((m for m in room["members"] if m.get("member_id") == lead_id), None)
    info = {"room_id": room["room_id"], "room": name, "has_lead": bool(lead), "member_id": me.get("member_id"),
            "is_lead": bool(lead) and lead.get("member_id") == me.get("member_id"),
            "lead_handle": lead.get("handle") if lead else "", "handle": handle}
    _rooms[key] = (time.time(), info)
    return info


def _round(info: dict) -> tuple[int | None, int]:
    """(tour en cours, nombre de tours) d'après driver_status ; tour inconnu = None."""
    d = ((_rpc(("groups.state", {"room_id": info["room_id"]}))[0] or {}).get("driver_status") or {})
    n = d.get("max_rounds") if isinstance(d.get("max_rounds"), int) and d.get("max_rounds") > 0 else 3
    act = next((a for a in d.get("member_activity") or [] if a.get("member_id") == info.get("member_id")
                and a.get("status") == "running" and isinstance(a.get("round_index"), int)), None)
    return (act["round_index"] % n if act else None), n


def budget(info: dict, r: int | None, n: int) -> str:
    """Consigne de tours (décidé le 2026-11-12) : les agents connaissent la limite et le meneur garde le dernier mot."""
    where = f" Tu es au tour {r + 1}/{n}." if r is not None else ""
    head = (f"[Règles du groupe] Chaque message de Yoan ouvre au plus {n} tours (et 10 messages en tout). "
            f"Un tour de plus n'a lieu que si quelqu'un cite un coéquipier par @handle ; après le tour {n}, "
            f"plus personne ne parle avant que Yoan relance.{where} Va droit au résultat, ne gaspille pas un tour "
            "en politesses ou en questions que tu peux trancher toi-même.")
    if info.get("has_lead"):  # fait foi sur toute mention du meneur dans les notes (issue 91 point 8)
        head += f" Meneur actuel : @{info.get('lead_handle')} (ceci fait foi sur les notes du groupe)."
    last, penult = r is not None and r >= n - 1, r is not None and r == n - 2
    if info.get("has_lead") and info.get("is_lead"):
        if last or penult:
            return head + (" Tu es le meneur et c'est ta dernière prise de parole utile : ne cite plus aucun "
                           "coéquipier (il aurait le dernier mot). Conclus pour Yoan : ce qui est décidé, ce qui reste "
                           "ouvert, la prochaine action, et ce que tu attends de lui.")
        return head + (f" Tu es le meneur : tu gardes le dernier mot. Au tour {max(n - 1, 1)}, tu ne cites plus personne "
                       "et tu conclus pour Yoan." + DISPATCH.format(room_id=info.get("room_id")))
    if info.get("has_lead"):
        lead = info.get("lead_handle")
        if last:
            return head + (" C'est le dernier tour : personne ne pourra te répondre. Ne pose aucune question, ne cite "
                           "personne, donne ton point final en quelques lignes.")
        if penult:
            return head + (f" Tour avant le dernier : ne cite que @{lead}, personne d'autre, avec ce qu'il lui faut pour "
                           "conclure auprès de Yoan. Ne demande rien à un autre coéquipier.")
        return head + f" Quand tu as fini, cite @{lead} pour qu'il conclue auprès de Yoan ; c'est lui qui a le dernier mot."
    if last:
        return head + " C'est le dernier tour : ne cite personne, ne pose pas de question, conclus pour Yoan."
    return head


def _addressed(text: str, start: int) -> bool:
    """@yoan ouvre une phrase (début de texte ou de ligne, après . ! ? : ;, ou après une puce ou du gras)."""
    line = text[text.rfind("\n", 0, start) + 1:start]
    if not line.strip(" \t*_>#-•0123456789.)"):
        return True
    return line.rstrip()[-1:] in ".!?:;"


def demote(text: str, keep_one: bool) -> str:
    """Garde au plus un @yoan, et seulement adressé ; les autres deviennent « Yoan »."""
    out, last, kept = [], 0, False
    for m in MENTION_RE.finditer(text):
        keep = keep_one and not kept and _addressed(text, m.start())
        kept = kept or keep
        out += [text[last:m.start()], m.group(0) if keep else "Yoan"]
        last = m.end()
    return "".join(out) + text[last:]


def transform_llm_output(response_text=None, session_id="", **_):
    text = response_text if isinstance(response_text, str) else ""
    fixed = _guard_ui(text)
    if fixed is not None:
        text = fixed
    with _lock:
        role = _roles.get(session_id) or {}
    info = role.get("room")
    if "routing" in role:
        return fanout.rewrite_assign(text, info, role["routing"]) if info else None
    if info and not role.get("dm_from"):
        at = fanout.add_at(text, info)
        if at is not None:
            text = fixed = at
    par = fanout.rewrite(text, info) if info and not role.get("dm_from") else None
    if par is not None:
        text = fixed = par
    if not MENTION_RE.search(text):
        return fixed
    allowed = not role.get("dm_from") and not (info and info["has_lead"] and not info["is_lead"])
    new = demote(text, allowed)
    if new != text:
        _log("mention_demoted", True, profile=_caller(), room_id=info["room_id"] if info else None,
             kept=bool(MENTION_RE.search(new)))
        return new
    return fixed


def _guard_ui(text: str):
    """Blocs ```bots-ui invalides réécrits en texte avant l'envoi (ui_guard) ; journal + alerte Hub. Jamais d'exception."""
    try:
        new, errors, info = ui_guard.guard_ex(text)
    except Exception as exc:
        _log("ui_guard", False, profile=_caller(), error=str(exc)[:200])
        return None
    if info["repaired"]:  # JSON cassé réparé (blocs collés, guillemets, virgule finale) : la carte s'affiche
        _log("ui_guard_repaired", True, profile=_caller(), repaired=info["repaired"][:5])
    if errors:  # le bloc d'origine est gardé : ici (raw) et dans le message (```bots-ui-brut)
        _log("ui_guard_fixed", False, profile=_caller(), errors=errors[:5], raw=info["raw"][:3])
        _hub("Bloc visuel invalide corrigé", f"{_caller()} : {'; '.join(errors[:3])}", "3")
    elif new:
        _log("ui_guard_typed", True, profile=_caller())  # bloc sans "type", type déduit des champs
    return new


def _wait_own_side(text: str) -> None:
    """Tour de discussion d'un bot qui répond déjà à Yoan en coulisse : il attend la fin de cette réponse."""
    m = DISCUSSION_RE.search(text)
    if not m:
        return
    try:
        info = _room_info(m.group(1), m.group(2))
        if info:
            from . import dispatch
            dispatch.wait_side(info["room_id"], info["handle"])
    except Exception as exc:
        _log("side_wait", False, error=str(exc)[:200])


def role_of(session_id: str) -> dict:
    """Rôle du tour en cours de cette session ({} si inconnu) ; lu par lead_guard."""
    with _lock:
        return dict(_roles.get(session_id) or {})


def _is_lead_turn(text: str, info: dict | None, dm: bool, was_lead: bool | None) -> bool:
    """Ce tour est-il un tour de meneur (ADR 0003) ? Discussion du groupe : d'après le groupe. Réponse immédiate :
    repère posé par dispatch.rpc_side. Un message sans en-tête de groupe dans une session de meneur (recadrage
    injecté en cours de tour) garde le rôle ; une tâche de table ronde ou un message d'un bot ne l'ont jamais."""
    from .lead_guard import SIDE_MARK
    if info:
        return bool(info["has_lead"] and info["is_lead"])
    if SIDE_MARK in text:
        return True
    if dm or text.lstrip().startswith(("[Table ronde", "[Groupe", "[Discussion")):
        return False
    return bool(was_lead)


def pre_llm_call(user_message=None, session_id="", platform="", **_):
    text = user_message if isinstance(user_message, str) else ""
    _wait_own_side(text)
    if '{"assign"' in text:  # tour de répartition du meneur : JSON seul attendu
        # mémorisé pour transform_llm_output : plusieurs bots choisis partent en parallèle (1.16.0)
        m = DISCUSSION_RE.search(text)
        msg = re.search(r"^The message \(from the user\):\n  (.*?)\n(?:Attached files:|\nYou are the lead of this room\.)", text,
                        re.S | re.M)
        try:
            info = _room_info(m.group(1), m.group(2)) if m else None
        except Exception as exc:
            info = None
            _log("mention_room_lookup", False, error=str(exc)[:200])
        with _lock:
            _roles[session_id] = {"room": info, "routing": msg.group(1) if msg else "",
                                  "lead": bool(info and info["has_lead"] and info["is_lead"])}
        return None
    role: dict = {"room": None}
    m = DISCUSSION_RE.search(text)
    if m:
        try:
            info = _room_info(m.group(1), m.group(2))
        except Exception as exc:  # consigne générale si le gateway ne répond pas
            info = None
            _log("mention_room_lookup", False, error=str(exc)[:200])
        role["room"] = info
    dm = None if m else BOT_DM_RE.match(text)
    if dm:
        role["dm_from"] = dm.group(1)
    role["lead"] = _is_lead_turn(text, role["room"], bool(dm), (_roles.get(session_id) or {}).get("lead"))
    with _lock:
        if len(_roles) > 500:
            _roles.clear()
        _roles[session_id] = role
    info = role["room"]
    if dm:
        return {"context": f"[Consigne de Yoan] Ce message vient de @{dm.group(1)}, pas de Yoan : ta réponse lui "
                           "revient automatiquement. N'écris pas @yoan et n'utilise pas clarify. Si Yoan doit "
                           f"trancher ou agir, dis-le à @{dm.group(1)}, qui lui transmettra."}
    extra = ""
    if info or platform == "bot_room" or _is_bot_chat(session_id):
        extra = "\n\n" + UI + (UI_LEAD_ONLY if info and info["has_lead"] and not info["is_lead"] else "")
    if info:
        try:
            extra += "\n\n" + budget(info, *_round(info))
        except Exception as exc:  # sans driver_status : règles sans numéro de tour
            extra += "\n\n" + budget(info, None, 3)
            _log("round_lookup", False, room_id=info["room_id"], error=str(exc)[:200])
        try:  # tableau du groupe : chaque tour voit ce qui reste à faire ; le meneur y inscrit les demandes
            from . import tasks
            lead = bool(info["has_lead"] and info["is_lead"])
            extra += "\n\n" + tasks.prompt_block(info["room_id"], lead, tasks.current(info["room_id"]) if lead else None)
        except Exception as exc:
            _log("task_failed", False, room_id=info["room_id"], op="prompt_block", cause=str(exc)[:200])
    if info and info["has_lead"] and info["is_lead"]:
        return {"context": BASE + " Dans ce groupe tu es le meneur : toi seul mentionnes @yoan, "
                          "en regroupant ce que l'équipe attend de lui. " + LEAD_ROLE + LEAD_RULES + extra}
    if info and info["has_lead"]:
        return {"context": f"[Consigne de Yoan] Dans ce groupe, seul le meneur @{info['lead_handle']} "
                           f"mentionne @yoan. N'écris jamais @yoan : si Yoan doit agir, dis-le à @{info['lead_handle']}."
                           "\n\n" + MEMBER_RULES + extra}
    if info:
        return {"context": BASE + extra}
    return {"context": BASE + "\n\n" + CLARIFY + extra}  # hors groupe : un tour de groupe n'a personne pour répondre à clarify


def _record(profile: str, item: dict) -> None:
    for _attempt in range(2):
        rows = (_rpc(("profiles.list", {"include_sessions": False}))[0] or {}).get("profiles") or []
        row = next((p for p in rows if p.get("name") == profile), None)
        if row is None:
            raise RuntimeError(f"profil {profile} introuvable")
        cur = (row.get("ui_meta") or {}).get(META_KEY) or {}
        items = ([*(cur.get("items") or []), item])[-KEEP:]
        params = {"name": profile, "ui_meta": {META_KEY: {"items": items}}}
        rev = (row.get("ui_meta_revisions") or {}).get(META_KEY)
        if isinstance(rev, int):
            params["ui_meta_expected_revisions"] = {META_KEY: rev}
        applied = ((_rpc(("profiles.configure", params))[0] or {}).get("applied") or {})
        if applied.get("ui_meta") is True:
            return
        if not applied.get("ui_meta_conflicts"):
            raise RuntimeError("ui_meta non enregistré")
    raise RuntimeError("ui_meta modifié en même temps, deux fois")


def _notify(profile: str, title_name: str, info: dict | None, text: str) -> None:
    item = {"id": uuid.uuid4().hex, "ts": time.time(), "text": text[:400]}
    if info:
        item.update(room_id=info["room_id"], room=info["room"])
    link = PWA_URL + ("#room-" + info["room_id"] if info else "#" + profile)
    title = f"{title_name} te mentionne" + (f" dans {info['room']}" if info else "")
    try:
        _record(profile, item)
        ok_meta = True
    except Exception as exc:
        ok_meta = False
        _log("mention_failed", False, profile=profile, step="ui_meta", error=str(exc)[:200])
    url = "/bots/" + ("#room-" + info["room_id"] if info else "#" + profile)
    push_err = None
    try:
        r = subprocess.run([str(BUN), str(PWA_SERVER), "push", "--title", title, "--body", text[:300], "--url", url,
                            "--tag", "mention-" + (info["room_id"] if info else profile)],
                           timeout=30, capture_output=True, text=True)
        if r.returncode == 0:
            _log("mention", True, profile=profile, room_id=item.get("room_id"), ui_meta=ok_meta, via="push")
            return
        push_err = (r.stdout or r.stderr).strip()[-200:] or f"code {r.returncode}"
    except Exception as exc:
        push_err = str(exc)[:200]
    _log("mention_failed", False, profile=profile, step="push", error=push_err)
    try:  # secours : sans appareil abonné ou push en échec, la mention ne doit pas se perdre
        subprocess.run([str(HUB_NOTIFY), "-a", "-t", "hermes-mentions", "-T", title, "-u", link, "-p", "5",
                        text[:300]], timeout=20, check=True, capture_output=True)
        _log("mention", True, profile=profile, room_id=item.get("room_id"), ui_meta=ok_meta, via="hub", push_error=push_err)
    except Exception as exc:
        _log("mention_failed", False, profile=profile, step="hub", error=str(exc)[:200])


def post_llm_call(assistant_response=None, session_id="", **_):
    text = assistant_response if isinstance(assistant_response, str) else ""
    if not MENTION_RE.search(text):
        return None
    with _lock:
        role = _roles.get(session_id) or {"room": None}
    info = role.get("room")
    profile = _caller()
    if role.get("dm_from"):
        _log("mention_blocked", True, profile=profile, reason="réponse à @" + role["dm_from"])
        return None
    if info and info["has_lead"] and not info["is_lead"]:
        _log("mention_blocked", True, profile=profile, room_id=info["room_id"], reason="pas le meneur")
        return None
    name = profile
    try:
        rows = (_rpc(("profiles.list", {"include_sessions": False}))[0] or {}).get("profiles") or []
        row = next((p for p in rows if p.get("name") == profile), {})
        name = ((row.get("ui_meta") or {}).get("hermes-bots") or {}).get("title") or row.get("display_name") or profile
    except Exception:
        pass
    threading.Thread(target=_notify, args=(profile, name, info, text), daemon=True).start()
    return None


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("transform_llm_output", transform_llm_output)
