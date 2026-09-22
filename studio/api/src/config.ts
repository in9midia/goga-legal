import { randomBytes } from "node:crypto";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

const isProd = process.env.NODE_ENV === "production";

function secret(name: string): string {
  const value = env(name);
  // O @fastify/session recusa segredo curto com um erro que nao diz qual
  // variavel esta errada; aqui a mensagem aponta para ela.
  if (value && value.length < 32) throw new Error(`${name} precisa de ao menos 32 caracteres (openssl rand -hex 32)`);
  if (value) return value;
  // Em dev um segredo aleatorio por processo e aceitavel para a SESSAO (o custo
  // e relogar a cada restart). Para a cifra de chave nao: gravar com uma chave
  // efemera tornaria a credencial ilegivel no proximo boot, sem erro visivel ate
  // o primeiro "Testar". Por isso STUDIO_SECRET_KEY e exigida sempre.
  if (isProd || name === "STUDIO_SECRET_KEY") {
    throw new Error(`${name} é obrigatória (openssl rand -hex 32)`);
  }
  return randomBytes(32).toString("hex");
}

export const config = {
  isProd,
  port: Number(env("PORT", "8787")),
  databaseUrl: env("DATABASE_URL", "postgres://studio:studio@localhost:5442/studio"),
  secretKey: () => secret("STUDIO_SECRET_KEY"),
  sessionSecret: secret("STUDIO_SESSION_SECRET"),
  adminEmail: env("STUDIO_ADMIN_EMAIL", "admin@goga.local"),
  adminPassword: env("STUDIO_ADMIN_PASSWORD"),
  deepseekKey: env("DEEPSEEK_API_KEY"),
  geminiKey: env("GEMINI_API_KEY"),
  kbUrl: env("KB_URL", "http://localhost:8890").replace(/\/$/, ""),
  kbUiUrl: env("KB_UI_URL", env("KB_URL", "http://localhost:8890")).replace(/\/$/, ""),
  filesDir: env("STUDIO_FILES_DIR", "./data/files"),
};
