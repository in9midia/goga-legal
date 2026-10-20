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
        const parsed = parseLenient(candidate);
        if (parsed !== undefined) return parsed;
        // Objeto quebrado: segue DEPOIS dele, nao dentro. Antes a varredura
        // descia para a primeira lista interna e devolvia `["..."]` no lugar do
        // parecer, e o erro dizia "esperava objeto, recebeu lista".
        start = i;
        depth = -1;
        break;
      }
    }
    // Chegou ao fim sem fechar (resposta cortada): tenta fechar o que ficou
    // aberto antes de descer para dentro dele.
    if (depth > 0) {
      const parsed = parseLenient(t.slice(start));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function parseLenient(candidate: string): unknown | undefined {
  for (const fix of [
    (s: string) => s,
    // Virgula sobrando antes de } ou ]: o erro mais comum de modelo.
    (s: string) => s.replace(/,\s*([}\]])/g, "$1"),
    // Lista ou objeto sem fechar: `..."ultimo item"}` no lugar de `..."ultimo item"]}`
    // (parecer do especialista 58, execucao 5e191eb5).
    (s: string) => closeBrackets(s).replace(/,\s*([}\]])/g, "$1"),
  ]) {
    try {
      return JSON.parse(fix(candidate));
    } catch {
      /* proxima tentativa */
    }
  }
  return undefined;
}

/**
 * Fecha o que ficou aberto: antes de um fechamento que nao casa com o topo da
 * pilha, fecha o que esta no meio; no fim, fecha o resto. Strings respeitadas.
 */
export function closeBrackets(s: string): string {
  const stack: string[] = [];
  let out = "";
  let inStr = false;
  let esc = false;
  const closer = (open: string) => (open === "{" ? "}" : "]");
  for (const ch of s) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = ch === "}" ? "{" : "[";
      if (!stack.includes(open)) continue; // fechamento sem abertura: descarta
      while (stack.length && stack[stack.length - 1] !== open) out += closer(stack.pop()!);
      stack.pop();
    }
    out += ch;
  }
  if (inStr) out += '"';
  while (stack.length) out += closer(stack.pop()!);
  return out;
}
