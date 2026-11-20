import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Liste de la coquille hors ligne, écrite au build : sw.js la lit par importScripts('shell.js').
const PUBLIC = readdirSync(root + "public").filter((f) => f !== "sw.js" && f !== "shell.js");
const shell = (): Plugin => ({
  name: "shell-list",
  apply: "build",
  generateBundle(_o, bundle) {
    const files = ["./", "index.html", ...PUBLIC, ...Object.keys(bundle).filter((f) => f !== "index.html")];
    this.emitFile({ type: "asset", fileName: "shell.js", source: "self.SHELL = " + JSON.stringify(files) + ";\n" });
  },
});

export default defineConfig({
  root,
  base: "./",
  plugins: [solid(), shell()],
  build: { outDir: "../app", emptyOutDir: true, target: "es2022", sourcemap: false, modulePreload: { polyfill: false } },
  server: { port: 5173 },
});
