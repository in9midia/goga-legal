import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

// Tabelas oficiais do Banco Central (SGS), baixadas e guardadas em disco.
// Indice economico NAO entra no codigo: um numero digitado a mao envelhece em um
// mes e ninguem percebe, e calculo de correcao errado e exatamente o tipo de
// erro que a pesquisa proibe o modelo de cometer (Guardrail 6).
//   433  = IPCA, variacao mensal (%)
//   4390 = Selic acumulada no mes (%)
//   1619 = salario minimo (R$)
const SERIES = { ipca: 433, selic: 4390, salarioMinimo: 1619 } as const;
const MAX_AGE_MS = 7 * 864e5;

export interface IndexTables {
  fetchedAt: string;
  ipca: Record<string, number>; // "AAAA-MM" -> %
  selic: Record<string, number>;
  salarioMinimo: Record<string, number>;
}

const file = () => path.resolve(config.filesDir, "..", "indices.json");
let cache: IndexTables | null = null;

async function download(serie: number, start = "01/01/2000"): Promise<Record<string, number>> {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados?formato=json&dataInicial=${start}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`BCB SGS ${serie}: HTTP ${res.status}`);
  const rows = (await res.json()) as { data: string; valor: string }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    const [, mm, yyyy] = r.data.split("/");
    out[`${yyyy}-${mm}`] = Number(r.valor);
  }
  return out;
}

export async function refreshIndices(): Promise<IndexTables> {
  const [ipca, selic, salarioMinimo] = await Promise.all([
    download(SERIES.ipca),
    download(SERIES.selic),
    download(SERIES.salarioMinimo, "01/01/2015"),
  ]);
  const tables = { fetchedAt: new Date().toISOString(), ipca, selic, salarioMinimo };
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(tables));
  cache = tables;
  return tables;
}

export async function getIndices(): Promise<IndexTables> {
  if (cache && Date.now() - Date.parse(cache.fetchedAt) < MAX_AGE_MS) return cache;
  try {
    cache = JSON.parse(await fs.readFile(file(), "utf8")) as IndexTables;
  } catch {
    cache = null;
  }
  if (!cache || Date.now() - Date.parse(cache.fetchedAt) > MAX_AGE_MS) {
    try {
      return await refreshIndices();
    } catch (err) {
      // Sem rede: tabela velha ainda serve (e o calculo diz de quando ela e);
      // sem tabela nenhuma, o calculo recusa em vez de inventar.
      if (cache) return cache;
      throw new Error(`Tabela de índices indisponível e sem rede para baixar do BCB: ${(err as Error).message}`);
    }
  }
  return cache;
}

export function latest(series: Record<string, number>): { month: string; value: number } {
  const month = Object.keys(series).sort().at(-1)!;
  return { month, value: series[month] };
}
