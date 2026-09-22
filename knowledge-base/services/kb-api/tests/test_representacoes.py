"""Representações, métodos de acesso e o que os mantém coerentes.

O que este arquivo protege é o vocabulário, e não é preciosismo: confundir
**representação** (conjunto por Espaço) com **slot** (ponto de troca dentro de
uma representação) com **estrutura auxiliar** (outro caminho até o mesmo
conteúdo) foi o erro que custou a reescrita corrigida pelo ADR-0017. O sintoma
só aparece quando a segunda representação chega — `índice + wiki` não cabe num
enum — e aí o conserto é grande.

O outro alvo é o caso real: trinta bases heterogêneas e uma pergunta. Ele precisa
custar um punhado de métodos, não trinta buscas, e essa propriedade é fácil de
perder sem ninguém notar (a busca continua respondendo, só fica cara).
"""

from __future__ import annotations

import pytest

# ── o conjunto, e não um enum ─────────────────────────────────────────────


def test_o_indice_esta_sempre_ativo():
    """Ele é a representação de base: sem ele o Espaço não responde nada.

    Aceitar um JSON que o desligue seria aceitar quebrar a base em silêncio por
    um campo mal preenchido.
    """
    from kb_api import representations as rep

    for bruto in (None, {}, {"indice": False}, {"wiki": True}, {"indice": 0}):
        assert rep.INDICE in rep.Ativacao.from_space(bruto).ativas


def test_representacoes_se_somam(monkeypatch):
    """`indice + wiki` é o conjunto com as duas, e não um terceiro valor.

    É a razão de a coluna guardar um conjunto: três representações dariam sete
    valores de enum para descrever três interruptores.
    """
    from kb_api import representations as rep

    a = rep.Ativacao.from_space({"wiki": True})
    assert a.ativas == {rep.INDICE, rep.WIKI}
    assert a.metodos() == ["semantica", "lexical", "paginas", "paginas_lexical"]


def test_a_auxiliar_nao_e_representacao():
    """O grafo não cria conteúdo: os nós apontam para chunks que já existem.

    Por isso ele vive em `auxiliares`, e não em `ativas`. Misturar os dois na
    configuração repetiria, no dado, o erro de vocabulário que o ADR-0017
    corrige.
    """
    from kb_api import representations as rep

    a = rep.Ativacao.from_space({"grafo": True})
    assert rep.GRAFO not in a.ativas
    assert rep.GRAFO in a.auxiliares
    assert "travessia" in a.metodos()
    # A auxiliar é DO índice, e a travessia entrega chunk pai: o grafo é o
    # caminho, o índice é o destino.
    assert rep.CATALOGO_AUXILIAR[rep.GRAFO].de == rep.INDICE
    assert rep.METODOS["travessia"].representacao == rep.INDICE


def test_a_ordem_dos_metodos_e_estavel():
    """Ela aparece no trace e nos testes.

    Um conjunto iterado em ordem de hash faria o trace mudar entre execuções
    iguais, e a comparação entre técnicas (FUN-04) perderia a base.
    """
    from kb_api import representations as rep

    primeira = rep.Ativacao.from_space({"wiki": True, "grafo": True}).metodos()
    for _ in range(5):
        assert rep.Ativacao.from_space({"wiki": True, "grafo": True}).metodos() == primeira


# ── o caso das trinta bases ───────────────────────────────────────────────


def test_trinta_bases_custam_um_punhado_de_metodos():
    """A propriedade que o desenho inteiro existe para garantir.

    Sem o agrupamento, cada base nova acrescentaria uma ida ao banco por
    pergunta — e a busca continuaria respondendo, só ficando cara. É o tipo de
    regressão que ninguém nota até a conta chegar.
    """
    from kb_api import representations as rep

    ativacoes = {
        f"base-{i:02d}": rep.Ativacao.from_space({"wiki": i % 3 == 0, "grafo": i % 5 == 0})
        for i in range(30)
    }
    grupos = rep.agrupar_por_metodo(ativacoes)

    assert len(grupos) == 5, "cinco métodos, não trinta buscas"
    assert len(grupos["semantica"]) == 30, "o índice existe em toda base"
    assert len(grupos["paginas"]) == 10, "a wiki só onde foi ligada"
    assert len(grupos["travessia"]) == 6, "a travessia só onde o grafo foi ligado"


def test_espaco_com_duas_representacoes_entra_em_mais_de_um_grupo():
    """E é assim que tem de ser: ele contribui candidato por cada método.

    A sobreposição é resolvida na fusão, pela chave da unidade de entrega.
    """
    from kb_api import representations as rep

    grupos = rep.agrupar_por_metodo({"rh": rep.Ativacao.from_space({"wiki": True})})
    assert grupos["semantica"] == ["rh"]
    assert grupos["paginas"] == ["rh"]


# ── coerência entre o catálogo e o código ─────────────────────────────────


