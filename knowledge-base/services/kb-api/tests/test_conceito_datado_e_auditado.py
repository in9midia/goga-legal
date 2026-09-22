"""Vigência, auditoria e armadilha: o que o conceito passou a saber dizer.

Três campos novos no frontmatter, e um comportamento que muda o nível de
confiança. O que está travado aqui:

1. **normalização de data.** O YAML devolve `datetime.date` para data sem aspas
   e `str` para data com aspas, e as duas formas precisam sair daqui iguais: a
   comparação de vigência acontece como TEXTO no Postgres, e duas formas da
   mesma data no mesmo campo fariam o filtro errar sem nada falhar;
2. **ausência é "sempre válido".** É a regra que não pode ser invertida: quase
   nenhum documento de qualquer base declara vigência, e tratá-los como
   revogados esvaziaria a busca em silêncio;
3. **a auditoria só rebaixa.** `em-verificacao` derruba o nível mesmo com
   assinatura humana; nenhum status faz subir. Se subisse, bastaria escrever no
   frontmatter para virar revisado;
4. **tolerância.** Data ilegível, status desconhecido e chave estranha não
   podem fazer o conceito ser recusado -- a especificação proíbe.
"""

from __future__ import annotations

import datetime

import pytest

from kb_api import okf


def conceito(frontmatter: str) -> okf.Concept:
    texto = f"---\n{frontmatter}\n---\n\n# Título\n\nCorpo do conceito.\n"
    parsed = okf.parse(texto)
    assert parsed is not None
    return parsed


# ── normalizacao de data ──────────────────────────────────────────────────


def test_data_sem_aspas_vem_do_yaml_como_date_e_sai_em_iso():
    # `de: 1990-09-11` sem aspas: o PyYAML converte sozinho para datetime.date.
    c = conceito("type: Norma\nvigencia:\n  de: 1990-09-11\n  ate: null")
    assert isinstance(c.meta["vigencia"]["de"], datetime.date)
    assert c.vigencia == {"de": "1990-09-11", "ate": ""}


def test_data_com_aspas_sai_igual_a_data_sem_aspas():
    com = conceito('type: Norma\nvigencia:\n  de: "1990-09-11"')
    sem = conceito("type: Norma\nvigencia:\n  de: 1990-09-11")
    assert com.vigencia == sem.vigencia


def test_data_ilegivel_vira_ausencia_e_nao_erro():
    # Tolerancia obrigatoria: o bundle nao pode ser recusado por isto, e tratar
    # como "revogado" seria pior do que ignorar.
    c = conceito('type: Norma\nvigencia:\n  de: "ano que vem"\n  ate: "quando sair a nova"')
    assert c.vigencia == {}


def test_data_sem_zero_a_esquerda_e_recusada_na_entrada():
    # `1990-9-11` compararia errado como texto: '1990-9-11' > '1990-12-01'.
    assert okf.data_iso("1990-9-11") == ""
    assert okf.data_iso("1990-13-01") == ""
    assert okf.data_iso("2026-09-21T10:00:00Z") == "2026-09-21"


def test_conceito_sem_vigencia_nao_grava_a_chave():
    # Chave vazia em todo conceito poria dado morto em cada linha e tiraria o
    # sentido do indice parcial da migracao 0016.
    c = conceito("type: Norma\ntitle: Qualquer coisa")
    assert c.vigencia == {}
    assert "vigencia" not in c.to_dict()


def test_vigencia_entra_no_que_vai_para_o_banco():
    c = conceito("type: Norma\nvigencia:\n  de: 1990-09-11\n  ate: 2015-03-16")
    assert c.to_dict()["vigencia"] == {"de": "1990-09-11", "ate": "2015-03-16"}


# ── auditoria ─────────────────────────────────────────────────────────────


def test_auditoria_registra_contra_o_que_a_conferencia_foi_feita():
    c = conceito(
        "type: Norma\n"
        "auditoria:\n"
        "  status: verificada-mantida\n"
        '  fonte: "planalto.gov.br/ccivil_03/leis/l8078compilado.htm"\n'
        "  conferido_em: 2026-09-17\n"
        '  conferido_por: "curadoria"'
    )
    assert c.auditoria == {
        "status": "verificada-mantida",
        "fonte": "planalto.gov.br/ccivil_03/leis/l8078compilado.htm",
        "conferido_em": "2026-09-17",
        "conferido_por": "curadoria",
    }


