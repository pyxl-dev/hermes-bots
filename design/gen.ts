// Génère les 10 artboards « nuit et personnages » (inspiration Grok Bot + Dots).
import { writeFileSync } from "fs";
const OUT = import.meta.dir + "/project/";

type Kind = "drop" | "round" | "block" | "ghost";
const BOTS = {
  yaia: { name: "Yaia", color: "#8B93FF", kind: "drop" as Kind },
  rea: { name: "Réa", color: "#4FD1A5", kind: "round" as Kind },
  hh: { name: "hermes-hard", color: "#FF8E4F", kind: "block" as Kind },
  def: { name: "default", color: "#C4C4C4", kind: "ghost" as Kind },
};
type B = keyof typeof BOTS;
const E = "#0A0A0A";

function body(kind: Kind, c: string) {
  switch (kind) {
    case "drop":
      return `<path d="M32 7c13 0 23 11 23 26 0 14-10 24-23 24S9 47 9 33C9 18 19 7 32 7z" fill="${c}"/><rect x="23.5" y="27" width="5.5" height="12" rx="2.75" fill="${E}"/><rect x="35" y="27" width="5.5" height="12" rx="2.75" fill="${E}"/>`;
    case "round":
      return `<circle cx="17" cy="16" r="7" fill="${c}"/><circle cx="47" cy="16" r="7" fill="${c}"/><circle cx="32" cy="35" r="23" fill="${c}"/><circle cx="25" cy="34" r="4" fill="${E}"/><circle cx="39" cy="34" r="4" fill="${E}"/><path d="M28 43q4 3 8 0" stroke="${E}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    case "block":
      return `<rect x="30.5" y="3" width="3" height="9" rx="1.5" fill="${c}"/><circle cx="32" cy="4" r="3.5" fill="${c}"/><rect x="9" y="12" width="46" height="45" rx="15" fill="${c}"/><rect x="16" y="26" width="32" height="11" rx="5.5" fill="${E}"/><circle cx="25" cy="31.5" r="2.4" fill="${c}"/><circle cx="39" cy="31.5" r="2.4" fill="${c}"/>`;
    case "ghost":
      return `<path d="M10 33a22 22 0 0 1 44 0v23l-7.3-5-7.3 5-7.4-5-7.3 5-7.4-5L10 56z" fill="${c}"/><rect x="23" y="27" width="6" height="6" rx="3" fill="${E}"/><rect x="35" y="27" width="6" height="6" rx="3" fill="${E}"/>`;
  }
}
const m = (b: B, s: number, colorOverride?: string, kindOverride?: Kind) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true" style="display:block;flex:none">${body(kindOverride ?? BOTS[b].kind, colorOverride ?? BOTS[b].color)}</svg>`;

// Avatar rond teinté ; ring = halo « travaille »
function av(b: B, s: number, ring = false) {
  const c = BOTS[b].color;
  const glow = ring ? `;box-shadow:0 0 0 2px ${E},0 0 0 4px ${c},0 0 18px ${c}88` : "";
  return `<span style="width:${s}px;height:${s}px;border-radius:50%;background:radial-gradient(circle at 50% 30%,${c}40,${c}14 70%);display:flex;align-items:center;justify-content:center;flex:none${glow}">${m(b, Math.round(s * 0.68))}</span>`;
}
// Avatar de groupe : mascottes qui se chevauchent
function gav(bs: B[], s: number) {
  const k = Math.round(s * 0.66);
  const pos = [
    [0, 0],
    [s - k, s - k],
  ];
  return `<span style="width:${s}px;height:${s}px;position:relative;flex:none">${bs
    .slice(0, 2)
    .map((b, i) => `<span style="position:absolute;left:${pos[i][0]}px;top:${pos[i][1]}px;width:${k}px;height:${k}px;border-radius:50%;background:linear-gradient(${BOTS[b].color}30,${BOTS[b].color}30),#161616;box-shadow:0 0 0 2.5px ${E};display:flex;align-items:center;justify-content:center">${m(b, Math.round(k * 0.74))}</span>`)
    .join("")}</span>`;
}

const I = (d: string, s = 22, w = 1.9) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ic = {
  back: I(`<path d="m15 5-7 7 7 7"/>`),
  close: I(`<path d="M6 6l12 12M18 6 6 18"/>`),
  plus: I(`<path d="M12 5v14M5 12h14"/>`, 20, 2.2),
  sliders: I(`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`),
  search: I(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`, 18, 2),
  mic: I(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>`, 20),
  up: I(`<path d="M12 19V5M6 11l6-6 6 6"/>`, 20, 2.4),
  more: I(`<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>`, 22, 2.2),
  chev: I(`<path d="m9 6 6 6-6 6"/>`, 16, 2.2),
  chevD: I(`<path d="m6 9 6 6 6-6"/>`, 16, 2.2),
  chevU: I(`<path d="m6 15 6-6 6 6"/>`, 18, 2.2),
  check: I(`<path d="m5 12 5 5 9-10"/>`, 14, 3),
  copy: I(`<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>`),
  share: I(`<path d="M12 15V4M7 8l5-4 5 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>`),
  speak: I(`<path d="M4 10v4h4l5 4V6L8 10H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>`),
  quote: I(`<path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6"/>`),
  link: I(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`, 18, 2),
  attach: I(`<path d="M12 5v14M5 12h14"/>`, 20, 2),
};

const CSS = `body{margin:0}
.scr{width:390px;height:844px;box-sizing:border-box;background:#0A0A0A;color:#fff;font-family:Inter,sans-serif;display:flex;flex-direction:column;overflow:hidden;position:relative}
.ib{width:44px;height:44px;border:0;background:none;color:#fff;display:flex;align-items:center;justify-content:center;border-radius:50%;padding:0;flex:none;text-decoration:none}
.pill{height:44px;border-radius:9999px;background:#fff;color:#0A0A0A;font:500 15px Inter,sans-serif;padding:0 22px;border:0;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;box-sizing:border-box;flex:none}
.pill.g{background:#1F1F1F;color:#fff}
.pill.s{height:36px;font-size:13px;padding:0 14px}
.card{background:#161616;border-radius:28px}
.cap{font:500 12px Inter,sans-serif;color:#7A7A7A;letter-spacing:.02em}
.sect{font:500 13px Inter,sans-serif;color:#8A8A8A;margin:0;padding:20px 20px 10px}
.row{display:flex;align-items:center;gap:14px;padding:10px 20px;text-decoration:none;color:inherit}
.nm{font:500 16px Inter,sans-serif;color:#fff;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm{font:400 12px Inter,sans-serif;color:#6B6B6B}
.pv{font:400 14px Inter,sans-serif;color:#8A8A8A;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.txt{font:400 15px/1.55 Inter,sans-serif;color:#EDEDED;margin:0}
.me{align-self:flex-end;max-width:78%;background:#1F1F1F;border-radius:22px 22px 6px 22px;padding:11px 15px;font:400 15px/1.45 Inter,sans-serif}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.comp{margin:0 12px 18px;background:#1A1A1A;border-radius:28px;min-height:56px;display:flex;align-items:center;gap:2px;padding:6px;box-sizing:border-box}
.comp .ph{flex:1;font:400 16px Inter,sans-serif;color:#6B6B6B;padding:0 6px}
.send{width:44px;height:44px;border-radius:50%;border:0;background:#fff;color:#0A0A0A;display:flex;align-items:center;justify-content:center;flex:none}
.sheet{background:#161616;border-radius:28px 28px 0 0;padding:10px 18px 26px;box-sizing:border-box}
.grab{width:40px;height:4px;border-radius:2px;background:#3A3A3A;margin:0 auto 16px}
a{color:#fff}a:hover{color:#D6D6D6}`;

function page(title: string, inner: string) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap">
<style>
${CSS}
</style>
</helmet>
${inner}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":390,"height":844}}'>
class Component extends DCLogic {
renderVals() { return {}; }
}
</script>
</body>
</html>
`;
}

const glowTop = (c: string, strength = "38") =>
  `<div aria-hidden="true" style="position:absolute;left:-60px;right:-60px;top:-160px;height:340px;background:radial-gradient(closest-side,${c}${strength},${c}00);pointer-events:none"></div>`;

const composer = (ph: string, extra = "", sendBtn = `<button class="send" type="button" aria-label="Envoyer">${ic.up}</button>`) =>
  `<div class="comp">${extra || `<button class="ib" type="button" aria-label="Joindre" style="color:#A3A3A3">${ic.attach}</button>`}<span class="ph">${ph}</span><button class="ib" type="button" aria-label="Dicter" style="color:#A3A3A3">${ic.mic}</button>${sendBtn}</div>`;

const chatHeader = (b: B, sub: string, subColor = "#7A7A7A", ring = false, href = "Main.dc.html", gear = "BotSettings.dc.html") =>
  `<header style="position:relative;display:flex;align-items:center;gap:10px;padding:12px 8px 8px 4px">
    <a class="ib" href="${href}" aria-label="Retour">${ic.back}</a>
    ${av(b, 38, ring)}
    <a href="${gear}" style="flex:1;min-width:0;text-decoration:none;display:flex;flex-direction:column;gap:2px"><span style="font:500 17px Inter,sans-serif;color:#fff">${BOTS[b].name}</span><span style="font:400 12px Inter,sans-serif;color:${subColor}">${sub}</span></a>
    <a class="ib" href="MsgActions.dc.html" aria-label="Rechercher dans le fil">${ic.search}</a>
    <a class="ib" href="${gear}" aria-label="Réglages du bot">${ic.more}</a>
  </header>`;

const files: Record<string, string> = {};

// ── 1. Liste ──
const tile = (inner: string, name: string, c: string, href: string, extra = "", border = "") =>
  `<a href="${href}" style="position:relative;width:110px;height:132px;border-radius:26px;background:linear-gradient(165deg,${c}3A,#161616 72%);${border}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-decoration:none;color:#fff;flex:none;box-sizing:border-box">${inner}<span style="font:500 13px Inter,sans-serif;max-width:94px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>${extra}</a>`;
files["Main"] = page(
  "Liste des bots",
  `<div class="scr">
  <header style="display:flex;align-items:center;gap:6px;padding:18px 12px 6px 20px">
    <h1 style="margin:0;flex:1;font:500 30px Inter,sans-serif;letter-spacing:-0.025em">Bots</h1>
    <span style="display:flex;align-items:center;gap:6px;font-size:12px;color:#8A8A8A;margin-right:2px"><span style="width:7px;height:7px;border-radius:50%;background:#4ADE80"></span>en ligne</span>
    <a class="ib" href="Teams.dc.html" aria-label="Réglages">${ic.sliders}</a>
    <a class="ib" href="NewGroup.dc.html" aria-label="Nouveau groupe" style="background:#fff;color:#0A0A0A;width:40px;height:40px">${ic.plus}</a>
  </header>
  <div style="padding:8px 16px 0">
    <label style="display:flex;align-items:center;gap:10px;height:46px;padding:0 16px;border-radius:9999px;background:#161616;color:#7A7A7A">${ic.search}<input type="search" placeholder="Rechercher un bot ou un groupe" aria-label="Rechercher" style="flex:1;border:0;background:none;color:#fff;font:400 15px Inter,sans-serif;outline:none"></label>
  </div>
  <h2 class="sect">Épinglés</h2>
  <div style="display:flex;gap:10px;padding:0 16px">
    ${tile(m("hh", 54), "hermes-hard", BOTS.hh.color, "ChatBusy.dc.html", `<span style="position:absolute;top:12px;left:12px;width:8px;height:8px;border-radius:50%;background:${BOTS.hh.color};box-shadow:0 0 10px ${BOTS.hh.color}"></span>`, `box-shadow:inset 0 0 0 1.5px ${BOTS.hh.color}99;`)}
    ${tile(gav(["yaia", "rea", "hh"], 58), "Prépa cours", "#B7A6FF", "Group.dc.html", `<span style="position:absolute;top:10px;right:10px;font:600 11px Inter,sans-serif;background:#fff;color:#0A0A0A;border-radius:9999px;padding:3px 7px">@1</span>`)}
    ${tile(m("yaia", 54), "Yaia", BOTS.yaia.color, "Chat.dc.html", `<span style="position:absolute;top:12px;right:12px;width:8px;height:8px;border-radius:50%;background:#fff"></span>`)}
  </div>
  <p style="margin:8px 20px 0;font:400 12px Inter,sans-serif;color:${BOTS.hh.color}">hermes-hard travaille · lecture de 3 fichiers</p>
  <h2 class="sect">Conversations</h2>
  <div style="flex:1;overflow:hidden">
    <a class="row" href="Chat.dc.html">${av("rea", 50)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px"><span style="display:flex;gap:8px;align-items:center"><span class="nm">Réa</span><span class="tm">mer.</span></span><span style="display:flex;gap:8px;align-items:center"><span class="pv" style="color:#fff">attend ta réponse</span><span style="width:8px;height:8px;border-radius:50%;background:#fff"></span></span></span></a>
    <a class="row" href="Group.dc.html">${gav(["yaia", "rea", "hh"], 50)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px"><span style="display:flex;gap:8px;align-items:center"><span class="nm">Veille IA</span><span class="tm">hier</span></span><span class="pv">Yaia, Réa, hermes-hard</span></span></a>
    <a class="row" href="Chat.dc.html">${av("def", 50)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px"><span style="display:flex;gap:8px;align-items:center"><span class="nm">default</span><span class="tm">lun.</span></span><span class="pv">Bot généraliste</span></span></a>
  </div>
  <p style="margin:0;padding:10px 20px 24px;font-size:12px;color:#6B6B6B;text-align:center">Appui long sur un bot ou un groupe pour l'épingler</p>
</div>`
);

// ── 2. Chat ──
files["Chat"] = page(
  "Chat",
  `<div class="scr">
  ${glowTop(BOTS.hh.color, "26")}
  ${chatHeader("hh", "Opus 5.5 · prêt")}
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:14px;padding:6px 18px 12px">
    <div class="cap" style="text-align:center">Aujourd'hui</div>
    <div class="me">Regarde pourquoi la PWA recharge quand je reviens dessus</div>
    <div class="tm" style="align-self:flex-end;margin-top:-8px">21:40 · lu</div>
    <button type="button" style="align-self:flex-start;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 12px 0 10px;border-radius:9999px;background:#141414;border:1px solid #262626;color:#A3A3A3;font:400 12px 'JetBrains Mono',monospace">${m("hh", 18)}4 outils · lecture, recherche ${ic.chevD}</button>
    <div style="display:flex;flex-direction:column;gap:8px">
      <p class="txt">Deux causes, dans l'ordre :</p>
      <p class="txt"><span style="color:#7A7A7A">1.</span> <span class="mono" style="font-size:13px;background:#1A1A1A;border-radius:6px;padding:1px 5px">openBot</span> vide le fil puis attend le serveur.</p>
      <p class="txt"><span style="color:#7A7A7A">2.</span> Android tue la PWA en arrière-plan, et elle repart sur la liste.</p>
      <p class="txt">Je garde les 60 derniers messages sur le téléphone et je rouvre le dernier chat.</p>
      <span class="tm">21:42</span>
    </div>
    <div class="card" style="padding:16px;border-radius:24px;background:linear-gradient(170deg,${BOTS.hh.color}1F,#161616 55%)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">${m("hh", 22)}<span style="font:500 14px Inter,sans-serif">Accord demandé</span></div>
      <div class="mono" style="background:#0A0A0A;border-radius:14px;padding:12px 14px;font-size:13px;color:#EDEDED">git push origin main</div>
      <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
        <button class="pill s" type="button">Autoriser</button>
        <button class="pill g s" type="button">Toujours</button>
        <span style="flex:1"></span>
        <button type="button" style="border:0;background:none;color:#FF6B5E;font:500 14px Inter,sans-serif;height:36px;padding:0 6px">Refuser</button>
      </div>
    </div>
  </div>
  ${composer("Écris à hermes-hard")}
</div>`
);

// ── 3. Chat, bot au travail ──
const spin = (c: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#2A2A2A" stroke-width="3" fill="none"/><path d="M12 3a9 9 0 0 1 9 9" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
files["ChatBusy"] = page(
  "Chat, bot au travail",
  `<div class="scr">
  ${glowTop(BOTS.hh.color, "4A")}
  ${chatHeader("hh", "travaille · 1 min 12 s", BOTS.hh.color, true)}
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:14px;padding:8px 18px 10px">
    <div class="me">Ajoute l'épinglage des groupes et teste sur le mock</div>
    <div class="mono" style="display:flex;flex-direction:column;gap:9px;font-size:12.5px;color:#A3A3A3;padding:2px 0 0 2px">
      <span style="display:flex;gap:10px;align-items:center"><span style="color:#4ADE80">${ic.check}</span>read_file app/groups.js</span>
      <span style="display:flex;gap:10px;align-items:center"><span style="color:#4ADE80">${ic.check}</span>edit app/groups.js <span style="color:#4ADE80">+14</span> <span style="color:#FF6B5E">−2</span></span>
      <span style="display:flex;gap:10px;align-items:center;color:#fff">${spin(BOTS.hh.color)}terminal node --check app.js</span>
    </div>
    <p class="txt">Le tri des groupes reprend celui des bots, je vérifie la syntaxe avant de lancer le mock<span style="display:inline-block;width:9px;height:17px;border-radius:2px;background:${BOTS.hh.color};vertical-align:-3px;margin-left:3px"></span></p>
    <div style="align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
      <div class="me" style="background:none;border:1.5px dashed #3A3A3A;color:#A3A3A3">Et commite après</div>
      <span class="tm">en file, part après ce tour</span>
    </div>
    <span style="flex:1"></span>
    <div class="card" style="border-radius:22px;padding:6px">
      ${[
        ["/compact", "résume et allège le contexte"],
        ["/model", "change le modèle de ce chat"],
        ["/undo", "retire le dernier échange"],
      ]
        .map(
          ([c, d], i) =>
            `<div style="display:flex;align-items:baseline;gap:12px;padding:11px 12px;border-radius:16px;${i === 0 ? "background:#1F1F1F" : ""}"><span class="mono" style="font-size:13px;color:#fff;width:76px">${c}</span><span style="font:400 13px Inter,sans-serif;color:#8A8A8A">${d}</span></div>`
        )
        .join("")}
    </div>
    <div style="display:flex;align-items:center;gap:10px"><span style="flex:1;font:400 12px Inter,sans-serif;color:#7A7A7A">Entrée met en file, ou guide-le tout de suite</span><button class="pill g s" type="button">Guider</button></div>
  </div>
  <div class="comp"><button class="ib" type="button" aria-label="Joindre" style="color:#A3A3A3">${ic.attach}</button><span class="ph" style="color:#fff">/</span><button class="send" type="button" aria-label="Arrêter" style="background:#fff"><span style="width:14px;height:14px;border-radius:3px;background:#0A0A0A"></span></button></div>
</div>`
);

// ── 4. Groupe ──
const gmsg = (b: B, time: string, text: string, lead = false) =>
  `<div style="display:flex;gap:10px">${av(b, 30)}<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;margin:4px 0 4px"><span style="font:500 14px Inter,sans-serif;color:${BOTS[b].color}">${BOTS[b].name}</span>${lead ? `<span style="font:500 10px Inter,sans-serif;color:#0A0A0A;background:${BOTS[b].color};border-radius:9999px;padding:2px 7px">meneur</span>` : ""}<span class="tm">${time}</span></div><p class="txt">${text}</p></div></div>`;
files["Group"] = page(
  "Groupe",
  `<div class="scr">
  <div aria-hidden="true" style="position:absolute;left:-80px;right:-80px;top:-170px;height:320px;background:radial-gradient(closest-side at 30% 50%,${BOTS.yaia.color}30,transparent),radial-gradient(closest-side at 70% 50%,${BOTS.rea.color}24,transparent)"></div>
  <header style="position:relative;display:flex;align-items:center;gap:10px;padding:12px 8px 8px 4px">
    <a class="ib" href="Main.dc.html" aria-label="Retour">${ic.back}</a>
    ${gav(["yaia", "rea", "hh"], 40)}
    <a href="GroupSettings.dc.html" style="flex:1;min-width:0;text-decoration:none;display:flex;flex-direction:column;gap:2px"><span style="font:500 17px Inter,sans-serif;color:#fff">Prépa cours</span><span style="font:400 12px Inter,sans-serif;color:#7A7A7A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Yaia, Réa, hermes-hard · meneur Yaia</span></a>
    <a class="ib" href="GroupSettings.dc.html" aria-label="Réglages du groupe">${ic.more}</a>
  </header>
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:16px;padding:8px 18px 12px;position:relative">
    <div class="me">Préparez le TP Docker de jeudi, 3 h, niveau BTS2</div>
    ${gmsg("yaia", "21:32", "Réa découpe le TP en jalons, hermes-hard vérifie les commandes sur une vraie machine.", true)}
    ${gmsg("rea", "21:38", "4 jalons de 40 min, chacun avec un livrable. Jalon 3 : un docker compose à deux services.")}
    ${gmsg("yaia", "21:41", `<span style="background:#FFFFFF24;border-radius:6px;padding:1px 5px;font-weight:600;color:#fff">@yoan</span> le jalon 4 dépasse de 15 min. On coupe le bonus ou on garde ?`, true)}
  </div>
  <div style="margin:0 12px 10px;display:flex;align-items:center;gap:10px;background:#161616;border-radius:9999px;padding:6px 6px 6px 8px">
    ${av("hh", 30, true)}
    <span style="flex:1;font:400 13px Inter,sans-serif;color:#A3A3A3"><b style="font-weight:500;color:${BOTS.hh.color}">hermes-hard</b> répond · tour 2 sur 5</span>
    <button class="pill g s" type="button">Arrêter</button>
  </div>
  ${composer("Message au groupe")}
</div>`
);

// ── 5. Recherche + actions ──
const hit = (t: string, cur = false) =>
  `<mark style="background:${cur ? "#fff" : "#FFFFFF2E"};color:${cur ? "#0A0A0A" : "#fff"};border-radius:4px;padding:0 2px">${t}</mark>`;
files["MsgActions"] = page(
  "Actions et recherche",
  `<div class="scr">
  <header style="display:flex;align-items:center;gap:6px;padding:12px 10px 8px 4px">
    <a class="ib" href="Chat.dc.html" aria-label="Fermer la recherche">${ic.close}</a>
    <label style="flex:1;display:flex;align-items:center;gap:8px;height:44px;padding:0 14px;border-radius:9999px;background:#161616;color:#7A7A7A">${ic.search}<input value="docker" aria-label="Rechercher dans le fil" style="flex:1;min-width:0;border:0;background:none;color:#fff;font:400 15px Inter,sans-serif;outline:none"><span style="font:500 12px Inter,sans-serif;color:#A3A3A3;white-space:nowrap">2 sur 5</span></label>
    <button class="ib" type="button" aria-label="Précédent">${ic.chevU}</button>
    <button class="ib" type="button" aria-label="Suivant" style="transform:rotate(180deg)">${ic.chevU}</button>
  </header>
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:14px;padding:10px 18px">
    <div class="me">Le TP ${hit("docker")} de jeudi est prêt ?</div>
    <p class="txt">Oui : 4 jalons, un ${hit("docker", true)} compose à deux services au jalon 3.</p>
  </div>
  <div aria-hidden="true" style="position:absolute;inset:0;background:#000000A6"></div>
  <div class="sheet" style="position:absolute;left:0;right:0;bottom:0">
    <div class="grab"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">${m("hh", 20)}<span class="cap">hermes-hard · 21:42</span></div>
    <p class="txt" style="background:#0A0A0A;border-radius:18px;padding:14px 16px;font-size:14px;color:#D6D6D6">Oui : 4 jalons de 40 min, un docker compose à deux services au jalon 3, et un bonus en fin de séance.</p>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:18px">
      ${[
        [ic.copy, "Copier"],
        [ic.share, "Partager"],
        [ic.speak, "Lire"],
        [ic.quote, "Citer"],
      ]
        .map(
          ([i, l]) =>
            `<button type="button" style="border:0;background:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:8px;font:500 12px Inter,sans-serif;padding:0"><span style="width:58px;height:58px;border-radius:50%;background:#1F1F1F;display:flex;align-items:center;justify-content:center">${i}</span>${l}</button>`
        )
        .join("")}
    </div>
  </div>
</div>`
);

// ── 6. Réglages du bot (fiche façon Grok Bot + personnalisation façon Dots) ──
const SWATCH = ["#FF8E4F", "#8B93FF", "#4FD1A5", "#FF7AB6", "#F5C84B", "#C4C4C4"];
const KINDS: Kind[] = ["block", "drop", "round", "ghost"];
files["BotSettings"] = page(
  "Réglages du bot",
  `<div class="scr">
  <div style="position:relative;margin:10px 12px 0;height:176px;border-radius:30px;overflow:hidden;background:linear-gradient(140deg,${BOTS.hh.color}8C,${BOTS.hh.color}2E);display:flex;align-items:center;justify-content:center">
    <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(closest-side,${BOTS.hh.color}66,transparent)"></div>
    <a class="ib" href="Chat.dc.html" aria-label="Retour" style="position:absolute;top:8px;left:8px;background:#0A0A0A66">${ic.back}</a>
    <span style="position:relative">${m("hh", 92)}</span>
  </div>
  <div style="text-align:center;padding:16px 20px 0">
    <h1 style="margin:0;font:500 26px Inter,sans-serif;letter-spacing:-0.02em">hermes-hard</h1>
    <div style="font:400 13px Inter,sans-serif;color:#7A7A7A;margin-top:4px">profil technique hermes-hard</div>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:12px"><span class="pill g s">Opus 5.5</span><span class="pill g s">effort medium</span></div>
  </div>
  <div style="flex:1;overflow:hidden;padding:0 16px">
    <h2 class="sect" style="padding-left:4px">Personnaliser</h2>
    <div class="card" style="padding:16px;border-radius:24px">
      <div style="display:flex;justify-content:space-between">${SWATCH.map((c, i) => `<button type="button" aria-label="Couleur" style="width:36px;height:36px;border-radius:50%;border:0;background:${c};${i === 0 ? "box-shadow:0 0 0 3px #161616,0 0 0 5px #fff" : ""}"></button>`).join("")}</div>
      <div style="display:flex;justify-content:space-between;margin-top:16px">${KINDS.map((k, i) => `<button type="button" aria-label="Personnage" style="width:68px;height:62px;border-radius:18px;background:#0A0A0A;border:${i === 0 ? "1.5px solid #fff" : "1.5px solid #262626"};display:flex;align-items:center;justify-content:center">${m("hh", 40, BOTS.hh.color, k)}</button>`).join("")}</div>
    </div>
    <h2 class="sect" style="padding-left:4px">Tâches planifiées · 3</h2>
    <div class="card" style="border-radius:24px">
      ${[
        ["Veille IA du matin", "chaque jour à 7 h 41 · prochaine demain", ""],
        ["Relance des factures", "lundi à 9 h 12 · prochaine dans 2 j", ""],
        ["Sauvegarde du wiki", "en pause", "pause"],
      ]
        .map(
          ([t, s, p], i) =>
            `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;${i ? "border-top:1px solid #222" : ""}"><span style="flex:1;min-width:0"><span style="display:block;font:500 15px Inter,sans-serif">${t}</span><span style="display:block;font:400 12px Inter,sans-serif;color:#7A7A7A;margin-top:2px">${s}</span></span>${p ? `<span style="font:500 11px Inter,sans-serif;color:#A3A3A3;background:#1F1F1F;border-radius:9999px;padding:4px 9px">en pause</span>` : `<span style="color:#5A5A5A">${ic.chev}</span>`}</div>`
        )
        .join("")}
    </div>
  </div>
  <div style="padding:14px 16px 24px"><button class="pill" type="button" style="width:100%;height:52px">Enregistrer</button></div>
</div>`
);

// ── 7. Réglages du groupe ──
const field = (label: string, val: string, h = 48) =>
  `<label style="display:block;margin-bottom:10px"><span class="cap" style="display:block;margin:0 4px 6px">${label}</span><span style="display:block;background:#161616;border-radius:18px;padding:13px 16px;min-height:${h}px;box-sizing:border-box;font:400 15px/1.45 Inter,sans-serif;color:#EDEDED">${val}</span></label>`;
files["GroupSettings"] = page(
  "Réglages du groupe",
  `<div class="scr">
  <header style="display:flex;align-items:center;gap:6px;padding:12px 16px 4px 4px">
    <a class="ib" href="Group.dc.html" aria-label="Retour">${ic.back}</a>
    <h1 style="margin:0;flex:1;font:500 22px Inter,sans-serif">Réglages du groupe</h1>
  </header>
  <div style="flex:1;overflow:hidden;padding:10px 16px 0">
    ${field("Nom", "Prépa cours")}
    ${field("But du groupe", "Préparer les TP et les supports BTS2, prêts à projeter.", 70)}
    ${field("Notes partagées", "Séances de 3 h, élèves sur Windows, pas de droits admin.", 70)}
    <span class="cap" style="display:block;margin:8px 4px 8px">Qui répond</span>
    <div style="display:flex;background:#161616;border-radius:9999px;padding:4px">${["Tout le monde", "Un meneur", "Auto"].map((t, i) => `<button type="button" style="flex:1;height:40px;border:0;border-radius:9999px;font:500 14px Inter,sans-serif;${i === 1 ? "background:#fff;color:#0A0A0A" : "background:none;color:#A3A3A3"}">${t}</button>`).join("")}</div>
    <span class="cap" style="display:block;margin:18px 4px 10px">Meneur et membres</span>
    <div style="display:flex;gap:12px">
      ${(["yaia", "rea", "hh", "def"] as B[])
        .map((b, i) => {
          const inG = i < 3;
          return `<button type="button" style="border:0;background:none;padding:0;display:flex;flex-direction:column;align-items:center;gap:6px;width:72px;color:${inG ? "#fff" : "#5A5A5A"};font:500 12px Inter,sans-serif;opacity:${inG ? 1 : 0.55}"><span style="position:relative;border-radius:50%;${i === 0 ? "box-shadow:0 0 0 2px #0A0A0A,0 0 0 4px #fff" : ""}">${av(b, 56)}${i === 0 ? `<span style="position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);font:600 9px Inter,sans-serif;background:#fff;color:#0A0A0A;border-radius:9999px;padding:2px 6px">meneur</span>` : ""}</span><span style="max-width:72px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${BOTS[b].name}</span></button>`;
        })
        .join("")}
    </div>
    <p style="margin:14px 4px 0;font:400 12px/1.45 Inter,sans-serif;color:#6B6B6B">Changer les membres recrée le groupe : but, notes et routage sont recopiés, avec un résumé des derniers échanges.</p>
  </div>
  <div style="padding:12px 16px 22px;display:flex;flex-direction:column;gap:6px;align-items:center">
    <button class="pill" type="button" style="width:100%;height:52px">Enregistrer</button>
    <button type="button" style="border:0;background:none;color:#FF6B5E;font:500 14px Inter,sans-serif;height:44px">Supprimer le groupe</button>
  </div>
</div>`
);

// ── 8. Nouveau groupe (grille de personnages façon Dots) ──
files["NewGroup"] = page(
  "Nouveau groupe",
  `<div class="scr" style="background:#000;justify-content:flex-end">
  <div role="dialog" aria-label="Nouveau groupe" class="sheet" style="height:740px;display:flex;flex-direction:column">
    <div class="grab"></div>
    <div style="display:flex;align-items:center;margin-bottom:16px">
      <h2 style="margin:0;flex:1;font:500 22px Inter,sans-serif">Nouveau groupe</h2>
      <a href="Main.dc.html" style="font:500 15px Inter,sans-serif;color:#A3A3A3;text-decoration:none;padding:10px 4px">Annuler</a>
    </div>
    <input value="Veille IA" maxlength="80" aria-label="Nom du groupe" style="height:52px;border:1.5px solid #fff;background:#0A0A0A;color:#fff;border-radius:9999px;padding:0 20px;font:500 16px Inter,sans-serif;outline:none">
    <div style="display:flex;align-items:baseline;margin:22px 4px 12px"><span style="flex:1" class="cap">Membres</span><span style="font:500 12px Inter,sans-serif;color:#fff">2 sur 10 au plus</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;align-content:start">
      ${(["yaia", "rea", "hh", "def"] as B[])
        .map((b) => {
          const on = b === "yaia" || b === "hh";
          const c = BOTS[b].color;
          return `<button type="button" aria-pressed="${on}" style="position:relative;height:150px;border-radius:24px;border:${on ? "1.5px solid #fff" : "1.5px solid transparent"};background:linear-gradient(165deg,${c}${on ? "40" : "1C"},#1A1A1A 75%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff;font:500 14px Inter,sans-serif">${m(b, 58)}${BOTS[b].name}<span style="position:absolute;top:12px;right:12px;width:24px;height:24px;border-radius:50%;${on ? "background:#fff;color:#0A0A0A" : "border:1.5px solid #3A3A3A"};display:flex;align-items:center;justify-content:center;box-sizing:border-box">${on ? ic.check : ""}</span></button>`;
        })
        .join("")}
    </div>
    <a href="Group.dc.html" class="pill" style="height:54px;width:100%">Créer le groupe</a>
  </div>
</div>`
);

// ── 9. Réglages ──
const card = (rows: string[]) =>
  `<div class="card" style="border-radius:24px">${rows.map((r, i) => `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px 12px 18px;min-height:60px;box-sizing:border-box;${i ? "border-top:1px solid #222" : ""}">${r}</div>`).join("")}</div>`;
const lbl = (t: string, s: string) =>
  `<span style="flex:1;min-width:0"><span style="display:block;font:500 15px Inter,sans-serif">${t}</span><span style="display:block;font:400 12px/1.4 Inter,sans-serif;color:#7A7A7A;margin-top:2px">${s}</span></span>`;
const step = (v: string) =>
  `<div style="display:flex;align-items:center;background:#0A0A0A;border-radius:9999px;flex:none"><button type="button" aria-label="Moins" style="width:40px;height:40px;border:0;background:none;color:#fff;font:500 20px Inter,sans-serif">−</button><span style="min-width:28px;text-align:center;font:500 15px Inter,sans-serif">${v}</span><button type="button" aria-label="Plus" style="width:40px;height:40px;border:0;background:none;color:#fff;font:500 20px Inter,sans-serif">+</button></div>`;
files["Teams"] = page(
  "Réglages",
  `<div class="scr">
  <header style="display:flex;align-items:center;gap:6px;padding:12px 16px 0 4px">
    <a class="ib" href="Main.dc.html" aria-label="Retour">${ic.back}</a>
    <h1 style="margin:0;flex:1;font:500 26px Inter,sans-serif;letter-spacing:-0.02em">Réglages</h1>
  </header>
  <div style="flex:1;overflow:hidden;padding:0 16px">
    <h2 class="sect" style="padding-left:4px">Notifications sur cet appareil</h2>
    ${card([
      lbl("Mentions @yoan", "Envoyées par Bots, plus par Hub") +
        `<button type="button" role="switch" aria-checked="true" aria-label="Notifications des mentions" style="width:52px;height:32px;border-radius:16px;border:0;background:#fff;position:relative;flex:none"><span style="position:absolute;top:3px;right:3px;width:26px;height:26px;border-radius:50%;background:#0A0A0A"></span></button>`,
      lbl("Ce téléphone", "Abonné aux notifications") + `<button class="pill g s" type="button">Tester</button>`,
    ])}
    <h2 class="sect" style="padding-left:4px">Équipes</h2>
    ${card([lbl("Bots par groupe", "au plus, de 2 à 16") + step("10"), lbl("Tours de discussion", "de 1 à 10") + step("5"), lbl("Messages par discussion", "au plus, de 2 à 200") + step("50")])}
    <p style="margin:10px 4px 0;font:400 12px/1.45 Inter,sans-serif;color:#6B6B6B">Une discussion s'arrête au premier plafond atteint. Les nouvelles valeurs valent dès la prochaine discussion.</p>
    <h2 class="sect" style="padding-left:4px">Épingles</h2>
    ${card([lbl("Synchronisées", "3 épingles, partagées entre tes appareils") + `<span style="width:8px;height:8px;border-radius:50%;background:#4ADE80"></span>`])}
  </div>
  <div style="padding:12px 16px 24px"><button class="pill" type="button" style="width:100%;height:52px">Enregistrer les équipes</button></div>
</div>`
);

// ── 10. Partager vers un bot ──
files["NotifShare"] = page(
  "Partager vers un bot",
  `<div class="scr" style="background:#000;justify-content:flex-end">
  <div role="dialog" aria-label="Partager vers un bot" class="sheet">
    <div class="grab"></div>
    <h2 style="margin:0 0 14px;font:500 22px Inter,sans-serif">Partager vers…</h2>
    <div style="background:#0A0A0A;border-radius:20px;padding:12px 14px;display:flex;gap:12px;align-items:center">
      <span style="width:42px;height:42px;border-radius:12px;background:#1F1F1F;display:flex;align-items:center;justify-content:center;color:#A3A3A3;flex:none">${ic.link}</span>
      <span style="flex:1;min-width:0"><span style="display:block;font:500 14px Inter,sans-serif">Docker Compose : bien démarrer</span><span style="display:block;font:400 12px Inter,sans-serif;color:#7A7A7A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">docs.docker.com/compose/gettingstarted</span></span>
    </div>
    <div class="cap" style="margin:22px 4px 12px">Épinglés</div>
    <div style="display:flex;gap:4px">
      ${[
        [av("hh", 62), "hermes-hard", "Chat.dc.html"],
        [gav(["yaia", "rea", "hh"], 62), "Prépa cours", "Group.dc.html"],
        [av("yaia", 62), "Yaia", "Chat.dc.html"],
      ]
        .map(([a, n, h]) => `<a href="${h}" style="width:84px;display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;color:#fff;font:500 12px Inter,sans-serif">${a}<span style="max-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${n}</span></a>`)
        .join("")}
    </div>
    <div class="cap" style="margin:20px 4px 6px">Tous</div>
    ${[
      [av("rea", 42), "Réa", "", "Chat.dc.html"],
      [gav(["yaia", "rea", "hh"], 42), "Veille IA", "groupe", "Group.dc.html"],
      [av("def", 42), "default", "", "Chat.dc.html"],
    ]
      .map(([a, n, t, h], i) => `<a href="${h}" style="display:flex;align-items:center;gap:14px;min-height:60px;padding:6px 4px;${i ? "border-top:1px solid #222;" : ""}text-decoration:none;color:#fff">${a}<span style="flex:1;font:500 15px Inter,sans-serif">${n}</span><span style="font-size:12px;color:#7A7A7A">${t}</span></a>`)
      .join("")}
    <p style="margin:14px 0 0;font-size:12px;color:#6B6B6B;text-align:center">Le texte arrive dans le composeur, tu relis avant d'envoyer</p>
  </div>
</div>`
);

for (const [k, v] of Object.entries(files)) writeFileSync(OUT + k + ".dc.html", v);
console.log("ok", Object.keys(files).length);