def test_todo_metodo_declarado_tem_recuperador():
    """Declarar um método sem implementá-lo quebraria só a base que o ativasse."""
    from kb_api import representations as rep
    from kb_api import retrieval

    assert set(retrieval.RECUPERADORES) == set(rep.METODOS)


def test_todo_metodo_pertence_a_uma_representacao_conhecida():
    from kb_api import representations as rep

    conhecidas = set(rep.REPRESENTACOES)
    for metodo in rep.METODOS.values():
        assert metodo.representacao in conhecidas, metodo.id


def test_toda_representacao_e_auxiliar_declaram_metodos_existentes():
    from kb_api import representations as rep

    for r in rep.CATALOGO.values():
        assert r.metodos, f"{r.id} sem método de acesso não é consultável"
        for m in r.metodos:
            assert m in rep.METODOS
    for a in rep.CATALOGO_AUXILIAR.values():
        for m in a.metodos:
            assert m in rep.METODOS


def test_o_catalogo_da_tela_nao_omite_nada():
    """A tela desenha o que vier: representação que não aparecer aqui some dela."""
    from kb_api import representations as rep

    assert {r["id"] for r in rep.catalogo_para_tela()} == set(rep.REPRESENTACOES)
    assert {a["id"] for a in rep.catalogo_auxiliar_para_tela()} == set(rep.AUXILIARES)


def test_so_o_indice_e_obrigatorio():
    from kb_api import representations as rep

    assert rep.CATALOGO[rep.INDICE].opcional is False
    assert rep.CATALOGO[rep.WIKI].opcional is True


def test_o_que_precisa_de_chat_esta_marcado():
    """A tela avisa ANTES de deixar ligar.

    Sem a marca, o operador liga a wiki numa base sem modelo de chat e nada
    acontece — em silêncio, que é o pior desfecho possível.
    """
    from kb_api import representations as rep

    assert rep.CATALOGO[rep.WIKI].needs_chat is True
    assert rep.CATALOGO[rep.INDICE].needs_chat is False
    assert rep.CATALOGO_AUXILIAR[rep.GRAFO].needs_chat is True


# ── a wiki: contrato e multi-vetor ────────────────────────────────────────


def test_secoes_alimentam_o_multi_vetor():
    """Um vetor por seção, todos resolvendo para a página inteira."""
    from kb_api.wiki import secoes

    pagina = "Abertura.\n\n## Como pedir\n\nPasso a passo.\n\n## Prazos\n\nTrinta dias."
    titulos = [t for t, _ in secoes(pagina)]
    assert titulos == ["", "Como pedir", "Prazos"]


def test_pagina_sem_cabecalho_ainda_entra_no_indice():
    """A rede de segurança não pode virar "página curta não é indexada"."""
    from kb_api.wiki import secoes

    assert len(secoes("Só um parágrafo solto.")) == 1
    assert secoes("") == []


@pytest.mark.parametrize(
    "palavras,fora",
    [(199, True), (200, False), (500, False), (800, False), (801, True)],
)
def test_o_contrato_de_tamanho_marca_mas_nao_recusa(palavras, fora):
    """Página fora da faixa continua valendo: recusar seria jogar conhecimento fora.

    A marca é para o lint da wiki, e foi ela que revelou, na primeira medição do
    e2e, que o modelo estava entregando 189 a 198 palavras.
    """
    from kb_api.wiki import Pagina

    assert Pagina(path="x.md", content="", words=palavras).fora_do_contrato is fora


# ── a travessia e o acento ────────────────────────────────────────────────


def test_a_travessia_ignora_acento():
    """O defeito que o e2e achou, e que não dava erro nenhum.

    O modelo extrai "Política de Férias"; a pergunta chega "ferias". O `CONTAINS`
    do Cypher é literal, então sem normalizar os dois lados a travessia devolvia
    zero em quase toda pergunta em português.
    """
    from kb_api.graph import _sem_acento

    assert _sem_acento("Política de Férias") == "politica de ferias"
    assert "ferias" in _sem_acento("Política de Férias")
    assert _sem_acento("ÁÉÍÓÚ ãõ ç") == "aeiou ao c"


# ── o grafo: extração e o que ela reporta ─────────────────────────────────


def _resposta(dados: dict):
    from kb_api import llm

    return lambda *a, **k: llm.Resposta(dados=dados, tokens=10, latency_ms=1, model="teste")


def test_extracao_separa_vazio_de_sem_resposta(monkeypatch):
    """Duas coisas que a lista vazia confundia, e a diferença importa.

    "O modelo respondeu e não achou entidade nomeada" é legítimo — o próprio
    prompt manda devolver vazio nesse caso. "O modelo não respondeu" é falha.
    Reportar as duas como `status: ok, entidades: 0` fazia uma extração que
    nunca aconteceu passar por uma que não tinha o que achar.
    """
    from kb_api import graph, llm

    monkeypatch.setattr(llm, "complete_json", _resposta({"entidades": [], "relacoes": []}))
    assert graph.extrair("texto") == ([], [], True)

    monkeypatch.setattr(llm, "complete_json", lambda *a, **k: None)
    assert graph.extrair("texto") == ([], [], False)


