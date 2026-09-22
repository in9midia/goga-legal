/**
 * Acha o primeiro objeto/array JSON num texto de modelo.
 *
 * Modelos embrulham o JSON em ```json, prefixam "Aqui está:" ou fecham com um
 * comentario. Varrer por chaves balanceadas (respeitando strings) acha o objeto
 * nesses casos sem aceitar JSON invalido: o JSON.parse final continua estrito.
 */
export function extractJson(text: string): unknown | undefined {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* segue para a varredura */
  }
  for (let start = 0; start < t.length; start++) {
    const open = t[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        const candidate = t.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Virgula sobrando antes de } ou ]: o erro mais comum de modelo.
          try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}
