"""Garde des blocs ```bots-ui avant l'envoi (hook transform_llm_output).

La PWA Hermes Bots dessine ces blocs en cartes ; un bloc qu'elle ne sait pas lire s'affichait en JSON brut
(2026-11-15). Ici, chaque bloc est vérifié avec les mêmes règles de structure que app/blocks.js (types et champs
requis ; les longueurs ne sont que des repères). Un bloc invalide est réécrit en texte lisible avant d'arriver à
Yoan, l'événement est journalisé et Hub est alerté : le bot ne voit pas d'erreur.

JSON cassé (2026-11-16 : 27 blocs de deepseek-v4.1-flash devenus « (bloc illisible) », contenu perdu) : on répare
d'abord (blocs collés sans [...], guillemets non échappés dans un texte). Sinon on garde toutes les chaînes du
brouillon, et le bloc d'origine part avec dans un bloc ```bots-ui-brut que la PWA replie sous « voir le brut » :
rien ne se perd plus.
"""
from __future__ import annotations

import json
import re

FENCE = re.compile(r"^([ \t]*)```bots-ui(?![\w-])[^\n]*\n([\s\S]*?)\n?[ \t]*```[ \t]*$", re.M)

_s = lambda v: isinstance(v, str) and v.strip() != ""
_opt = lambda v: v is None or v == "" or _s(v)
_num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v < 1e9


def _lst(v, f, lo=1):
    return isinstance(v, list) and lo <= len(v) <= 50 and all(f(x) for x in v)


def _option(o):
    return _s(o) or (isinstance(o, dict) and _s(o.get("label")) and _opt(o.get("send")))


def _item(i):
    return _s(i) or (isinstance(i, dict) and _s(i.get("text")) and (i.get("done") is None or isinstance(i.get("done"), bool)))


def _row(cols):
    return lambda r: isinstance(r, list) and len(r) == cols and all(isinstance(c, (str, int, float)) for c in r)


TYPES = {
    "recap": lambda b: _s(b.get("title")) and _opt(b.get("kicker")) and _opt(b.get("note"))
    and (b.get("facts") is None or _lst(b["facts"], lambda f: isinstance(f, dict) and _s(f.get("value")) and _opt(f.get("label")))),
    "budget": lambda b: _opt(b.get("title")) and _opt(b.get("currency")) and (b.get("envelope") is None or _num(b["envelope"]))
    and _lst(b.get("lines"), lambda l: isinstance(l, dict) and _s(l.get("label")) and _num(l.get("min"))
             and (l.get("max") is None or (_num(l["max"]) and l["max"] >= l["min"]))),
    "checklist": lambda b: _opt(b.get("title")) and b.get("tone") in (None, "ok", "todo", "neutral") and _lst(b.get("items"), _item),
    "chips": lambda b: _opt(b.get("title")) and _lst(b.get("items"), _s),
    "table": lambda b: _opt(b.get("title")) and _lst(b.get("columns"), _s) and _lst(b.get("rows"), _row(len(b.get("columns") or []))),
    "steps": lambda b: _opt(b.get("title")) and _lst(b.get("items"), lambda s: isinstance(s, dict) and _s(s.get("label"))
                                                     and _opt(s.get("note")) and s.get("state") in (None, "done", "now", "todo")),
    "card": lambda b: _s(b.get("title")) and _s(b.get("text")),
    "actions": lambda b: _opt(b.get("title")) and (b.get("items") is not None or b.get("options") is not None)
    and (b.get("items") is None or _lst(b["items"], _item)) and (b.get("options") is None or _lst(b["options"], _option)),
    "choices": lambda b: _opt(b.get("prompt")) and _lst(b.get("options"), _option),
}


_GUESS = ("recap", "table", "budget", "steps", "choices", "checklist", "card", "chips", "actions")


def _with_type(b):
    """Bloc sans "type" (oubli du bot, 2026-11-15) : premier type dont il remplit les champs."""
    if not isinstance(b, dict) or "type" in b:
        return b
    for t in _GUESS:
        if TYPES[t]({**b, "type": t}):
            return {**b, "type": t}
    return b


