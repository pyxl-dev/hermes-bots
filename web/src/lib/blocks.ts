// Blocs visuels des bots (```bots-ui) : format décrit dans docs/bots-ui.md. Port fidèle de l'ancien app/blocks.js.
// @ts-nocheck
import { esc, report } from "./util";
const tx = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");

// ---------- validation ----------
// Les longueurs et nombres d'éléments indiqués aux bots sont des repères de mise en page, pas des refus : un texte
// trop long passe à la ligne (le 2026-11-15, un récap aux étiquettes de 57 à 82 signes s'affichait en JSON brut).
// Seuls un JSON illisible, un type inconnu ou un champ manquant ou du mauvais type rendent un bloc invalide.
const HARD = 4000;
/** @param {any} v @param {number} [_max] */
const isStr = (v, _max) => typeof v === "string" && v.trim() !== "" && v.length <= HARD;
/** @param {any} v @param {number} [_max] */
const optStr = (v, _max) => v === undefined || v === null || v === "" || isStr(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9;
const list = (v, min, max, f) => Array.isArray(v) && v.length >= Math.min(min, 1) && v.length <= Math.max(max, 50) && v.every(f);
const option = (o) => isStr(o, 60) || (o && isStr(o.label, 60) && optStr(o.send, 500));
const item = (i) => isStr(i, 300) || (i && isStr(i.text, 300) && (i.done === undefined || typeof i.done === "boolean"));
const TYPES = {
  recap: (b) =>
    isStr(b.title, 80) &&
    optStr(b.kicker, 40) &&
    optStr(b.note, 300) &&
    (b.facts === undefined || list(b.facts, 1, 4, (f) => f && isStr(f.value, 24) && optStr(f.label, 40))),
  budget: (b) =>
    optStr(b.title, 60) &&
    optStr(b.currency, 4) &&
    optStr(b.note, 300) &&
    (b.envelope === undefined || isNum(b.envelope)) &&
    list(b.lines, 1, 20, (l) => l && isStr(l.label, 60) && isNum(l.min) && (l.max === undefined || (isNum(l.max) && l.max >= l.min))),
  checklist: (b) => optStr(b.title, 60) && (b.tone === undefined || ["ok", "todo", "neutral"].includes(b.tone)) && list(b.items, 1, 20, item),
  chips: (b) => optStr(b.title, 60) && (b.struck === undefined || typeof b.struck === "boolean") && list(b.items, 1, 30, (c) => isStr(c, 40)),
  table: (b) =>
    optStr(b.title, 60) &&
    list(b.columns, 1, 6, (c) => isStr(c, 40)) &&
    list(
      b.rows,
      1,
      30,
      (r) => Array.isArray(r) && r.length === b.columns.length && r.every((c) => (typeof c === "string" && c.length <= HARD) || typeof c === "number")
    ),
  steps: (b) =>
    optStr(b.title, 60) &&
    list(b.items, 2, 8, (s) => s && isStr(s.label, 60) && optStr(s.note, 120) && (s.state === undefined || ["done", "now", "todo"].includes(s.state))),
  card: (b) => isStr(b.title, 60) && isStr(b.text, 2000),
  actions: (b) =>
    optStr(b.title, 60) &&
    (b.items === undefined || list(b.items, 1, 10, item)) &&
    (b.options === undefined || list(b.options, 1, 4, option)) &&
    (b.items !== undefined || b.options !== undefined),
  choices: (b) => optStr(b.prompt, 200) && list(b.options, 1, 6, option),
};
// Bloc sans "type" (oubli du bot, 2026-11-15) : on prend le premier type dont il remplit les champs.
const GUESS = ["recap", "table", "budget", "steps", "choices", "checklist", "card", "chips", "actions"];
const withType = (b) => {
  if (!b || typeof b !== "object" || Array.isArray(b) || b.type !== undefined) return b;
  const t = GUESS.find((k) => TYPES[k] && TYPES[k]({ ...b, type: k }));
  return t ? { ...b, type: t } : b;
};
function parse(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { error: "JSON illisible : " + e.message };
  }
  const blocks = (Array.isArray(v) ? v : Array.isArray(v?.blocks) ? v.blocks : [v]).map(withType);
  if (!blocks.length || blocks.length > 12) return { error: "entre 1 et 12 blocs" };
  // chaque bloc est jugé seul : un bloc invalide n'empêche pas les autres de s'afficher
  const errors = [];
  blocks.forEach((b, i) => {
    if (!b || typeof b !== "object" || !TYPES[b.type]) errors[i] = `bloc ${i + 1} : type inconnu ${JSON.stringify(b?.type)}`;
    else if (!TYPES[b.type](b)) errors[i] = `bloc ${i + 1} (${b.type}) : champs invalides`;
  });
  if (blocks.every((_, i) => errors[i])) return { error: errors.filter(Boolean).join(" ; ") };
  return { blocks, errors };
}