def test_relacao_com_entidade_fora_da_lista_e_descartada(monkeypatch):
    """Alucinação ou erro de transcrição: aceitar criaria nó solto.

    Um nó que a travessia nunca alcança e que ainda engorda a contagem do grafo.
    """
    from kb_api import graph, llm

    monkeypatch.setattr(
        llm,
        "complete_json",
        _resposta(
            {
                "entidades": [{"nome": "Política X", "tipo": "politica"}],
                "relacoes": [
                    {"de": "Política X", "tipo": "APROVADA_POR", "para": "Área Inexistente"},
                    {"de": "Política X", "tipo": "SUBSTITUI", "para": "Política X"},
                ],
            }
        ),
    )
    entidades, relacoes, respondeu = graph.extrair("texto")
    assert respondeu is True
    assert [e["nome"] for e in entidades] == ["Política X"]
    # A primeira cita entidade que não existe; a segunda é laço sobre si mesma.
    assert relacoes == []


def test_a_consulta_de_desenho_nao_usa_o_construto_que_derrubava_o_servidor():
    """Trava de regressão de um SIGSEGV real.

    A versão anterior montava nós e arestas numa consulta só, com `collect` +
    `UNWIND` + `OPTIONAL MATCH` + projeção de mapa com `CASE WHEN`. Reproduzido
    duas vezes contra o Memgraph 2.22.1: `Exit Code 139` e o contador de
    reinício subindo. Não era Cypher inválido — era defeito do servidor, e a
    consulta o encontrava.
    """
    import ast
    import inspect
    import textwrap

    from kb_api import graph

    # Pelo AST, e não por `in` na fonte: o docstring CITA os construtos ao
    # explicar a história, e uma busca textual acusaria a própria explicação.
    arvore = ast.parse(textwrap.dedent(inspect.getsource(graph.instancia)))
    funcao = arvore.body[0]
    assert isinstance(funcao, ast.FunctionDef)
    corpo = "\n".join(
        ast.unparse(no) for no in funcao.body if not isinstance(no, ast.Expr)
        or not isinstance(getattr(no, "value", None), ast.Constant)
    )
    assert "UNWIND" not in corpo, "o UNWIND do colchete de nós foi o que derrubou o servidor"
    assert "OPTIONAL MATCH" not in corpo
    # Duas consultas simples, e a de arestas casa por id -- sem gracinha.
    assert "id(a) IN $ids AND id(b) IN $ids" in corpo


def test_o_no_carrega_o_id_de_dominio_e_nao_so_o_id_interno_do_grafo():
    """Regressão de navegação quebrada, medida contra a stack real.

    O nó do documento 381 tinha `id(n) = 63` no Memgraph. A tela usava `id` para
    abrir o documento, e "Abrir o documento" caía em `documento 63 nao
    encontrado` — e se 63 existisse noutro Espaço levaria ao documento errado,
    sem erro nenhum. O `name` tinha o mesmo vício: um `:Chunk` era rotulado com
    `toString(id(n))`, um número que não existe fora do desenho.
    """
    import ast
    import inspect
    import textwrap

    from kb_api import graph

    assert "n.id AS ref" in graph._NOS_COM_ESPACO, (
        "sem `ref` a tela nao tem como abrir o que o no representa"
    )
    assert "AS ref" in graph._TERMOS_NO_ESCOPO, "toda linha de no precisa da mesma forma"

    arvore = ast.parse(textwrap.dedent(inspect.getsource(graph.instancia)))
    funcao = arvore.body[0]
    assert isinstance(funcao, ast.FunctionDef)
    # Pelo AST: o docstring conta a história e cita os dois construtos, então uma
    # busca textual na fonte acusaria a própria explicação.
    corpo = "\n".join(
        ast.unparse(no) for no in funcao.body
        if not (isinstance(no, ast.Expr) and isinstance(getattr(no, "value", None), ast.Constant))
    )
    assert "toString(id(n))" not in corpo, "id interno do Memgraph nao e nome de no"
    assert "toString(id(n))" not in graph._NOS_COM_ESPACO


def test_o_no_do_trecho_e_casado_sozinho_e_nao_dentro_do_caminho():
    """Regressão de nó duplicado, medida contra a stack real.

    `MERGE (e)-[:FROM_CHUNK]->(c:Chunk {id: $chunk})` casa o CAMINHO inteiro: se
    aquela entidade ainda não aponta para aquele trecho, o MERGE cria tudo,
    inclusive um `:Chunk` novo. O trecho 4651 virou oito nós, um por entidade, e
    o desenho ficou cheio de nós cinzas repetidos que pareciam trechos
    diferentes.
    """
    import inspect

    from kb_api import graph

    # Sem as linhas de comentário: elas CITAM o construto errado ao explicar o
    # defeito, e uma busca na fonte crua acusaria a própria explicação.
    fonte = "\n".join(
        linha for linha in inspect.getsource(graph.construir).splitlines()
        if not linha.strip().startswith(("//", "#"))
    )
    assert "MERGE (c:Chunk {id: $chunk, space: $space})" in fonte
    assert "MERGE (e)-[:FROM_CHUNK]->(c)" in fonte
    assert "FROM_CHUNK]->(c:Chunk" not in fonte, "o MERGE de caminho cria um :Chunk por entidade"