def _orig(raw: str) -> list:
    v = json.loads(raw)
    return v if isinstance(v, list) else v["blocks"] if isinstance(v, dict) and isinstance(v.get("blocks"), list) else [v]


def _seq(raw: str):
    """Plusieurs valeurs JSON collées ({...}{...} ou {...},{...}) : leur liste, sinon ValueError."""
    dec, i, out = json.JSONDecoder(), 0, []
    while True:
        while i < len(raw) and raw[i] in " \t\r\n,":
            i += 1
        if i >= len(raw):
            break
        v, i = dec.raw_decode(raw, i)
        out.extend(v if isinstance(v, list) else [v])
    if len(out) < 2:
        raise ValueError("une seule valeur")
    return out


def _quotes(raw: str) -> str:
    """Échappe les " d'un texte qui ne ferment pas la chaîne (suivis d'autre chose que , : } ] ou fin)."""
    out, ins, i = [], False, 0
    while i < len(raw):
        c = raw[i]
        if ins and c == "\\":
            out.append(raw[i:i + 2])
            i += 2
            continue
        if c == '"':
            if not ins:
                ins = True
            else:
                j = i + 1
                while j < len(raw) and raw[j] in " \t":
                    j += 1
                if j >= len(raw) or raw[j] in ",:}]\n\r":
                    ins = False
                else:
                    c = '\\"'
        elif ins and c == "\n":
            c = "\\n"
        out.append(c)
        i += 1
    return "".join(out)


def _commas(raw: str) -> str:
    """Virgule finale avant } ou ] (« Expecting property name ») retirée."""
    return re.sub(r",(\s*[}\]])", r"\1", raw)


def _load(raw: str):
    """(valeur, réparation) : le JSON tel quel, ou réparé ; ValueError (celle d'origine) si rien ne marche."""
    try:
        return json.loads(raw), None
    except ValueError as first:
        err = first
    for name, txt in (("brut", raw), ("guillemets", _quotes(raw)), ("virgule finale", _commas(raw)),
                      ("guillemets et virgule finale", _commas(_quotes(raw)))):
        for how, fn in (("", json.loads), ("blocs collés, ", _seq)):
            try:
                return fn(txt), f"{how}{name} ({err})".replace("brut (", "(").replace(", (", " (")
            except ValueError:
                pass
    raise err


def check(raw: str):
    """(blocs, erreurs) : erreurs[i] dit pourquoi le bloc i est invalide ; blocs vaut None si le JSON est illisible."""
    return check_ex(raw)[:2]


def check_ex(raw: str):
    """(blocs, erreurs, réparation ou None)."""
    try:
        v, fix = _load(raw)
    except ValueError as exc:
        return None, [f"JSON illisible : {exc}"], None
    blocks = v if isinstance(v, list) else v.get("blocks") if isinstance(v, dict) and isinstance(v.get("blocks"), list) else [v]
    blocks = [_with_type(b) for b in blocks]
    errors = []
    for i, b in enumerate(blocks):
        if not isinstance(b, dict) or b.get("type") not in TYPES:
            errors.append(f"bloc {i + 1} : type inconnu {json.dumps(b.get('type') if isinstance(b, dict) else None)}")
        elif not TYPES[b["type"]](b):
            errors.append(f"bloc {i + 1} ({b['type']}) : champs invalides")
        else:
            errors.append(None)
    return blocks, errors, fix


_TEXT_KEYS = ("title", "kicker", "prompt", "value", "label", "text", "note", "send")


