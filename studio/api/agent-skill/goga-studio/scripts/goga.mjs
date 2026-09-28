#!/usr/bin/env node
// Cliente do Goga Studio para agentes externos (Claude Code, Codex, Gemini CLI).
// Chama as MESMAS ferramentas do Assistente interno pela API
// (/api/v1/agent/*), autenticado por um token de API pessoal. Sem dependencias:
// so Node >= 18.
//
//   curl -fsSL <studio>/skills/goga.mjs | node - instalar    (instala + login)
//   goga.mjs login [--url <studio>]         autoriza no navegador e guarda o token
//   goga.mjs configurar --url <studio> --token goga_...   (alternativa manual)
//   goga.mjs eu
//   goga.mjs guia
//   goga.mjs ferramentas [nome]
//   goga.mjs chamar <ferramenta> ['{"json":...}' | @arquivo.json | -] [--confirmar]
//   goga.mjs anexar <arquivo...>              sobe arquivos locais e devolve os fileIds
//
// URL e token: variaveis GOGA_STUDIO_URL / GOGA_STUDIO_TOKEN ou o arquivo
// ~/.config/goga-studio/config.json (gravado por `configurar`, modo 600).

import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, lstatSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

// Preenchido pelo Studio ao servir este arquivo (GET /skills/goga.mjs).
const EMBEDDED_URL = null;

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "goga-studio", "config.json");

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function readConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    /* sem arquivo: so variaveis de ambiente */
  }
  const url = (process.env.GOGA_STUDIO_URL || file.url || EMBEDDED_URL || "http://localhost:8787").replace(/\/+$/, "");
  const token = process.env.GOGA_STUDIO_TOKEN || file.token;
  return { url, token };
}

