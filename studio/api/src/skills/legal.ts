// Calculos juridicos DETERMINISTICOS. Prazo, correcao e competencia nunca ficam
// com o modelo (Guardrail 6 da pesquisa): ele erra aritmetica de data com
// confianca, e o erro so aparece quando o prazo ja passou.
import type { IndexTables } from "./indices.js";

// ── Prazos ────────────────────────────────────────────────────────────────

export const PRAZOS = {
  vicio_nao_duravel: { anos: 0, dias: 30, natureza: "decadência", base: "CDC, art. 26, I", termo: "entrega do produto/término do serviço (vício aparente) ou evidência do defeito (vício oculto, §3º)" },
  vicio_duravel: { anos: 0, dias: 90, natureza: "decadência", base: "CDC, art. 26, II", termo: "entrega do produto/término do serviço (vício aparente) ou evidência do defeito (vício oculto, §3º)" },
  fato_produto_servico: { anos: 5, dias: 0, natureza: "prescrição", base: "CDC, art. 27", termo: "conhecimento do dano e de sua autoria" },
  reparacao_civil: { anos: 3, dias: 0, natureza: "prescrição", base: "CC, art. 206, §3º, V", termo: "data do fato danoso" },
  enriquecimento_sem_causa: { anos: 3, dias: 0, natureza: "prescrição", base: "CC, art. 206, §3º, IV", termo: "data do enriquecimento" },
  divida_liquida_instrumento: { anos: 5, dias: 0, natureza: "prescrição", base: "CC, art. 206, §5º, I", termo: "vencimento da dívida" },
  seguro_segurado: { anos: 1, dias: 0, natureza: "prescrição", base: "CC, art. 206, §1º, II", termo: "ciência do fato gerador da pretensão" },
  regra_geral: { anos: 10, dias: 0, natureza: "prescrição", base: "CC, art. 205", termo: "violação do direito" },
  fazenda_publica: { anos: 5, dias: 0, natureza: "prescrição", base: "Decreto 20.910/1932, art. 1º", termo: "data do ato ou fato" },
  trabalhista_extincao: { anos: 2, dias: 0, natureza: "prescrição", base: "CF, art. 7º, XXIX", termo: "extinção do contrato de trabalho" },
  aereo_internacional_material: { anos: 2, dias: 0, natureza: "prescrição", base: "Convenção de Montreal, art. 35 (Tema 210/STF)", termo: "chegada ao destino ou data em que deveria chegar" },
} as const;
export type TipoPrazo = keyof typeof PRAZOS;

const DAY = 864e5;
const parseDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`data inválida: ${s} (use AAAA-MM-DD)`);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function calcularPrazo(input: { tipo: TipoPrazo; data_inicio: string; hoje?: string }) {
  const regra = PRAZOS[input.tipo];
  if (!regra) throw new Error(`tipo de prazo desconhecido: ${input.tipo}`);
  const inicio = parseDate(input.data_inicio);
  const hoje = input.hoje ? parseDate(input.hoje) : parseDate(iso(new Date()));
  const limite = new Date(inicio);
  if (regra.anos) limite.setUTCFullYear(limite.getUTCFullYear() + regra.anos);
  if (regra.dias) limite.setTime(limite.getTime() + regra.dias * DAY);
  const restantes = Math.round((limite.getTime() - hoje.getTime()) / DAY);
  return {
    tipo: input.tipo,
    natureza: regra.natureza,
    prazo: regra.anos ? `${regra.anos} ano(s)` : `${regra.dias} dias`,
    base_legal: regra.base,
    termo_inicial: regra.termo,
    data_inicio: iso(inicio),
    data_limite: iso(limite),
    dias_restantes: restantes,
    situacao: restantes < 0 ? "expirado" : restantes <= 30 ? "urgente" : "em curso",
    ressalvas: [
      "Não considera causas de suspensão ou interrupção (ex.: reclamação comprovada ao fornecedor suspende a decadência — CDC, art. 26, §2º).",
      "O termo inicial depende dos fatos; confirme a data que o usuário informou.",
    ],
  };
}

// ── Correcao monetaria e juros (Lei 14.905/2024) ─────────────────────────

