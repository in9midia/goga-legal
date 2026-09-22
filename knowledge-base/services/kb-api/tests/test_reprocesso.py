"""Reprocessamento: a falha NAO pode custar o documento.

Este arquivo existe por causa de um incidente real. O reprocessamento apagava a
versao antiga ANTES de reingerir, e a falha do embedding acontece entre as duas
coisas -- com um provedor de IA mal configurado, os quatro documentos do Espaco
`juridico` desta instalacao desapareceram em vez de ficarem marcados como
falhos.

O que os testes travam:

1. `ingest_document(force=True)` NAO pula o trabalho quando o sha e identico
   (sem isso o reprocessamento nao reprocessa nada);
2. `force=False` continua pulando (o no-op de reingestao do mesmo arquivo, que
   e o que torna a carga em massa segura de repetir);
3. o reprocessamento nao apaga o documento antes de ter a versao nova.
"""

from __future__ import annotations

import inspect


def test_ingest_document_aceita_force():
    from kb_api import ingest

    assinatura = inspect.signature(ingest.ingest_document)
    assert "force" in assinatura.parameters
    assert assinatura.parameters["force"].default is False, (
        "o padrao precisa ser False: forcar por acidente refaria trabalho "
        "em toda reingestao de arquivo identico"
    )


def test_force_desliga_o_atalho_de_sha_identico():
    """O `if not force` tem de envolver a consulta do atalho.

    Verificado no fonte porque exercitar de verdade exigiria banco, object
    store e provedor de IA -- e o que importa aqui e a ORDEM, que e legivel.
    """
    from kb_api import ingest

    fonte = inspect.getsource(ingest._ingest_document)
    atalho = fonte.index("no-op quando o conteudo ja esta indexado")
    guarda = fonte.index("if not force:")
    consulta = fonte.index("AND status = 'indexed'")
    assert atalho < guarda < consulta, (
        "a consulta do atalho precisa estar DENTRO do `if not force`"
    )


def test_reprocessamento_nao_apaga_antes_de_reingerir():
    """A ordem no `_reprocessar_um`: ingerir primeiro, apagar a antiga depois.

    Se alguem reintroduzir o `DELETE` antes da ingestao, a janela de perda de
    dado volta -- e ela nao aparece em teste nenhum que dependa de sucesso,
    porque so se manifesta quando a ingestao falha.
    """
    from kb_api import main

    fonte = inspect.getsource(main._reprocessar_um)
    posicao_ingestao = fonte.index("ingest.ingest_document(")
    posicao_delete = fonte.index("DELETE FROM document")
    assert posicao_ingestao < posicao_delete, (
        "a ingestao tem de vir ANTES do delete da versao antiga"
    )


def test_reprocessamento_so_apaga_a_antiga_em_caso_de_sucesso():
    from kb_api import main

    fonte = inspect.getsource(main._reprocessar_um)
    assert 'resultado.status == "indexed"' in fonte, (
        "o delete da versao antiga precisa estar condicionado ao sucesso"
    )


def test_reprocessamento_usa_force():
    from kb_api import main

    assert "force=True" in inspect.getsource(main._reprocessar_um)