def _plain(node, out: list, depth=0):
    """Texte lisible d'un bloc qu'on ne sait pas dessiner : ses chaînes utiles, en puces."""
    if isinstance(node, dict):
        parts = [str(node[k]).strip() for k in _TEXT_KEYS if isinstance(node.get(k), (str, int, float)) and str(node[k]).strip()]
        if parts:
            out.append("  " * depth + "- " + " : ".join(parts[:2]) + ("" if len(parts) <= 2 else " (" + ", ".join(parts[2:]) + ")"))
        for k, v in node.items():
            if isinstance(v, (list, dict)):
                _plain(v, out, depth + (1 if parts else 0))
    elif isinstance(node, list):
        for x in node:
            if isinstance(x, list):
                out.append("  " * depth + "- " + " | ".join(str(c) for c in x))
            elif isinstance(x, (str, int, float)):
                out.append("  " * depth + "- " + str(x))
            else:
                _plain(x, out, depth)


_STR = r'"((?:[^"\\\n]|\\.)*)"'
_ROW = re.compile(r'\[\s*(?:%s|-?\d[\d.]*)(?:\s*,\s*(?:%s|-?\d[\d.]*))+\s*\]' % (_STR, _STR))
_ENUM = set(TYPES) | {"ok", "todo", "neutral", "done", "now"}


def _unq(s: str) -> str:
    try:
        return json.loads(f'"{s}"')
    except ValueError:
        return s.replace('\\"', '"')


def _salvage(raw: str) -> str:
    """JSON illisible : toutes les valeurs texte du brouillon, dans l'ordre ; une ligne de tableau reste une ligne."""
    out: list[str] = []
    pos = 0
    for m in re.finditer(r'%s|%s' % (_ROW.pattern, _STR), raw):
        if m.start() < pos:
            continue
        pos = m.end()
        tok = m.group(0)
        if tok.startswith("["):
            cells = re.findall(r'%s|(-?\d[\d.]*)' % _STR, tok)
            out.append("- " + " | ".join(_unq(a) if a else b for a, b in cells))
            continue
        if re.match(r"\s*:", raw[m.end():]):  # une clé, pas une valeur
            continue
        v = _unq(tok[1:-1]).strip()
        if v and v not in _ENUM:
            out.append("- " + v)
    return "\n".join(out)


def _brut(indent: str, raw: str) -> str:
    """Le bloc d'origine, que la PWA replie sous « voir le brut » : jamais perdu."""
    return f"{indent}```bots-ui-brut\n{raw.strip()}\n{indent}```"


def guard(text: str):
    """(texte corrigé ou None si rien à changer, liste des erreurs trouvées)."""
    return guard_ex(text)[:2]


def guard_ex(text: str):
    """(texte corrigé ou None, erreurs, détail) ; détail = {"repaired": [...], "raw": [blocs bruts réécrits]}."""
    if "```bots-ui" not in text:
        return None, [], {"repaired": [], "raw": []}
    found: list[str] = []
    typed: list[bool] = []
    info: dict = {"repaired": [], "raw": []}

    def fix(m):
        indent, raw = m.group(1), m.group(2)
        blocks, errors, repaired = check_ex(raw)
        bad = [e for e in errors if e]
        if repaired:
            info["repaired"].append(repaired)
        if not bad:
            if repaired or any(isinstance(b, dict) and b.get("type") and "type" not in o for b, o in zip(blocks, _orig(raw))):
                typed.append(True)
                return f"{indent}```bots-ui\n{json.dumps(blocks, ensure_ascii=False)}\n{indent}```"
            return m.group(0)
        found.extend(bad)
        info["raw"].append(raw[:4000])
        if blocks is None:
            return "\n\n".join(x for x in (_salvage(raw), _brut(indent, raw)) if x)
        good = [b for b, e in zip(blocks, errors) if not e]
        out = []
        if good:
            out.append(f"{indent}```bots-ui\n{json.dumps(good, ensure_ascii=False)}\n{indent}```")
        lines: list[str] = []
        for b, e in zip(blocks, errors):
            if e:
                _plain(b, lines)
        if lines:
            out.append("\n".join(lines))
        out.append(_brut(indent, raw))
        return "\n\n".join(out)

    new = FENCE.sub(fix, text)
    return (new if found or typed else None), found, info
