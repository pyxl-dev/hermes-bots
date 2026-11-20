// Rendu markdown d'un message : marked (GFM) nettoyé par DOMPurify, blocs ```bots-ui dessinés par l'app,
// @yoan en pastille, sections « **Titre.** ». Résultat mis en cache par texte : un fil rouvert ou redessiné ne reparse rien.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { UiBlocks } from "./blocks";

const PURIFY = { FORBID_TAGS: ["style", "form", "input", "button", "iframe"], FORBID_ATTR: ["style"] };
const ME_RE = /(^|[^\w@.])(@yoan)\b/gi;

function markMentions(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement!.closest("code, pre, a") || !/@yoan\b/i.test(n.nodeValue || "") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const v = n.nodeValue || "";
    v.replace(ME_RE, (m, pre, at, i) => {
      frag.append(v.slice(last, i + pre.length));
      const s = document.createElement("span");
      s.className = "mention-me";
      s.textContent = at;
      frag.append(s);
      last = i + m.length;
      return m;
    });
    frag.append(v.slice(last));
    n.replaceWith(frag);
  }
}

function render(text: string) {
  const html = UiBlocks.split(text)
    .map((p: any) => p.html ?? DOMPurify.sanitize(marked.parse(p.md, { gfm: true, breaks: true, async: false }) as string, PURIFY))
    .join("");
  const box = document.createElement("div");
  box.innerHTML = html;
  for (const a of box.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const t of box.querySelectorAll("table")) {
    if (t.parentElement!.classList.contains("tbl")) continue;
    const w = document.createElement("div");
    w.className = "tbl";
    t.replaceWith(w);
    w.appendChild(t);
  }
  markMentions(box);
  UiBlocks.sections(box);
  return box.innerHTML;
}

// Cache LRU borné : clé = texte complet. Les morceaux de streaming ne passent pas ici (voir mdStream).
const CACHE = new Map<string, string>(),
  CACHE_MAX = 600;
export function md(src: string) {
  const text = String(src || "");
  const hit = CACHE.get(text);
  if (hit !== undefined) {
    CACHE.delete(text);
    CACHE.set(text, hit);
    return hit;
  }
  const html = render(text);
  CACHE.set(text, html);
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
  return html;
}
/** Rendu d'un texte qui grandit : pas de mise en cache (chaque état ne sert qu'une fois). */
export const mdStream = (src: string) => render(String(src || ""));
export const hasMention = (text: string) => /(^|[^\w@.])@yoan\b/i.test(text);

// Texte d'un groupe (peut venir d'une autre machine) : ni images ni liens locaux, seulement des liens http(s) publics.
const INERT = new Map<string, string>();
export function inertMd(src: string) {
  const text = String(src || "");
  const hit = INERT.get(text);
  if (hit !== undefined) return hit;
  const box = document.createElement("div");
  box.innerHTML = md(text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image: $1]").replace(/^MEDIA:.*$/gm, "[fichier]"));
  for (const img of box.querySelectorAll("img")) img.replaceWith(document.createTextNode("[image]"));
  for (const a of box.querySelectorAll("a")) {
    let ok = false;
    try {
      const u = new URL(a.getAttribute("href")!, location.href);
      ok =
        /^https?:$/.test(u.protocol) &&
        !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(u.hostname) &&
        !u.hostname.endsWith(".ts.net");
    } catch {}
    if (ok) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    } else a.replaceWith(document.createTextNode(a.textContent || ""));
  }
  const html = box.innerHTML;
  INERT.set(text, html);
  if (INERT.size > 600) INERT.delete(INERT.keys().next().value!);
  return html;
}