def test_em_verificacao_rebaixa_mesmo_com_assinatura_humana():
    # O caso que o campo existe para resolver: a assinatura continua la, e a
    # conferencia foi reaberta justamente porque ha duvida sobre ela.
    c = conceito(
        "type: Norma\n"
        "verified:\n"
        "  - by: human:curadoria\n"
        "    at: 2026-09-01T10:00:00Z\n"
        "auditoria:\n"
        "  status: em-verificacao"
    )
    assert c.trust == "unverified"


def test_status_nao_faz_subir_de_nivel():
    # Sem `verified`, nenhum status inventa confianca: o nivel e derivado,
    # nunca declarado (ADR-0015).
    c = conceito("type: Norma\nauditoria:\n  status: verificada-mantida")
    assert c.trust == "unverified"


def test_status_desconhecido_nao_tem_efeito_nem_quebra():
    c = conceito(
        "type: Norma\n"
        "verified:\n"
        "  - by: human:curadoria\n"
        "auditoria:\n"
        "  status: conferida-por-outro-processo"
    )
    assert c.trust == "human-reviewed"


def test_auditoria_que_nao_e_mapa_e_ignorada():
    c = conceito('type: Norma\nauditoria: "conferido ano passado"')
    assert c.auditoria == {}


# ── escala de confianca ───────────────────────────────────────────────────


def test_escala_esta_ordenada_do_menor_para_o_maior():
    # A ORDEM e o contrato do `min_trust`: trocar duas entradas de lugar aqui
    # inverteria o filtro inteiro sem nenhum teste de SQL falhar.
    assert okf.TRUST_ESCALA == ("unverified", "machine-confirmed", "human-reviewed")
    assert okf.TRUST_PADRAO == "unverified"


def test_min_trust_aceita_dele_para_cima():
    assert okf.trust_aceitos("human-reviewed") == ["human-reviewed"]
    assert okf.trust_aceitos("machine-confirmed") == ["machine-confirmed", "human-reviewed"]
    assert okf.trust_aceitos("unverified") == list(okf.TRUST_ESCALA)


def test_min_trust_vazio_e_sem_filtro():
    assert okf.trust_aceitos("") == []


def test_min_trust_desconhecido_levanta():
    # Ignorar em silencio devolveria conteudo nao revisado a quem pediu que ele
    # nao viesse -- o modo de falha caro deste parametro.
    with pytest.raises(ValueError, match="desconhecido"):
        okf.trust_aceitos("human_reviewed")


# ── armadilha ─────────────────────────────────────────────────────────────


def test_armadilha_com_texto_e_o_proprio_aviso():
    c = conceito('type: Precedente\narmadilha: "tese defensiva, nunca fundamento ofensivo"')
    assert c.armadilha == "tese defensiva, nunca fundamento ofensivo"
    assert c.to_dict()["armadilha"] == "tese defensiva, nunca fundamento ofensivo"


def test_armadilha_booleana_ganha_o_aviso_generico():
    c = conceito("type: Precedente\narmadilha: true")
    assert c.armadilha == okf.AVISO_PADRAO


def test_true_vindo_do_jsonb_como_texto_nao_vira_aviso_literal():
    # `armadilha: true` atravessa o JSONB e volta do `->>` como a STRING
    # "true". Sem esta normalizacao, a palavra `true` apareceria como aviso.
    assert okf.aviso_de_armadilha("true") == okf.AVISO_PADRAO
    assert okf.aviso_de_armadilha("false") == ""
    assert okf.aviso_de_armadilha(None) == ""
    assert okf.aviso_de_armadilha(False) == ""


def test_sem_marca_nao_ha_chave_no_que_vai_para_o_banco():
    c = conceito("type: Norma")
    assert c.armadilha == ""
    assert "armadilha" not in c.to_dict()


# ── procedencia: o modelo nao inventa nenhum dos tres ─────────────────────


def test_conceito_derivado_nao_traz_vigencia_auditoria_nem_armadilha(monkeypatch):
    """A derivação classifica; ela não data, não confere e não avisa.

    Um modelo que "deduz" a data de revogação de um documento produz exatamente
    o dado que o filtro de vigência existe para tornar confiável.
    """
    from kb_api import llm

    class Resposta:
        model = "modelo-de-mentira"
        dados = {"type": "Norma", "title": "T", "description": "D", "tags": ["a"]}

    monkeypatch.setattr(llm, "complete_json", lambda *a, **k: Resposta())
    derivado = okf.derive("# Documento comum\n\nTexto.", "doc.md")
    assert derivado is not None
    assert derivado.vigencia == {} and derivado.auditoria == {} and derivado.armadilha == ""
    assert derivado.trust == "unverified"