def test_a_limpeza_do_grafo_nao_usa_o_predicado_que_o_memgraph_recusa():
    """`WHERE NOT (t)<-[:MENTIONS]-()` devolve "Not yet implemented" na 2.22.1.

    O `except` de cada função engolia a recusa, e a limpeza passou a não rodar
    **em silêncio**: termo, entidade e trecho de documento removido continuavam
    no desenho. Por isso tudo aqui é `degree(n) = 0` ou agregação.
    """
    from kb_api import graph

    for consulta in (graph._LIMPA_TERMOS, graph._LIMPA_CONCEITOS, graph._LIMPA_CHUNKS):
        assert "degree(" in consulta
        assert "WHERE NOT (" not in consulta
    assert "count(DISTINCT d)" in graph._DONOS_DAS_ENTIDADES


def test_o_termo_entra_no_desenho_pela_aresta_e_nao_pelo_no():
    """Medido na carga de 40 manuais: o desenho vinha com zero arestas.

    O `:Term` não tem `space` (o nó é compartilhado entre bases de propósito), e
    a consulta do desenho filtrava `WHERE n.space IS NOT NULL` — o que apagava
    todo termo e, com ele, TODA aresta: no grafo lexical, que é o padrão de
    qualquer base, `Document -[:MENTIONS]-> Term` é a única ligação que existe.
    O esquema anunciava 209 termos e a tela mostrava 40 pontos soltos.
    """
    from kb_api import graph

    consulta = graph._TERMOS_NO_ESCOPO
    # O escopo vem do DOCUMENTO, não do termo: é isso que impede o desenho de
    # revelar que uma base proibida usa o mesmo assunto.
    assert "MATCH (d:Document)-[:MENTIONS]->(t:Term)" in consulta
    assert "d.space IS NOT NULL{escopo}" in consulta
    assert "count(DISTINCT d) AS grau" in consulta, "o grau conta so documento alcancavel"
    assert graph._clausula_de_espaco(["rh"], "d") == " AND d.space IN $spaces"


def test_o_foco_reaplica_o_escopo_no_vizinho():
    """A expansão do foco é o caminho mais silencioso para vazar base proibida.

    A semente pode ser um `:Term`, que é compartilhado entre bases de propósito.
    Expandir um salto a partir dele sem refiltrar traria documento de Espaço que
    o chamador não alcança — e apareceria como nome e título dentro da figura,
    que é o vazamento que esta tela inteira existe para evitar.
    """
    import inspect

    from kb_api import graph

    assert "id(a) IN $ids{escopo}" in graph._VIZINHOS
    # O vizinho sem `space` é outro termo, e só chega por aresta de um nó que já
    # está no escopo; o que TEM `space` precisa estar na lista.
    assert "b.space IS NULL OR b.space IN $spaces" in inspect.getsource(graph.instancia)


def test_o_grafo_inacessivel_nao_se_disfarca_de_grafo_vazio(monkeypatch):
    """Foi o que escondeu o SIGSEGV: a tela mostrou base sem grafo, não erro."""
    from kb_api import graph

    monkeypatch.setattr(graph, "_driver", lambda: None)
    resultado = graph.instancia(None)
    assert resultado["reachable"] is False
    assert resultado["nodes"] == []


def test_pagina_okf_sobrevive_a_embalagem_do_modelo():
    """O modelo devolve o arquivo dentro de ```markdown com frequência.

    `okf.parse` exige que o texto COMECE com `---`, então recusar por causa da
    embalagem joga fora uma página correta — e foi o que aconteceu: numa rodada
    do e2e as CINCO páginas foram descartadas por isso, e a representação inteira
    falhou com o documento intacto do outro lado.
    """
    from kb_api import okf
    from kb_api.wiki import _desembrulhar

    miolo = "---\ntype: policy\ntitle: X\n---\n\nCorpo da página."
    for embalagem in (
        miolo,
        f"```markdown\n{miolo}\n```",
        f"```\n{miolo}\n```",
        f"\n\n{miolo}\n",
    ):
        conceito = okf.parse(_desembrulhar(embalagem))
        assert conceito is not None and conceito.type == "policy"


