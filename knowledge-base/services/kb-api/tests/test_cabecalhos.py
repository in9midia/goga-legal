"""Cabeçalho HTTP é latin-1, e o que não couber vira HTTP 500.

Isto não é teoria: `Anexo 1 – Resumo de Contratos.pdf` (com travessão) derrubava
o download do original com "Internal Server Error", enquanto todos os vizinhos
acentuados funcionavam — `Í` e `Ç` cabem em latin-1, travessão não.
"""
from __future__ import annotations

import pytest
from starlette.responses import Response

from kb_api.main import _content_disposition, _valor_de_cabecalho

# O que o editor de texto gera sozinho e o latin-1 não aceita.
FORA_DO_LATIN1 = [
    "Anexo 1 – Resumo de Contratos.pdf",  # travessão U+2013
    "Relatório — final.pdf",  # travessão longo U+2014
    "Política “nova”.docx",  # aspas curvas
    "Resumo… parcial.pdf",  # reticências
    "中文文件.pdf",
    "Ata 2026 🚀.pdf",
]


def _cabe_na_resposta(valor: str) -> bool:
    """A verificação de verdade: o Starlette levanta na CONSTRUÇÃO."""
    Response(content=b"x", headers={"Content-Disposition": valor})
    return True


@pytest.mark.parametrize("nome", FORA_DO_LATIN1)
def test_nome_fora_do_latin1_nao_derruba_a_resposta(nome):
    assert _cabe_na_resposta(_content_disposition(nome))


@pytest.mark.parametrize(
    "nome", ["POLÍTICA DE AVALIAÇÃO.docx", "Guia_HomeOffice.pdf", "Anexo 1 – Resumo.pdf"]
)
def test_o_nome_real_vai_inteiro_no_filename_estrela(nome):
    """A parte ASCII é degradada de propósito; o nome de verdade viaja em
    `filename*`, que é o que todo navegador atual lê (RFC 6266)."""
    from urllib.parse import quote

    assert f"filename*=UTF-8''{quote(nome, safe='')}" in _content_disposition(nome)


def test_aspas_no_nome_nao_fecham_o_cabecalho():
    """Uma aspa no meio encerraria o `filename="..."` e o resto do nome viraria
    parâmetro solto do cabeçalho."""
    saida = _content_disposition('relatorio "final".pdf')
    ascii_parte = saida.split('filename="', 1)[1].split('"', 1)[0]
    assert '"' not in ascii_parte
    assert _cabe_na_resposta(saida)


def test_nome_sem_nada_aproveitavel_em_ascii_ainda_tem_filename():
    """`filename=""` vazio faz o navegador salvar como "download" sem extensão."""
    saida = _content_disposition("中文.pdf")
    assert 'filename="' in saida and _cabe_na_resposta(saida)


def test_valor_de_cabecalho_aguenta_texto_vindo_de_fora():
    """O `error_description` do 401 carrega o issuer LIDO DO TOKEN. Um token
    malformado não pode transformar o 401 em 500: sem o 401 não há
    `WWW-Authenticate`, e sem ele o cliente MCP não descobre o login."""
    sujo = 'issuer inesperado: https://exemplo.com/“malicioso”\ncom quebra'
    limpo = _valor_de_cabecalho(sujo)
    limpo.encode("latin-1")  # levanta se não couber
    assert '"' not in limpo
    assert "\n" not in limpo and "\r" not in limpo