async function api(method, p, body) {
  const { url, token } = readConfig();
  if (!token) die(`Sem token. Rode:\n  node ${selfPath()} login\n(abre o Studio no navegador para você autorizar)`);
  let res;
  try {
    res = await fetch(`${url}/api/v1${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    die(`Studio inacessível em ${url}: ${err.cause?.code ?? err.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function selfPath() {
  return process.argv[1] && process.argv[1] !== "-" ? process.argv[1] : "~/.agents/skills/goga-studio/scripts/goga.mjs";
}

function writeConfig(next) {
  mkdirSync(path.dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  chmodSync(CONFIG, 0o600);
}

async function publicCall(base, method, p, body) {
  let res;
  try {
    res = await fetch(`${base}/api/v1${p}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    die(`Studio inacessível em ${base}: ${err.cause?.code ?? err.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* sem navegador (ssh, container): a URL ja foi impressa */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Login tipo "device code": o segredo fica aqui; o navegador so ve o codigo
// curto, que a pessoa confere antes de autorizar. O token nunca passa por URL.
async function login(base, client, { abrir = true } = {}) {
  const start = await publicCall(base, "POST", "/agent/login/start", { client });
  if (start.status >= 400) fail(start.status, start.data);
  const { deviceCode, userCode, verifyUrl, expiresAt, interval } = start.data;
  process.stderr.write(`\nAutorize no navegador: ${verifyUrl}\nConfira que o código mostrado lá é  ${userCode}\n(entre com seu usuário e senha do Studio se pedir)\n\nAguardando autorização…`);
  if (abrir) openBrowser(verifyUrl);
  const deadline = new Date(expiresAt).getTime();
  while (Date.now() < deadline) {
    await sleep((interval ?? 2) * 1000);
    const r = await publicCall(base, "POST", "/agent/login/poll", { deviceCode });
    if (r.status === 202) continue;
    process.stderr.write("\n");
    if (r.status === 403 || r.status === 410) die(r.data?.error ?? "login não concluído");
    if (r.status >= 400) fail(r.status, r.data);
    writeConfig({ url: base, token: r.data.token });
    return r.data.user;
  }
  process.stderr.write("\n");
  die("O pedido de login expirou. Rode o login de novo.");
}

const MIME = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function upload(file) {
  const { url, token } = readConfig();
  if (!token) die(`Sem token. Rode:\n  node ${selfPath()} login`);
  let data;
  try {
    data = readFileSync(file);
  } catch (err) {
    return { arquivo: file, erro: err.code === "ENOENT" ? "arquivo não existe" : err.message };
  }
  const form = new FormData();
  form.append("file", new Blob([data], { type: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" }), path.basename(file));
  let res;
  try {
    res = await fetch(`${url}/api/v1/agent/files`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  } catch (err) {
    die(`Studio inacessível em ${url}: ${err.cause?.code ?? err.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (res.status === 401) fail(401, body);
  if (!res.ok) return { arquivo: file, erro: `${res.status}: ${body.error ?? "falha no envio"}` };
  return { arquivo: file, fileId: body.file.id, nome: body.file.name, tamanho: body.file.size };
}

const print = (v) => process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);

function args(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function readInput(raw) {
  if (raw === undefined) return {};
  let text = raw;
  if (raw === "-") text = readFileSync(0, "utf8");
  else if (raw.startsWith("@")) text = readFileSync(raw.slice(1), "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`Entrada não é JSON válido: ${err.message}`);
  }
}

function fail(status, data) {
  const msg = typeof data === "string" ? data : (data?.error ?? `HTTP ${status}`);
  const details = data?.details ? `\ndetalhes: ${JSON.stringify(data.details, null, 2)}` : "";
  const hint =
    status === 401 ? `\n(token inválido, expirado ou revogado: rode  node ${selfPath()} login)` : status === 403 ? "\n(seu papel não permite esta ação)" : "";
  die(`Erro ${status}: ${msg}${details}${hint}`);
}

const { pos, flags } = args(process.argv.slice(2));
const cmd = pos[0];

switch (cmd) {
  case "configurar": {
    const cur = readConfig();
    const next = { url: String(flags.url ?? cur.url).replace(/\/+$/, ""), token: flags.token ?? cur.token };
    writeConfig(next);
    print(`Configurado: ${next.url} (${next.token ? `token ${String(next.token).slice(0, 11)}…` : "sem token"}) em ${CONFIG}`);
    break;
  }
  case "login": {
    const base = String(flags.url ?? readConfig().url).replace(/\/+$/, "");
    const user = await login(base, String(flags.nome ?? `goga-cli em ${hostname()}`), { abrir: flags["sem-navegador"] !== true });
    print(`Autenticado em ${base} como ${user.name} (${user.email}, ${user.role}). Token guardado em ${CONFIG}.`);
    break;
  }
  case "instalar": {
    // Baixa a skill do proprio Studio e grava nas pastas que cada agente le:
    // Claude Code em ~/.claude/skills; Codex e Gemini CLI em ~/.agents/skills.
    // O endereco embutido (de onde o script foi baixado) vale mais que o config.
    const base = String(flags.url ?? EMBEDDED_URL ?? readConfig().url).replace(/\/+$/, "");
    const wanted = String(flags.agentes ?? "claude,codex,gemini").split(",").map((x) => x.trim()).filter(Boolean);
    const bad = wanted.filter((a) => !["claude", "codex", "gemini"].includes(a));
    if (bad.length) die(`Agente desconhecido: ${bad.join(", ")} (use claude, codex, gemini)`);
    const r = await publicCall(base, "GET", "/agent/skill/bundle");
    if (r.status >= 400) fail(r.status, r.data);
    const { name, files } = r.data;
    const dirs = new Set();
    if (wanted.includes("claude")) dirs.add(path.join(homedir(), ".claude", "skills"));
    if (wanted.includes("codex") || wanted.includes("gemini")) dirs.add(path.join(homedir(), ".agents", "skills"));
    const installed = [];
    for (const d of dirs) {
      const dest = path.join(d, name);
      try {
        // Link (ex.: instalado a partir do repositorio) e trocado por copia.
        if (lstatSync(dest)) rmSync(dest, { recursive: true, force: true });
      } catch {
        /* nao existia */
      }
      for (const f of files) {
        const target = path.join(dest, f.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, f.content);
        if (f.path.endsWith(".mjs") || f.path.endsWith(".sh")) chmodSync(target, 0o755);
      }
      installed.push(dest);
    }
    process.stderr.write(`Skill ${name} instalada em:\n${installed.map((d) => `  ${d}`).join("\n")}\n`);
    const cur = readConfig();
    if (flags["sem-login"] !== true) {
      let ok = false;
      if (cur.token && cur.url === base) {
        const me = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${cur.token}` } }).catch(() => null);
        ok = !!me?.ok;
      }
      if (ok) process.stderr.write(`Já autenticado em ${base}.\n`);
      else {
        const user = await login(base, String(flags.nome ?? `${wanted.join(", ")} em ${hostname()}`), { abrir: flags["sem-navegador"] !== true });
        process.stderr.write(`Autenticado como ${user.name} (${user.email}, ${user.role}).\n`);
      }
    } else if (!cur.url || cur.url !== base) writeConfig({ url: base, token: cur.url === base ? cur.token : undefined });
    const script = path.join([...dirs][0], name, "scripts", "goga.mjs");
    print(`\nPronto. Abra o ${wanted.map((a) => ({ claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" })[a]).join(" / ")} e peça, por exemplo:\n  "liste os fluxos do Goga Studio e diga qual está em produção"\n\nTeste direto: node ${script} eu`);
    break;
  }
  case "eu": {
    const r = await api("GET", "/auth/me");
    if (r.status >= 400) fail(r.status, r.data);
    print({ studio: readConfig().url, ...r.data.user });
    break;
  }
  case "guia": {
    const r = await api("GET", "/agent/guide");
    if (r.status >= 400) fail(r.status, r.data);
    const { user, domain, tools } = r.data;
    const lines = [
      `# Goga Studio — ${readConfig().url}`,
      `Você opera como ${user.name} (${user.email}, papel: ${user.role}).${user.role !== "admin" ? " OPERADOR: pode ler e testar; alterações voltam 403." : ""}`,
      "",
      domain,
      "",
      "## Ferramentas (`chamar <nome> '<json>'`; esquema completo: `ferramentas <nome>`)",
      ...tools.map((t) => `- **${t.name}**${t.sensitive ? " ⚠️ pede aprovação (--confirmar)" : ""}: ${t.description}`),
    ];
    print(lines.join("\n"));
    break;
  }
  case "ferramentas": {
    const r = await api("GET", "/agent/tools");
    if (r.status >= 400) fail(r.status, r.data);
    if (pos[1]) {
      const t = r.data.tools.find((x) => x.name === pos[1]);
      if (!t) die(`Ferramenta "${pos[1]}" não existe. Disponíveis: ${r.data.tools.map((x) => x.name).join(", ")}`);
      print(t);
    } else print(r.data.tools.map((t) => `${t.name}${t.sensitive ? " ⚠️" : ""} — ${t.description}`).join("\n"));
    break;
  }
  case "chamar": {
    const name = pos[1];
    if (!name) die("Uso: chamar <ferramenta> ['<json>' | @arquivo.json | -] [--confirmar]");
    const input = readInput(pos[2]);
    const r = await api("POST", `/agent/tools/${encodeURIComponent(name)}`, { input, confirm: flags.confirmar === true });
    if (r.status === 428) {
      // Nada foi feito: o agente precisa mostrar o resumo e pedir aprovacao.
      print({ precisaAprovacao: true, resumo: r.data.resumo, comoAprovar: `peça aprovação ao usuário; se ele aprovar, repita o mesmo comando com --confirmar` });
      process.exit(3);
    }
    if (r.status >= 400) fail(r.status, r.data);
    print(r.data.result);
    break;
  }
  case "anexar": {
    const files = pos.slice(1);
    if (!files.length) die("Uso: anexar <arquivo> [arquivo...]");
    const out = [];
    for (const f of files) out.push(await upload(f));
    print(out);
    if (out.some((o) => o.erro)) process.exit(1);
    break;
  }
  default:
    print(`Goga Studio (agentes externos)

  instalar [--agentes claude,codex,gemini]   instala a skill e faz login
  login [--url <studio>] [--nome <rótulo>]   autoriza no navegador e guarda o token
  configurar --url <studio> --token <goga_...>
  eu                                   quem sou eu no Studio
  guia                                 domínio do Goga + lista de ferramentas (leia primeiro)
  ferramentas [nome]                   lista, ou esquema JSON completo de uma
  chamar <ferramenta> [json|@arq|-]    executa (sensíveis pedem --confirmar)
  anexar <arquivo...>                  sobe arquivos locais; devolve fileIds (ex.: para enviar_documento_kb)`);
    if (cmd && cmd !== "ajuda" && cmd !== "help") process.exit(2);
}