def test_o_teto_de_tokens_e_generoso_de_proposito():
    """Modelo de raciocínio gasta o orçamento pensando ANTES de escrever.

    Com 900, o `gpt-5.6-luna` devolvia `content` vazio na extração de grafo
    enquanto a wiki (8000) funcionava no mesmo documento. Um teto apertado não
    trunca a resposta: consome o teto raciocinando e não sobra nada para
    escrever, e o 200 OK com conteúdo vazio parece "não achei nada".
    """
    from kb_api import llm

    assert llm.TETO_PADRAO >= 2000


# ── o vetor da pergunta, calculado uma vez ────────────────────────────────


def test_o_vetor_da_pergunta_e_reaproveitado_entre_metodos(monkeypatch):
    """O ADR-0017 promete "uma vez por modelo, compartilhado entre os métodos".

    O código não cumpria: `semantica` e `paginas` chamavam `embed` cada um, e uma
    base com índice + wiki pagava duas idas ao provedor pela mesma pergunta. E a
    ida custa caro — medido contra a stack, 1.033 ms, enquanto a busca inteira
    leva ~1.030 ms. O tempo da busca É a chamada de embedding.
    """
    from kb_api import retrieval
    from kb_api.embedding import EmbedResult

    chamadas = []

    def falso(textos, operacao, referencia):
        chamadas.append((textos[0], referencia))
        return EmbedResult(vectors=[[0.1, 0.2]], tokens=7, model="falso", latency_ms=1)

    monkeypatch.setattr(retrieval, "embed", falso)
    retrieval._cache.clear()

    primeiro, do_cache1 = retrieval.vetor_da_pergunta("como tirar férias", 1)
    segundo, do_cache2 = retrieval.vetor_da_pergunta("como tirar férias", 1)

    assert len(chamadas) == 1, "a segunda chamada tinha de sair do cache"
    assert primeiro.vectors == segundo.vectors
    assert do_cache1 is False and do_cache2 is True
    # Tokens contados de novo inflariam a conta do provedor na tela de consumo:
    # servir do cache não gasta token nenhum, e quem chama precisa saber disso.
    assert segundo.tokens == 7, "o resultado é o mesmo objeto; quem soma é que decide"

    # Provedor diferente é vetor diferente: a chave inclui a referência, senão
    # duas bases com modelos distintos compartilhariam o vetor errado, e isso
    # não daria erro nenhum — só busca ruim.
    retrieval.vetor_da_pergunta("como tirar férias", 2)
    assert len(chamadas) == 2


def test_o_cache_do_vetor_respeita_o_teto(monkeypatch):
    """Sem teto, o cache cresce com o tráfego e vira vazamento de memória."""
    from kb_api import retrieval
    from kb_api.embedding import EmbedResult

    monkeypatch.setattr(
        retrieval, "embed",
        lambda textos, operacao, referencia: EmbedResult(
            vectors=[[0.0]], tokens=1, model="falso", latency_ms=1
        ),
    )
    retrieval._cache.clear()
    for i in range(retrieval._CACHE_MAX + 20):
        retrieval.vetor_da_pergunta(f"pergunta {i}", 1)
    assert len(retrieval._cache) == retrieval._CACHE_MAX


def test_a_busca_nao_herda_a_paciencia_da_ingestao():
    """Quem espera muda a política, e o teto único fazia a tela travar.

    Na ingestão um blip de rede custa o documento inteiro, e esperar 180 s três
    vezes vale a pena. Na busca a mesma política dá nove minutos de tela parada
    — e a degradação existe: sem vetor, o Espaço sai do braço semântico e segue
    pelo lexical. Medido: com o teto único, a pior busca do benchmark levou
    32,5 s contra mediana de 1,07 s.
    """
    from kb_api import embedding

    assert embedding.TIMEOUT_POR_OPERACAO["search"] < embedding.TIMEOUT_PADRAO
    assert embedding.TENTATIVAS_POR_OPERACAO["search"] < embedding.EMBED_ATTEMPTS
    # Ingestão não pode ter sido afetada de carona.
    assert embedding.TIMEOUT_POR_OPERACAO.get("index", embedding.TIMEOUT_PADRAO) == 180
    piorCasoBusca = (
        embedding.TIMEOUT_POR_OPERACAO["search"] * embedding.TENTATIVAS_POR_OPERACAO["search"]
    )
    assert piorCasoBusca <= 20, "acima disto a busca deixa de ser interativa"