// ---------- rendu ----------
const money = (n, cur) => n.toLocaleString("fr-FR") + " " + cur;
const range = (a, b, cur) => (a === b ? money(a, cur) : `${a.toLocaleString("fr-FR")} à ${money(b, cur)}`);
const head = (title, tone) => (title ? `<div class="ui-h"${tone ? ` data-tone="${tone}"` : ""}><i></i>${esc(title)}</div>` : "");
function buttons(options) {
  return (
    '<div class="ui-btns">' +
    options
      .map((o, i) => {
        const label = typeof o === "string" ? o : o.label,
          say = typeof o === "string" ? o : o.send || o.label;
        return `<button type="button" class="ui-choice${i ? " g" : ""}" data-say="${esc(say)}">${esc(label)}</button>`;
      })
      .join("") +
    "</div>"
  );
}
function items(arr, defDone) {
  return (
    '<ul class="ui-ck">' +
    arr
      .map((i) => {
        const t = typeof i === "string" ? i : i.text,
          done = typeof i === "string" ? defDone : (i.done ?? defDone);
        return `<li class="${done ? "done" : ""}"><span class="ui-mk"></span><span>${tx(t)}</span></li>`;
      })
      .join("") +
    "</ul>"
  );
}
const R = {
  recap: (b) =>
    `<div class="ui ui-recap">${b.kicker ? `<div class="ui-k">${esc(b.kicker)}</div>` : ""}<div class="ui-t">${esc(b.title)}</div>` +
    (b.facts
      ? `<div class="ui-facts n${b.facts.length}">` +
        b.facts.map((f) => `<div><b>${esc(f.value)}</b>${f.label ? `<span>${esc(f.label)}</span>` : ""}</div>`).join("") +
        "</div>"
      : "") +
    (b.note ? `<div class="ui-note">${tx(b.note)}</div>` : "") +
    "</div>",
  budget(b) {
    const cur = b.currency || "€",
      lines = b.lines.map((l) => [l.label, l.min, l.max ?? l.min]);
    const lo = lines.reduce((s, l) => s + l[1], 0),
      hi = lines.reduce((s, l) => s + l[2], 0);
    const top = Math.max(...lines.map((l) => l[2]), 1);
    let h =
      `<div class="ui ui-card">${head(b.title || "Budget", "acc")}<div class="ui-bud">` +
      lines
        .map(
          ([n, a, z]) =>
            `<div class="ui-bl"><span>${esc(n)}</span><b>${range(a, z, cur)}</b><div class="ui-tr"><i style="left:${((a / top) * 100).toFixed(1)}%;width:max(4px,${(((z - a) / top) * 100).toFixed(1)}%)"></i></div></div>`
        )
        .join("") +
      `</div><div class="ui-tot"><span>Total</span><b>${range(lo, hi, cur)}</b></div>`;
    if (b.envelope !== undefined) {
      const scale = Math.max(hi, b.envelope) * 1.15 || 1,
        over = hi - b.envelope;
      h +=
        `<div class="ui-gauge"><div class="band${over > 0 ? " over" : ""}" style="left:${((lo / scale) * 100).toFixed(1)}%;width:max(4px,${(((hi - lo) / scale) * 100).toFixed(1)}%)"></div><div class="env" style="left:${((b.envelope / scale) * 100).toFixed(1)}%"></div></div>` +
        `<div class="ui-gl"><span>enveloppe ${money(b.envelope, cur)}</span><span class="${over > 0 ? "warn" : "okc"}">${over > 0 ? (lo > b.envelope ? "dépassée de " + money(lo - b.envelope, cur) + " au moins" : "haut de fourchette : +" + money(over, cur)) : "tient dans l'enveloppe"}</span></div>`;
    }
    return h + (b.note ? `<div class="ui-note">${tx(b.note)}</div>` : "") + "</div>";
  },
  checklist: (b) =>
    `<div class="ui ui-card${b.tone === "todo" ? " ui-todo" : ""}">${head(b.title, b.tone || "ok")}${items(b.items, b.tone !== "todo" && b.tone !== "neutral")}</div>`,
  chips: (b) =>
    `<div class="ui ui-card">${head(b.title)}<div class="ui-chips${b.struck ? " x" : ""}">${b.items.map((c) => `<span>${esc(c)}</span>`).join("")}</div></div>`,
  table: (b) =>
    `<div class="ui ui-card">${head(b.title)}<div class="tbl"><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
    b.rows.map((r) => "<tr>" + r.map((c) => `<td>${esc(typeof c === "number" ? c.toLocaleString("fr-FR") : c)}</td>`).join("") + "</tr>").join("") +
    "</tbody></table></div></div>",
  steps: (b) =>
    `<div class="ui ui-card">${head(b.title)}<ol class="ui-steps">${b.items.map((s) => `<li class="${s.state || "todo"}"><b>${esc(s.label)}</b>${s.note ? `<span>${esc(s.note)}</span>` : ""}</li>`).join("")}</ol></div>`,
  card: (b) => `<div class="ui ui-card">${head(b.title)}<div class="ui-p">${tx(b.text)}</div></div>`,
  actions: (b) =>
    `<div class="ui ui-card ui-todo">${head(b.title || "À toi de jouer", "todo")}${b.items ? items(b.items, false) : ""}${b.options ? buttons(b.options) : ""}</div>`,
  choices: (b) => `<div class="ui ui-choices">${b.prompt ? `<div class="ui-p">${tx(b.prompt)}</div>` : ""}${buttons(b.options)}</div>`,
};
function render(raw) {
  const p = parse(raw);
  if (p.error) {
    try {
      report("bots-ui", p.error, "blocks.js");
    } catch {}
    return `<pre class="ui-bad" title="${esc(p.error)}"><code>${esc(raw)}</code></pre>`;
  }
  return p.blocks
    .map((b, i) => {
      if (!p.errors[i]) return R[b.type](b);
      try {
        report("bots-ui", p.errors[i], "blocks.js");
      } catch {}
      return `<pre class="ui-bad" title="${esc(p.errors[i])}"><code>${esc(JSON.stringify(b, null, 1))}</code></pre>`;
    })
    .join("");
}

// Découpe un message : morceaux markdown { md } et blocs déjà rendus { html }.
// Un bloc ouvert mais pas encore fermé (réponse en cours) devient « mise en forme… ».
// Le bot oublie parfois l'étiquette : un bloc ``` ou ```json dont le contenu est un bloc valide est rendu aussi.
// ```bots-ui-brut : bloc d'origine que le plugin n'a pas pu lire (ui_guard.py), replié sous « voir le brut ».
const FENCE = /^[ \t]*```(bots-ui-brut|bots-ui|json)?[^\n]*\n([\s\S]*?)\n?[ \t]*```[ \t]*$/gm;
const brut = (raw) => `<details class="ui ui-raw"><summary>Carte illisible, voir le brut</summary><pre><code>${esc(raw)}</code></pre></details>`;
const looksUi = (raw) => /^\s*[{[]/.test(raw) && !parse(raw).error;
function split(text) {
  if (!text.includes("```")) return [{ md: text }];
  const out = [];
  let last = 0,
    m;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text))) {
    if (!m[1]?.startsWith("bots-ui") && !looksUi(m[2])) continue;
    if (m.index > last) out.push({ md: text.slice(last, m.index) });
    out.push({ html: m[1] === "bots-ui-brut" ? brut(m[2]) : render(m[2]) });
    last = FENCE.lastIndex;
  }
  const rest = text.slice(last),
    open = rest.search(/^[ \t]*```bots-ui(?![\w-])/m);
  if (open >= 0) {
    if (open > 0) out.push({ md: rest.slice(0, open) });
    out.push({ html: '<div class="ui ui-pending">mise en forme…</div>' });
  } else if (rest) out.push({ md: rest });
  return out;
}

// Mise en page du markdown ordinaire : des paragraphes qui commencent par « **Titre.** » deviennent des cartes
// (au moins deux dans le message) ; un paragraphe qui mentionne @yoan devient la carte « À toi de jouer ».
export function lead(el) {
  if (el.tagName !== "P") return null;
  const f = el.firstChild?.nodeType === 3 && !el.firstChild.nodeValue.trim() ? el.firstChild.nextSibling : el.firstChild;
  if (f?.tagName !== "STRONG") return null;
  const t = f.textContent.trim();
  const after = f.nextSibling?.nodeType === 3 ? f.nextSibling.nodeValue : "";
  if (t.length > 60) return null;
  if (/[.:]$/.test(t) || /^\s*[.:]/.test(after) || (!f.nextSibling && el.nextElementSibling)) return { f, t: t.replace(/[.:]\s*$/, "") };
  return null;
}
function sections(box) {
  const kids = [...box.children];
  const heads = kids.filter((k) => lead(k));
  if (heads.length < 2) {
    if (kids.length >= 3) for (const k of kids) if (k.tagName === "P" && k.querySelector(".mention-me")) wrap(box, [k], "À toi de jouer", true);
    return;
  }
  let cur = null;
  for (const k of kids) {
    const l = lead(k);
    if (l) {
      l.f.remove();
      const n = k.firstChild;
      if (n?.nodeType === 3) n.nodeValue = n.nodeValue.replace(/^\s*[.:]?\s*/, "");
      if (k.firstChild?.tagName === "BR") k.firstChild.remove();
      cur = wrap(box, [k], l.t, !!k.querySelector(".mention-me"));
      if (!k.textContent.trim() && !k.querySelector("img, code")) k.remove();
    } else if (k.classList.contains("ui") || /^H[1-6]$/.test(k.tagName) || k.tagName === "HR") cur = null;
    else if (k.tagName === "P" && k.querySelector(".mention-me")) cur = wrap(box, [k], "À toi de jouer", true);
    else if (cur) cur.append(k);
  }
}
function wrap(box, els, title, me) {
  const s = document.createElement("div");
  s.className = "ui-sec" + (me ? " ui-me" : "");
  const h = document.createElement("div");
  h.className = "ui-sec-t";
  h.textContent = title;
  els[0].before(s);
  s.append(h, ...els);
  return s;
}

export const UiBlocks = { split, render, sections, parse };
