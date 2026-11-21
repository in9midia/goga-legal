import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { config } from "../config.js";

/**
 * Interface do Studio com o Evolution API (WhatsApp nao oficial). Portado do
 * In9 CRM (apps/api/src/modules/channels/adapters/whatsapp_evolution), onde o
 * desenho ja passou por producao:
 *
 * - O Evolution nao assina webhook. Cada instancia ganha um token proprio e um
 *   cabecalho `x-goga-webhook-token`, ambos derivados da chave global por HMAC:
 *   nada a guardar no banco, e trocar a chave invalida os antigos.
 * - Erro de rede e 5xx = tentar de novo; "Connection Closed" = sessao caida ou
 *   travada (ver `markStale` em service.ts).
 */

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const WEBHOOK_TOKEN_HEADER = "x-goga-webhook-token";

const derive = (key: string, purpose: string, id: string) => createHmac("sha256", key).update(`${purpose}:${id}`).digest("hex");

/** Token da instancia (o Evolution repete no campo `apikey` de cada webhook). */
export const instanceTokenOf = (apiKey: string, numberId: string) => derive(apiKey, "evolution-instance", numberId).slice(0, 32).toUpperCase();
/** Valor do cabecalho `x-goga-webhook-token` configurado no webhook da instancia. */
export const webhookTokenOf = (apiKey: string, numberId: string) => derive(apiKey, "evolution-webhook", numberId);

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const evolutionConfigured = () => !!config.evolutionApiKey;

/** Envio recusado porque o socket do WhatsApp esta fechado. */
export const isConnectionClosed = (err: unknown) => err instanceof EvolutionError && /connection closed/i.test(err.message);

export function classifyRetryable(status: number, message: string) {
  if (status === 0 || status === 429 || status >= 500) return true;
  return /connection closed|not connected|connecting|timed? ?out/i.test(message);
}

export async function evolution<T = Record<string, unknown>>(method: string, path: string, json?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!config.evolutionApiKey) throw new EvolutionError("Evolution não configurado (EVOLUTION_API_KEY)", 0, false);
  let res: Response;
  try {
    res = await fetch(`${config.evolutionUrl}${path}`, {
      method,
      headers: { apikey: config.evolutionApiKey, ...(json !== undefined && { "content-type": "application/json" }) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EvolutionError(`Evolution indisponível: ${(err as Error).message}`, 0, true);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text)
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  if (!res.ok) {
    const r = (body as { response?: { message?: unknown } } | null)?.response?.message;
    const message = typeof r === "string" ? r : r !== undefined ? JSON.stringify(r) : `HTTP ${res.status}`;
    throw new EvolutionError(`Evolution: ${message}`, res.status, classifyRetryable(res.status, message));
  }
  return body as T;
}

// ── Reinicio do Evolution (sessao travada) ───────────────────────────────
// Mesmo que `kubectl rollout restart`: patch na anotacao restartedAt do
// Deployment, pela API do Kubernetes de dentro do pod, com o token da conta de
// servico (Role restrita a esse Deployment; charts/goga/templates/evolution.yaml).
// Com a sessao em armazenamento duravel (Postgres + volume), ele volta sem QR.

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export function parseRestartTarget(raw: string | undefined) {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(raw?.trim() ?? "");
  return m ? { namespace: m[1]!, name: m[2]! } : null;
}

export const restartConfigured = () => !!parseRestartTarget(config.evolutionRestartTarget) && !!process.env.KUBERNETES_SERVICE_HOST;

export async function restartEvolution(): Promise<void> {
  const target = parseRestartTarget(config.evolutionRestartTarget);
  if (!target || !process.env.KUBERNETES_SERVICE_HOST) throw new Error("reinício do Evolution não configurado");
  const [token, ca] = await Promise.all([readFile(`${SA_DIR}/token`, "utf8"), readFile(`${SA_DIR}/ca.crt`, "utf8")]);
  const body = JSON.stringify({ spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } });
  await new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: process.env.KUBERNETES_SERVICE_HOST,
        port: Number(process.env.KUBERNETES_SERVICE_PORT || 443),
        method: "PATCH",
        path: `/apis/apps/v1/namespaces/${target.namespace}/deployments/${target.name}`,
        ca,
        headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/strategic-merge-patch+json", "content-length": Buffer.byteLength(body) },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          if (res.statusCode && res.statusCode < 300) return resolve();
          reject(new Error(`Kubernetes respondeu ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Kubernetes não respondeu em 10 s")));
    req.on("error", reject);
    req.end(body);
  });
}