def test_a_consulta_vetorial_usa_a_MESMA_expressao_do_indice():
    """Trava de desempenho, e o modo de falha aqui é silencioso.

    O índice da migração 0008 é sobre a EXPRESSÃO `embedding::halfvec(3072)`.
    Índice de expressão só entra se o `ORDER BY` a escreve igual — voltar a
    `embedding <=> %s::vector` não dá erro nenhum, só devolve o seq scan. Com
    3.972 vetores isso custa 21 ms e ninguém nota; com cem mil, meio segundo por
    busca e mais de um gigabyte lido do disco.
    """
    import inspect
    import pathlib

    from kb_api import retrieval

    # Sem as linhas de comentário: o aviso dentro do código CITA a forma antiga
    # ao explicar o defeito, e uma busca na fonte crua acusaria a explicação.
    fonte = "\n".join(
        linha for linha in inspect.getsource(retrieval).splitlines()
        if not linha.strip().startswith("#")
    )
    assert "embedding::halfvec(3072) <=> %s::halfvec(3072)" in fonte
    # A forma antiga não pode reaparecer em nenhum dos dois métodos vetoriais.
    assert "embedding <=> %s::vector" not in fonte

    migracao = (
        pathlib.Path(retrieval.__file__).parent / "migrations" / "0008_indice_vetorial_hnsw.sql"
    ).read_text()
    assert "(embedding::halfvec(3072)) halfvec_cosine_ops" in migracao
    assert "chunk_embedding" in migracao and "wiki_page_vector" in migracao
    # Fora de transação: `CREATE INDEX CONCURRENTLY` não roda dentro de uma, e o
    # runner exige que essas sejam reexecutáveis.
    assert migracao.startswith("-- kb:no-transaction")
    assert migracao.count("CREATE INDEX CONCURRENTLY IF NOT EXISTS") == 2


def test_o_scan_iterativo_esta_ligado_porque_a_busca_sempre_filtra():
    """Índice aproximado + filtro é o caso clássico de resultado faltando.

    A busca SEMPRE restringe por Espaço. Sem `iterative_scan`, o HNSW devolve os
    40 vizinhos mais próximos e o filtro de Espaço deixa três — a base parece ter
    poucos resultados, sem erro nenhum. Com ele o scan continua puxando até o
    LIMIT ser satisfeito depois dos filtros.
    """
    from kb_api import retrieval

    ajustes = " ".join(retrieval._AJUSTES_HNSW)
    assert "iterative_scan" in ajustes
    # `relaxed_order` e não `strict_order`: o que sai daqui vai para o RRF, que
    # funde por posição junto com os outros métodos. Ordem estrita seria pagar
    # por uma precisão que a fusão desfaz na linha seguinte.
    assert "relaxed_order" in ajustes
    assert "ef_search" in ajustes


def test_nenhuma_limpeza_do_grafo_apaga_no_sem_dono():
    """O Memgraph de dev é COMPARTILHADO, e delete global apaga dado alheio.

    O `MEMGRAPH_HOST` do overlay aponta para a instância da plataforma, onde o
    agentic-sdlc grava `(:Project) (:WorkItem) (:Execution) (:File) (:Slice)
    (:Decision)` e `(:Concept {name})`. O rótulo `:Concept` **colide** com o
    nosso — e o overlay afirma que não há colisão porque a lista dele foi
    escrita quando o knowledge-base ainda não gravava conceito.

    Um `MATCH (c:Concept) WHERE degree(c) = 0 DELETE c` global apagaria conceito
    órfão do outro serviço, sem erro nenhum e sem rastro. O critério de posse é a
    propriedade que só o knowledge-base grava.
    """
    from kb_api import graph

    for consulta in (graph._LIMPA_TERMOS, graph._LIMPA_CONCEITOS, graph._LIMPA_CHUNKS):
        assert "DELETE" in consulta
        assert "IS NOT NULL" in consulta, f"delete sem dono: {consulta}"

    # `space` no conceito e no trecho; `norm` no termo, que não tem Espaço por
    # ser compartilhado ENTRE bases (é o que liga assuntos iguais).
    assert "c.space IS NOT NULL" in graph._LIMPA_CONCEITOS
    assert "c.space IS NOT NULL" in graph._LIMPA_CHUNKS
    assert "t.norm IS NOT NULL" in graph._LIMPA_TERMOS


def test_o_script_de_reconstrucao_nao_apaga_chunk_alheio():
    """Mesma razão, e aqui o estrago seria maior: ele apaga para recriar."""
    import pathlib as _pathlib

    fonte = (
        _pathlib.Path(__file__).resolve().parents[3] / "scripts" / "rebuild-graph.py"
    ).read_text()
    sem_comentario = "\n".join(
        linha for linha in fonte.splitlines() if not linha.strip().startswith("#")
    )
    assert "MATCH (c:Chunk) DETACH DELETE c" not in sem_comentario
    assert "MATCH (c:Chunk) WHERE c.space IS NOT NULL DETACH DELETE c" in sem_comentario