// A Lei 14.905/2024 entrou em vigor em 30/08/2024; o primeiro mes inteiro do
// regime novo e setembro. Antes disso o calculo usa o regime anterior
// simplificado (IPCA + 1% a.m.), e diz isso na saida.
const REGIME_NOVO = "2024-09";

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function calcularCorrecao(
  input: { valor: number; data_inicial: string; data_final?: string; juros?: boolean; data_juros?: string },
  t: IndexTables,
) {
  if (!(input.valor > 0)) throw new Error("valor deve ser positivo");
  const ini = parseDate(input.data_inicial);
  const fim = input.data_final ? parseDate(input.data_final) : new Date();
  if (fim < ini) throw new Error("data_final anterior à data_inicial");
  const ultimoIpca = Object.keys(t.ipca).sort().at(-1)!;
  const mesFim = iso(fim).slice(0, 7);
  // Mes corrente ainda nao tem IPCA publicado: corrige ate o ultimo disponivel.
  const ate = mesFim > ultimoIpca ? ultimoIpca : mesFim;
  const periodo = months(iso(ini).slice(0, 7), ate);

  let fator = 1;
  for (const m of periodo) fator *= 1 + (t.ipca[m] ?? 0) / 100;
  const corrigido = input.valor * fator;

  let jurosPct = 0;
  const detalheJuros: { mes: string; taxa: number; regime: string }[] = [];
  if (input.juros) {
    const jIni = input.data_juros ? parseDate(input.data_juros) : ini;
    for (const m of months(iso(jIni).slice(0, 7), ate)) {
      let taxa: number;
      let regime: string;
      if (m >= REGIME_NOVO) {
        // CC, art. 406, §§1º e 3º: taxa legal = Selic - IPCA, e zero se negativa.
        taxa = Math.max(0, (t.selic[m] ?? 0) - (t.ipca[m] ?? 0));
        regime = "Selic − IPCA (CC 406 §1º)";
      } else {
        taxa = 1;
        regime = "1% a.m. (regime anterior)";
      }
      jurosPct += taxa;
      detalheJuros.push({ mes: m, taxa: Number(taxa.toFixed(4)), regime });
    }
  }
  const juros = corrigido * (jurosPct / 100);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    valor_original: r2(input.valor),
    fator_correcao: Number(fator.toFixed(6)),
    valor_corrigido: r2(corrigido),
    juros_percentual_acumulado: Number(jurosPct.toFixed(4)),
    juros: r2(juros),
    total: r2(corrigido + juros),
    indice_correcao: "IPCA (CC, art. 389, parágrafo único, red. Lei 14.905/2024)",
    periodo: { de: periodo[0], ate, meses: periodo.length },
    juros_simples: true,
    detalhe_juros: detalheJuros.length > 24 ? `${detalheJuros.length} meses` : detalheJuros,
    fonte: `BCB/SGS 433 (IPCA) e 4390 (Selic), tabela de ${t.fetchedAt.slice(0, 10)}`,
    ressalvas: [
      ...(periodo[0] < REGIME_NOVO
        ? ["Período anterior a 30/08/2024 calculado com IPCA + 1% a.m.; a tabela do tribunal competente pode usar outro índice."]
        : []),
      ...(mesFim > ultimoIpca ? [`IPCA disponível até ${ultimoIpca}; meses posteriores não corrigidos.`] : []),
    ],
  };
}

// ── Elegibilidade para juizados ──────────────────────────────────────────

export type TipoReu = "particular" | "empresa" | "uniao_autarquia_federal" | "estado_municipio";

export function elegibilidadeJuizado(input: { valor_causa: number; reu: TipoReu; salario_minimo: number; sm_referencia: string }) {
  const sm = input.salario_minimo;
  const emSm = input.valor_causa / sm;
  const r = (n: number) => Math.round(n * 100) / 100;
  const base = { valor_causa: input.valor_causa, salario_minimo: sm, sm_referencia: input.sm_referencia, valor_em_salarios_minimos: r(emSm) };
  if (input.reu === "uniao_autarquia_federal") {
    const ok = emSm <= 60;
    return {
      ...base,
      juizado: "Juizado Especial Federal",
      cabe: ok,
      teto: `60 SM (R$ ${r(60 * sm)})`,
      base_legal: "Lei 10.259/2001, art. 3º",
      advogado: "facultativo no primeiro grau",
      observacao: ok ? "" : "Acima do teto: vara federal comum, com advogado.",
    };
  }
  if (input.reu === "estado_municipio") {
    const ok = emSm <= 60;
    return {
      ...base,
      juizado: "Juizado Especial da Fazenda Pública",
      cabe: ok,
      teto: `60 SM (R$ ${r(60 * sm)})`,
      base_legal: "Lei 12.153/2009, art. 2º",
      advogado: "facultativo no primeiro grau",
      observacao: ok ? "" : "Acima do teto: vara da Fazenda Pública, com advogado.",
    };
  }
  const ok = emSm <= 40;
  return {
    ...base,
    juizado: "Juizado Especial Cível (JEC)",
    cabe: ok,
    teto: `40 SM (R$ ${r(40 * sm)})`,
    base_legal: "Lei 9.099/1995, art. 3º, I",
    advogado: emSm <= 20 ? "facultativo (até 20 SM — Lei 9.099/1995, art. 9º)" : "obrigatório (acima de 20 SM — art. 9º)",
    observacao: ok
      ? "Pessoa jurídica de direito privado pode ser ré no JEC; como autora, só ME/EPP (art. 8º, §1º)."
      : "Acima de 40 SM: renunciar ao excedente (art. 3º, §3º) ou ir à vara cível comum.",
  };
}
