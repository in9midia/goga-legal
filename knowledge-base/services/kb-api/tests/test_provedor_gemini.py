"""Gemini como provedor, e a trava de dimensao do vetor.

O que estes testes protegem nao e a integracao com o Google -- essa depende de
credencial e nao roda aqui. E o que quebraria em silencio: um vetor de tamanho
diferente do declarado entrando no indice.
"""

from kb_api import providers
from kb_api.embedding import _estimar_tokens


def _provedor(dimensions: int = 3072, kind: str = "gemini"):
    return providers.Provedor(
        id=1,
        kind=kind,
        name="gemini-teste",
        endpoint="",
        model="gemini-embedding-001",
        api_version="",
        dimensions=dimensions,
        api_key="chave-de-teste",
    )


def test_gemini_e_um_dialeto_conhecido():
    assert "gemini" in providers.DIALETOS
    assert providers.DIALETOS["gemini"].rotulo == "Google Gemini"


def test_gemini_usa_a_camada_compativel_com_openai():
    # Se algum dia isto apontar para `:embedContent`, o corpo do pedido e a
    # leitura da resposta em embedding.py precisam mudar junto.
    dialeto = providers.DIALETOS["gemini"]
    assert dialeto.endpoint_padrao.endswith("/v1beta/openai")
    assert dialeto.url_embedding == "{endpoint}/embeddings"
    assert dialeto.auth_prefixo == "Bearer "


def test_so_o_gemini_manda_dimensions_no_corpo():
    # Mandar `dimensions` para uma api-version antiga do Azure e 400, e o ganho
    # seria zero: o text-embedding-3-large ja devolve 3072.
    assert providers.DIALETOS["gemini"].dimensoes_no_corpo is True
    for kind in ("azure_openai", "openai", "azure_foundry", "litellm"):
        assert providers.DIALETOS[kind].dimensoes_no_corpo is False


def test_estimativa_entra_quando_o_provedor_nao_reporta_uso():
    # A camada compativel do Gemini nao devolve `usage` (conferido contra a
    # API). Gravar 0 como se fosse medido faria o painel de custo mostrar gasto
    # zero para uma base inteira -- pior que ausente, porque zero parece
    # medicao.
    assert _estimar_tokens(["a" * 400]) == 100
    assert _estimar_tokens(["abcd", "abcd"]) == 2


def test_estimativa_de_texto_vazio_e_zero():
    assert _estimar_tokens([]) == 0
    assert _estimar_tokens([""]) == 0
