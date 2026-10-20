import { describe, expect, it } from "vitest";
import { closeBrackets, extractJson } from "./json.js";
import { onlyToolMarkup } from "./markup.js";

// O parecer do especialista 58 na execucao 5e191eb5 (2026-10-20), encurtado:
// a ultima lista fecha com `}` em vez de `]}`.
const PARECER_SEM_COLCHETE =
  '{"especialidade":"58 · Recursos de Multa de Trânsito","resumo_fatos":"Recebeu processo de cassação da CNH.",' +
  '"enquadramento":["Fase: processo administrativo já instaurado.","Órgão: não informado."],' +
  '"lacunas":["Não sei a data da notificação.","Orientação: enviar a notificação (frente e verso)."}';

describe("extractJson", () => {
  it("fecha a lista que o modelo esqueceu de fechar", () => {
    const v = extractJson(PARECER_SEM_COLCHETE) as Record<string, unknown>;
    expect(v.especialidade).toBe("58 · Recursos de Multa de Trânsito");
    expect(v.lacunas).toEqual(["Não sei a data da notificação.", "Orientação: enviar a notificação (frente e verso)."]);
  });

  it("objeto quebrado sem conserto não vira a lista de dentro dele", () => {
    // Antes devolvia ["x"], e o erro dizia "esperava objeto, recebeu lista".
    expect(extractJson('{"a": ["x"], "b": tru}')).toBeUndefined();
  });

  it("depois de um objeto quebrado, ainda acha o JSON que vem em seguida", () => {
    expect(extractJson('rascunho {"a": tru} e o certo: {"a": true}')).toEqual({ a: true });
  });

  it("resposta cortada no meio: fecha o que ficou aberto", () => {
    expect(extractJson('{"a": 1, "lista": ["um", "dois"')).toEqual({ a: 1, lista: ["um", "dois"] });
  });

  it("continua aceitando os casos de antes", () => {
    expect(extractJson('Aqui está:\n```json\n{"a": [1,2,], "b": "x}"}\n```')).toEqual({ a: [1, 2], b: "x}" });
    expect(extractJson('[{"a": 1}]')).toEqual([{ a: 1 }]);
    expect(extractJson("sem json")).toBeUndefined();
  });
});

describe("closeBrackets", () => {
  it("fecha antes do fechamento que não casa, e no fim", () => {
    expect(closeBrackets('{"a":[1,{"b":2}')).toBe('{"a":[1,{"b":2}]}');
    expect(closeBrackets('{"a":[1,2}')).toBe('{"a":[1,2]}');
  });

  it("não mexe em colchete dentro de string", () => {
    expect(closeBrackets('{"a":"[}"')).toBe('{"a":"[}"}');
  });
});

describe("onlyToolMarkup", () => {
  it("reconhece a chamada de ferramenta do DeepSeek escrita como texto", () => {
    const dsml =
      '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="buscar_kb">\n<｜｜DSML｜｜ parameter name="consulta" string="true">art. 281-A defesa prévia</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    expect(onlyToolMarkup(dsml)).toBe(true);
    expect(onlyToolMarkup("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function")).toBe(true);
    expect(onlyToolMarkup('<tool_call>{"name":"buscar_kb"}</tool_call>')).toBe(true);
  });

  it("resposta com texto antes da marcação não é só marcação", () => {
    expect(onlyToolMarkup('{"especialidade":"58"} <tool_call>x</tool_call>')).toBe(false);
    expect(onlyToolMarkup("Resposta normal.")).toBe(false);
    expect(onlyToolMarkup("   ")).toBe(false);
  });
});
