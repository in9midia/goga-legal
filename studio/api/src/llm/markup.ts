// Marcacao de chamada de ferramenta que o modelo escreve como TEXTO. Com as
// ferramentas desligadas no ultimo passo (toolChoice "none"), o DeepSeek as
// vezes "chama" mesmo assim, no formato interno dele, e isso chega como a
// resposta: `<｜｜DSML｜｜ invoke name="buscar_kb">...`. O parecer do
// especialista 58 caiu assim (execucao 5e191eb5, 2026-10-20): o texto nao
// estava vazio, entao o resgate nao rodava, e o reparo de JSON escrevia sem o
// que as ferramentas trouxeram.
const TOOL_MARKUP_START = [
  /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/, // DeepSeek V4 (DSML)
  /<[｜|]tool▁calls?▁begin[｜|]>/, // DeepSeek V3
  /<tool_call>/i,
  /<function_calls>/i,
];

/** O texto e so marcacao de ferramenta (nada antes dela alem de espaco). */
export function onlyToolMarkup(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  let first = -1;
  for (const re of TOOL_MARKUP_START) {
    const m = re.exec(t);
    if (m && (first < 0 || m.index < first)) first = m.index;
  }
  return first === 0;
}