def test_o_mcp_nao_bloqueia_o_event_loop():
    """Regressão de desempenho, medida pelo protocolo.

    O handler é `async` (precisa de `await request.body()`), mas `mcp.handle`
    faz consulta ao Postgres e uma ida ao provedor de embedding. Chamado direto,
    roda no event loop — e enquanto roda, nenhuma outra requisição do processo
    anda, incluindo a probe de liveness.

    Medido antes da correção: 25 chamadas MCP simultâneas levavam 7,7 s, contra
    2,2 s de 50 buscas pela REST. Não era mais lento por fazer mais; era mais
    lento por serializar.
    """
    import inspect

    from kb_api import main

    corpo = inspect.getsource(main.mcp_endpoint)
    sem_comentario = "\n".join(
        linha for linha in corpo.splitlines() if not linha.strip().startswith("#")
    )
    # Nenhuma chamada direta: toda passagem por `mcp.handle` é via threadpool.
    assert "await run_in_threadpool(mcp.handle" in sem_comentario
    assert "mcp.handle(item, principal, base) for item in lote" in sem_comentario
    # Resolver o token de conexão lê o banco, e estava no mesmo caminho.
    assert "await run_in_threadpool(\n            principal_from_authorization" in sem_comentario


def test_o_deploy_no_meio_de_uma_carga_nao_deixa_trabalho_pendurado():
    """Regressão de um defeito operacional, não de código.

    A ingestão é síncrona e leva minutos. Subir versão no meio de uma carga mata
    o processo no meio do arquivo. O documento não fica pela metade — ele é uma
    transação só, que não commita —, mas a linha do log já foi aberta como
    `running` e ninguém a fecha.

    O efeito não passa sozinho: a tela mostra "em andamento" para sempre, e a
    rota de benchmark RECUSA iniciar execução nova enquanto houver uma
    `running` — ou seja, um deploy no meio de uma execução trava o recurso até
    alguém mexer no banco.
    """
    import inspect

    from kb_api import main

    corpo = inspect.getsource(main._fechar_trabalhos_orfaos)
    for tabela in ("ingest_run", "benchmark_run"):
        assert tabela in corpo, tabela
    assert "WHERE status = 'running'" in corpo
    # A mensagem diz o que aconteceu E o que fazer: "envie de novo" é a ação.
    assert "envie de novo" in corpo
    # E roda no startup, depois das migrações.
    assert "_fechar_trabalhos_orfaos()" in inspect.getsource(main.startup)


# ── retentativa automatica ────────────────────────────────────────────────


def test_a_classificacao_de_erro_na_duvida_retenta():
    """Errar para o lado de retentar custa cinco tentativas espaçadas; errar
    para o outro deixa um documento fora da base sem ninguém saber."""
    from kb_api.ingest import DEFINITIVO, RECUPERAVEL, classificar_erro

    # Passageiros: passam sozinhos.
    assert classificar_erro("falha de rede no embedding: Max retries exceeded") == RECUPERAVEL
    assert classificar_erro("Azure recusou o embedding: HTTP 429") == RECUPERAVEL
    assert classificar_erro("nenhum provedor de IA configurado") == RECUPERAVEL
    assert classificar_erro("erro que nunca vimos antes") == RECUPERAVEL

    # Definitivos: tentar de novo produz o mesmo erro.
    assert classificar_erro(
        "nenhum extrator produziu texto para x.pdf (tentados: docling, plain)"
    ) == DEFINITIVO
    assert classificar_erro("o modelo devolveu 1536 dimensoes, mas o indice espera 3072") == (
        DEFINITIVO
    )
    assert classificar_erro("HTTP 400 invalid_request") == DEFINITIVO
    assert classificar_erro("arquivo de 300 MB passa do limite de 100 MB") == DEFINITIVO


def test_o_backoff_cresce_e_termina():
    """Espera fixa bate de novo no provedor que acabou de recusar; espera sem
    fim deixa a fila girando para sempre."""
    from kb_api.ingest import BACKOFF_MINUTOS, MAX_TENTATIVAS

    assert list(BACKOFF_MINUTOS) == sorted(BACKOFF_MINUTOS)
    assert BACKOFF_MINUTOS[0] >= 5, "menos que isso bate no provedor que acabou de recusar"
    assert MAX_TENTATIVAS == len(BACKOFF_MINUTOS)


def test_a_retentativa_forca_a_reingestao():
    """Sem `force`, a deduplicação por conteúdo veria o mesmo sha e devolveria
    "já indexado" — da linha que justamente FALHOU."""
    import inspect

    from kb_api import retry

    fonte = inspect.getsource(retry.rodada)
    assert "force=True" in fonte
    # E a linha que falhou só sai DEPOIS do sucesso.
    assert fonte.index("resultado.status == \"indexed\"") < fonte.index("DELETE FROM document")


def test_a_wiki_diz_POR_QUE_nao_saiu_pagina():
    """Regressão de diagnóstico, de uma carga real.

    Três de catorze documentos ficaram sem wiki, e a mensagem era sempre "a
    destilação não produziu página" — sem como saber se o modelo não respondeu,
    se ele julgou o assunto já coberto, ou se o que ele devolveu foi recusado
    na porta. São três consertos diferentes: provedor, prompt e contrato.
    """
    import inspect

    from kb_api import wiki

    fonte = inspect.getsource(wiki.destilar)
    assert "o modelo de chat não respondeu" in fonte
    assert "já está coberto pela wiki atual" in fonte
    assert "todas foram recusadas" in fonte
    # A assinatura devolve o motivo junto: sem isso, `construir` teria de
    # adivinhar, que é exatamente o que ela fazia.
    assert inspect.signature(wiki.destilar).return_annotation == "tuple[list[Pagina], str]"


def test_o_indice_da_wiki_nao_cresce_sem_limite_no_prompt(monkeypatch):
    """O índice inteiro era reenviado em CADA destilação.

    Medido numa carga real: 8.466 caracteres com 35 páginas, e a mesma base
    fechou com 74 — perto de 18 mil caracteres gastos antes de o modelo ver uma
    linha do documento. Numa base de trezentos documentos não cabe em orçamento
    nenhum.
    """
    from kb_api import wiki

    paginas = [
        {"path": f"{chr(97 + i % 26)}/pagina-{i}.md", "type": "Política",
         "title": f"Assunto {i}", "description": "algo genérico"}
        for i in range(120)
    ]
    # A de férias fica no fim do alfabeto de propósito: o corte ingênuo por
    # ordem alfabética a deixaria de fora justamente quando ela é a relevante.
    paginas.append({"path": "z/ferias.md", "type": "Política",
                    "title": "Política de Férias", "description": "prazos e aprovação"})

    class _Cur:
        def execute(self, *a, **k): pass
        def fetchall(self):
            return [(p["path"], p["type"], p["title"], p["description"]) for p in paginas]
        def __enter__(self): return self
        def __exit__(self, *a): return False

    class _Conn:
        def cursor(self): return _Cur()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(wiki, "conn", lambda: _Conn())

    saida = wiki._indice_do_espaco("rh", "Manual de Férias e Afastamentos")
    assert len(saida) == wiki.MAX_PAGINAS_NO_INDICE
    # A relevante entrou, apesar de estar no fim do alfabeto.
    assert any(p["path"] == "z/ferias.md" for p in saida)
    # E a saída volta ordenada por caminho: lista estável é mais fácil de ler, e
    # a ordem por afinidade não significa nada para o modelo.
    assert [p["path"] for p in saida] == sorted(p["path"] for p in saida)


def test_o_indice_pequeno_vai_inteiro(monkeypatch):
    """Sem corte quando não precisa: cortar o que cabe só tiraria contexto."""
    from kb_api import wiki

    paginas = [{"path": f"p{i}.md", "type": "Manual", "title": f"T{i}", "description": ""}
               for i in range(5)]

    class _Cur:
        def execute(self, *a, **k): pass
        def fetchall(self):
            return [(p["path"], p["type"], p["title"], p["description"]) for p in paginas]
        def __enter__(self): return self
        def __exit__(self, *a): return False

    class _Conn:
        def cursor(self): return _Cur()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(wiki, "conn", lambda: _Conn())
    assert len(wiki._indice_do_espaco("rh", "qualquer coisa")) == 5


# ── o erro da representação não pode carregar credencial ────────────────────
#
# `document_representation.error` guarda a mensagem que `llm.py` monta com 200
# bytes crus do corpo de recusa do provedor, e ela passou a sair em
# `/v1/documents/{id}` -- rota de `current_principal`, não de administrador.


def test_mascara_chave_no_erro_da_representacao():
    """Provedor recusando credencial devolve pedaço de chave no corpo."""
    from kb_api.search import _sem_segredo

    saida = _sem_segredo(
        "openai recusou o chat: HTTP 401 Incorrect API key provided: sk-proj-AbCdEf123456XyZw."
    )
    assert "sk-proj-AbCdEf123456XyZw" not in saida
    assert "[oculto:…XyZw]" in saida
    assert "HTTP 401" in saida  # o que serve para operar continua legível


def test_mascara_token_bearer():
    from kb_api.search import _sem_segredo

    saida = _sem_segredo("falha: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 rejeitado")
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in saida


def test_nao_mascara_nome_de_arquivo_longo():
    """O falso positivo que torna a máscara inútil.

    `Politica_de_Diversidade_e_Inclusao_2025` tem 39 caracteres. Mascará-lo
    apagaria exatamente a parte do erro que diz de que documento se trata.
    """
    from kb_api.search import _sem_segredo

    texto = "Politica_de_Diversidade_e_Inclusao_2025.docx: não saiu em OKF válido"
    assert _sem_segredo(texto) == texto


def test_nao_mexe_nas_mensagens_curadas():
    """As três razões da destilação são texto nosso, e passam intactas."""
    from kb_api.search import _sem_segredo

    for msg in (
        "o modelo de chat não respondeu",
        "o modelo respondeu sem nenhuma página: avaliou que o documento já está coberto",
        "o modelo devolveu 2 página(s) e todas foram recusadas: manuais/ferias: caminho inválido",
    ):
        assert _sem_segredo(msg) == msg


def test_erro_vazio_passa_reto():
    from kb_api.search import _sem_segredo

    assert _sem_segredo(None) is None
    assert _sem_segredo("") == ""
