"""Cada base escolhe o seu modelo: a resolucao, o cache e a queda para o padrao.

O que este arquivo protege sao os tres modos de falha que a escolha por Espaco
introduziu, e nenhum deles daria erro visivel:

1. **o cache com a chave errada.** A chave e `(proposito, Espaco)`. Se fosse so
   o proposito, a primeira base a consultar gravaria o provedor dela e as outras
   usariam o modelo errado por ate um minuto -- vetorizando com um modelo e
   consultando um indice de outro, sem nada falhar;
2. **a queda para o padrao.** Provedor apagado (`ON DELETE SET NULL`) ou
   desativado tem de levar a base de volta ao padrao da instalacao, nunca a
   parar de indexar;
3. **a dimensao.** `chunk_embedding` tem `vector(N)` fixo no DDL. Aceitar um
   provedor de outra dimensao por Espaco faria toda ingestao daquela base falhar
   -- e a guarda do `is_default` nao cobre este caminho, que e novo.

Os testes de resolucao rodam contra Postgres de verdade e sao PULADOS quando
nao ha um -- mesmo criterio de `test_migrate.py`. Fingir o banco aqui seria
testar o dublê, ja que o que se quer travar e justamente a consulta.
"""

from __future__ import annotations

import dataclasses
import os

import psycopg
import pytest

from kb_api import migrate as m


def _postgres_disponivel() -> bool:
    try:
        with psycopg.connect(m.settings.pg_dsn, connect_timeout=3):
            return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(
    not _postgres_disponivel(),
    reason=f"sem Postgres em {os.environ.get('POSTGRES_HOST', 'postgres')}",
)


def _aplicar_migracoes(conexao) -> None:
    """Aplica em `conexao` as migracoes que cabem numa transacao."""
    with conexao.cursor() as cur:
        for mig in m.discover():
            if not mig.in_transaction:
                # O Postgres recusa CREATE INDEX CONCURRENTLY dentro de bloco de
                # transacao, e a recusa e do COMANDO, nao do efeito: acontece
                # igual com `IF NOT EXISTS` e o indice ja criado. Nao e sintoma
                # de banco novo, e nenhuma ordem de execucao aqui dentro evita.
                #
                # Aplicar as de fora de transacao em autocommit antes de abrir a
                # transacao faria os testes passarem gravando o indice na base
                # apontada (que pode ser a de dev), que e exatamente o que o
                # paragrafo acima recusa. Entao aqui elas sao PULADAS.
                #
                # Pular so e honesto porque toda migracao fora de transacao ate
                # hoje e acessoria (`-- kb:opcional`): a 0008 e o indice HNSW, e
                # sem ele a busca continua correta, so varre. No dia em que uma
                # delas nao for acessoria, o esquema destes testes ficaria
                # incompleto e nada falharia sozinho. Dai a quebra abaixo, em vez
                # de um `continue` calado.
                if not mig.opcional:
                    pytest.fail(
                        f"a migracao {mig.label} roda fora de transacao e nao e "
                        "acessoria. Esta fixture nao tem como aplica-la, e pular "
                        "deixaria os testes rodando contra um esquema incompleto. "
                        "Reveja a fixture antes de seguir."
                    )
                continue
            cur.execute(mig.sql())


@pytest.fixture()
def banco(monkeypatch):
    """Transacao isolada, sempre desfeita.

    Rollback em vez do `DROP SCHEMA` de `test_migrate.py`: aqui os testes nao
    precisam de base limpa, e a base apontada pode ser a de dev, com conteudo
    real. Um teste que deixasse provedor ou Espaco para tras apareceria na tela
    de alguem -- e ja apareceu, ver `_SemCommit` abaixo.

    As migracoes sao aplicadas DENTRO da transacao, e nao por `m.migrate()`:
    elas sao idempotentes (`IF NOT EXISTS` em tudo), entao rodam aqui sem
    conflito e desaparecem no rollback. Chamar o runner de verdade gravaria o
    esquema na base apontada -- que pode ser a de dev -- e um teste nao deve
    migrar o ambiente de ninguem.

    A contrapartida de migrar dentro da transacao esta em `_aplicar_migracoes`:
    migracao marcada `-- kb:no-transaction` nao cabe aqui, e e pulada.
    """
    from kb_api import db, providers

    # A cifra da credencial nao pode depender do ambiente de quem roda.
    #
    # `_provedor` chama `providers.cifrar`, que se RECUSA a gravar sem
    # `KB_SECRET_KEY`. Ela e variavel de deploy: quem a tem exportada ve o
    # arquivo passar, quem nao tem ve quinze testes falharem por um motivo que
    # nao e o codigo sob teste. Fixar aqui tira o ambiente da conta.
    #
    # `dataclasses.replace` e nao `monkeypatch.setenv` porque `Settings` e
    # frozen e ja foi construida na importacao: mexer na variavel agora nao
    # alcancaria o objeto que `providers` segura. Mesmo desvio de
    # `test_oauth_estado.py`.
    monkeypatch.setattr(
        providers,
        "settings",
        dataclasses.replace(
            providers.settings, secret_key="chave-de-teste-nao-usar-em-producao"
        ),
    )

    conexao = psycopg.connect(m.settings.pg_dsn)
    conexao.autocommit = False
    # Falhar aqui dentro sem fechar a conexao TRAVA a proxima rodada, nao apenas
    # esta: a transacao aberta continua segurando o ACCESS EXCLUSIVE que a 0001
    # toma ao criar as tabelas, e o proximo teste fica esperando o lock ate o
    # timeout. Vale para QUALQUER erro aqui, e era o que acontecia enquanto a
    # 0008 quebrava o setup: cada arquivo de teste deixava uma conexao pendurada.
    try:
        _aplicar_migracoes(conexao)
    except BaseException:
        conexao.close()
        raise

    class _SemCommit:
        """A conexao da transacao, com `commit()` NEUTRALIZADO.

        Sem isto, o rollback do fim nao segura nada: `providers.registrar_uso`
        faz `connection.commit()` a cada chamada de IA registrada, e um commit
        no meio publica TUDO que a transacao acumulou -- Espacos, documentos e
        provedores de mentira.

        Isto nao e hipotese: aconteceu. Uma rodada destes testes deixou tres
        provedores (`chat-de-teste`, `emb-de-teste`, `chat-quebrado`) e as
        linhas de uso deles gravados na base de dev, porque
        `main.test_ai_provider` chama `registrar_uso`. Foram removidos a mao, e
        esta classe existe para o proximo teste que tocar codigo com commit nao
        repetir isso.
        """

        def __init__(self, real):
            self._real = real

        def commit(self):
            pass

        def __getattr__(self, nome):
            return getattr(self._real, nome)

    protegida = _SemCommit(conexao)

    class _Escopo:
        def __enter__(self):
            return protegida

        def __exit__(self, *_):
            return False

    # TODO modulo que fale com o banco entra no desvio, e nao so os tres obvios.
    #
    # Cada um tem o SEU nome `conn`: eles fazem `from .db import conn`, que copia
    # a referencia na importacao, entao trocar `db.conn` nao alcanca nenhum
    # deles. Deixar um de fora nao da erro -- da TRAVA: a migracao aplicada
    # dentro desta transacao toma ACCESS EXCLUSIVE em `space`, e o modulo
    # esquecido abre uma conexao do pool de verdade e fica esperando o lock
    # ate o fim do teste.
    #
    # A varredura e por atributo, e nao por lista de nomes, justamente para o
    # proximo modulo com `conn` nao reintroduzir a trava sem ninguem notar.
    import importlib
    import pkgutil

    import kb_api

    escopo = _Escopo()
    alvos = [db, providers]
    for info in pkgutil.iter_modules(kb_api.__path__):
        modulo = importlib.import_module(f"kb_api.{info.name}")
        if hasattr(modulo, "conn") and modulo not in alvos:
            alvos.append(modulo)

    originais = {modulo: modulo.conn for modulo in alvos}
    for modulo in originais:
        modulo.conn = lambda: escopo
    providers.invalidar()
    try:
        yield conexao
    finally:
        conexao.rollback()
        conexao.close()
        for modulo, original in originais.items():
            modulo.conn = original
        providers.invalidar()


def _provedor(cur, nome: str, purpose: str, modelo: str, dimensoes: int, padrao: bool) -> int:
    from kb_api import providers

    cur.execute(
        """
        INSERT INTO ai_provider
            (name, kind, endpoint, api_key_enc, api_key_tail, model, dimensions,
             purpose, is_default, active)
        VALUES (%s,'openai','https://exemplo.invalido',%s,'0000',%s,%s,%s,%s,TRUE)
        RETURNING id
        """,
        (nome, providers.cifrar("chave-de-teste"), modelo, dimensoes, purpose, padrao),
    )
    return cur.fetchone()[0]


def _espaco(cur, slug: str) -> None:
    cur.execute(
        "INSERT INTO space (slug, label) VALUES (%s, %s) ON CONFLICT (slug) DO NOTHING",
        (slug, slug),
    )


def test_espaco_sem_escolha_usa_o_padrao_da_instalacao(banco):
    """O estado de toda base ja gravada. Nenhuma pode mudar por esta entrega."""
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        padrao = _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        _espaco(cur, "teste-sem-escolha")

    providers.invalidar()
    assert providers.padrao("embedding", "teste-sem-escolha").id == padrao
    assert providers.padrao("embedding").id == padrao


def test_a_escolha_do_espaco_ganha_do_padrao(banco):
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        proprio = _provedor(cur, "proprio-emb", "embedding", "modelo-proprio", 3072, False)
        _espaco(cur, "teste-com-escolha")
        cur.execute(
            "UPDATE space SET embedding_provider_id = %s WHERE slug = %s",
            (proprio, "teste-com-escolha"),
        )

    providers.invalidar()
    escolhido = providers.padrao("embedding", "teste-com-escolha")
    assert escolhido.id == proprio
    assert escolhido.model == "modelo-proprio"


def test_duas_bases_com_modelos_diferentes_nao_se_contaminam(banco):
    """O teste do cache, e o motivo dele existir.

    Com a chave do cache so no proposito, a segunda base receberia o provedor da
    primeira por ate um minuto -- e vetorizar com um modelo contra um indice de
    outro nao levanta erro nenhum, so devolve resultado pior.
    """
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        um = _provedor(cur, "emb-um", "embedding", "modelo-um", 3072, False)
        dois = _provedor(cur, "emb-dois", "embedding", "modelo-dois", 3072, False)
        for slug, provider_id in (("teste-a", um), ("teste-b", dois)):
            _espaco(cur, slug)
            cur.execute(
                "UPDATE space SET embedding_provider_id = %s WHERE slug = %s", (provider_id, slug)
            )

    providers.invalidar()
    # A ORDEM importa: a primeira chamada e a que povoaria o cache errado.
    assert providers.padrao("embedding", "teste-a").model == "modelo-um"
    assert providers.padrao("embedding", "teste-b").model == "modelo-dois"
    assert providers.padrao("embedding", "teste-a").model == "modelo-um"


def test_provedor_desativado_cai_para_o_padrao(banco):
    """Degradacao previsivel: a base volta ao padrao, nunca para de indexar."""
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        padrao = _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        proprio = _provedor(cur, "proprio-emb", "embedding", "modelo-proprio", 3072, False)
        _espaco(cur, "teste-desativado")
        cur.execute(
            "UPDATE space SET embedding_provider_id = %s WHERE slug = %s",
            (proprio, "teste-desativado"),
        )
        cur.execute("UPDATE ai_provider SET active = FALSE WHERE id = %s", (proprio,))

    providers.invalidar()
    assert providers.padrao("embedding", "teste-desativado").id == padrao


def test_provedor_apagado_solta_o_vinculo_sem_quebrar_o_espaco(banco):
    """`ON DELETE SET NULL`, e nao RESTRICT.

    Com RESTRICT o operador descobriria o vinculo so ao tentar apagar, e teria
    de caçar quais Espacos apontavam para la sem nenhuma tela que dissesse.
    """
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        padrao = _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        proprio = _provedor(cur, "proprio-emb", "embedding", "modelo-proprio", 3072, False)
        _espaco(cur, "teste-apagado")
        cur.execute(
            "UPDATE space SET embedding_provider_id = %s WHERE slug = %s",
            (proprio, "teste-apagado"),
        )
        cur.execute("DELETE FROM ai_provider WHERE id = %s", (proprio,))
        cur.execute(
            "SELECT embedding_provider_id FROM space WHERE slug = %s", ("teste-apagado",)
        )
        assert cur.fetchone()[0] is None

    providers.invalidar()
    assert providers.padrao("embedding", "teste-apagado").id == padrao


def test_resolvido_diz_de_onde_a_escolha_veio(banco):
    """"padrao da instalacao" e "escolhido nesta base" sao estados diferentes.

    Mostrar so o nome do modelo esconderia qual dos dois e -- inclusive no caso
    em que a escolha caiu por o provedor ter sido apagado.
    """
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        proprio = _provedor(cur, "proprio-emb", "embedding", "modelo-proprio", 3072, False)
        _espaco(cur, "teste-origem-a")
        _espaco(cur, "teste-origem-b")
        cur.execute(
            "UPDATE space SET embedding_provider_id = %s WHERE slug = %s",
            (proprio, "teste-origem-b"),
        )

    providers.invalidar()
    assert providers.resolvido("embedding", "teste-origem-a")["from_space"] is False
    resolvido_b = providers.resolvido("embedding", "teste-origem-b")
    assert resolvido_b["from_space"] is True
    assert resolvido_b["model"] == "modelo-proprio"


def test_chat_e_embedding_sao_escolhas_independentes(banco):
    from kb_api import providers

    with banco.cursor() as cur:
        cur.execute("UPDATE ai_provider SET is_default = FALSE")
        _provedor(cur, "padrao-emb", "embedding", "emb-padrao", 3072, True)
        _provedor(cur, "padrao-chat", "chat", "chat-padrao", 0, True)
        chat_proprio = _provedor(cur, "chat-proprio", "chat", "chat-da-base", 0, False)
        _espaco(cur, "teste-so-chat")
        cur.execute(
            "UPDATE space SET chat_provider_id = %s WHERE slug = %s",
            (chat_proprio, "teste-so-chat"),
        )

    providers.invalidar()
    # Escolher o chat nao mexe no embedding.
    assert providers.padrao("chat", "teste-so-chat").model == "chat-da-base"
    assert providers.padrao("embedding", "teste-so-chat").model == "emb-padrao"


def test_o_agrupamento_por_modelo_de_embedding_vive_no_metodo_semantico(banco):
    """Uma vetorizacao por MODELO, nao por metodo nem por Espaco.

    O vetor da pergunta nao depende da representacao que vai ser consultada, so
    do modelo. Por isso o agrupamento mora dentro do metodo semantico: se
    vivesse na busca, um metodo novo que tambem use vetor multiplicaria as
    chamadas de embedding em vez de reaproveitar.
    """
    from kb_api import providers, retrieval

    with banco.cursor() as cur:
        cur.execute("UPDATE space SET embedding_provider_id = NULL")
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = 'embedding'")
        _provedor(cur, "padrao-emb", "embedding", "modelo-padrao", 3072, True)
        _espaco(cur, "teste-a")
        _espaco(cur, "teste-b")

    providers.invalidar()
    # Sem escolha por base: um grupo so, uma vetorizacao.
    assert len(retrieval._grupos_de_embedding(["teste-a", "teste-b"])) == 1

    with banco.cursor() as cur:
        outro = _provedor(cur, "outro-emb", "embedding", "modelo-outro", 3072, False)
        cur.execute(
            "UPDATE space SET embedding_provider_id = %s WHERE slug = %s", (outro, "teste-b")
        )

    providers.invalidar()
    grupos = retrieval._grupos_de_embedding(["teste-a", "teste-b"])
    assert len(grupos) == 2, "modelos diferentes precisam de vetorizacoes diferentes"
    # Cada grupo leva um Espaco de referencia, que e por quem a pergunta sera
    # vetorizada para aquele conjunto.
    assert sorted(slug for _, membros in grupos for slug in membros) == ["teste-a", "teste-b"]


def test_a_busca_nao_vira_uma_consulta_por_base(banco):
    """O caso das trinta bases, que e o que manda no desenho.

    Trinta Espacos com representacoes diferentes precisam custar UM punhado de
    metodos, nao trinta buscas. Sem o agrupamento, cada base nova acrescentaria
    uma ida ao banco por consulta.
    """
    from kb_api import representations as rep

    ativacoes = {
        f"base-{i:02d}": rep.Ativacao.from_space({"wiki": i % 3 == 0}) for i in range(30)
    }
    grupos = rep.agrupar_por_metodo(ativacoes)

    assert sorted(grupos) == ["lexical", "paginas", "paginas_lexical", "semantica"]
    assert len(grupos["semantica"]) == 30
    assert len(grupos["lexical"]) == 30
    # A wiki so entra onde esta ligada: os metodos dela nao sao acionados nas
    # bases que nao a tem. Sao DOIS, `paginas` e `paginas_lexical`, e a lista
    # acima segue o CATALOGO: metodo novo faz esta linha quebrar de proposito,
    # que e a hora de conferir se ele foi mesmo agrupado.
    assert len(grupos["paginas"]) == 10
    assert len(grupos["paginas_lexical"]) == 10


# ── listagem de modelos com a credencial gravada ──────────────────────────
#
# `POST /v1/ai/models` aceita `provider_id` para usar a chave que ja esta no
# banco, porque a tela nunca a reexibe (ADR-0009). Isso abre um caminho que
# precisa de amarra: sem ela, um administrador poderia apontar uma credencial
# que ele NAO pode ler para um endpoint proprio e le-la do outro lado --
# transformando a rota num vazador da chave que o ADR-0009 existe para proteger.


def test_credencial_gravada_so_vale_para_o_endpoint_do_proprio_cadastro(banco):
    from fastapi import HTTPException

    from kb_api import main

    with banco.cursor() as cur:
        provider_id = _provedor(cur, "azure-salvo", "embedding", "emb", 3072, False)
        cur.execute(
            "UPDATE ai_provider SET kind = 'azure_openai', endpoint = %s WHERE id = %s",
            ("https://recurso.openai.azure.com", provider_id),
        )

    with pytest.raises(HTTPException) as erro:
        main.list_ai_models(
            {
                "kind": "azure_openai",
                "provider_id": provider_id,
                "endpoint": "https://coletor.exemplo.invalido",
            },
            principal=None,
        )
    assert erro.value.status_code == 400
    assert "endpoint" in erro.value.detail


def test_credencial_gravada_exige_o_mesmo_tipo(banco):
    """Tipo diferente muda o header de autenticacao.

    Um cadastro Azure (`api-key`) listado como `openai` mandaria a chave num
    `Authorization: Bearer` para outro host.
    """
    from fastapi import HTTPException

    from kb_api import main

    with banco.cursor() as cur:
        provider_id = _provedor(cur, "azure-salvo", "embedding", "emb", 3072, False)
        cur.execute(
            "UPDATE ai_provider SET kind = 'azure_openai', endpoint = %s WHERE id = %s",
            ("https://recurso.openai.azure.com", provider_id),
        )

    with pytest.raises(HTTPException) as erro:
        main.list_ai_models(
            {"kind": "openai", "provider_id": provider_id}, principal=None
        )
    assert erro.value.status_code == 400


def test_com_o_endpoint_certo_a_chave_gravada_e_usada(banco, monkeypatch):
    """O caminho feliz: o operador lista sem redigitar a credencial."""
    from kb_api import catalog, main

    with banco.cursor() as cur:
        provider_id = _provedor(cur, "azure-salvo", "embedding", "emb", 3072, False)
        cur.execute(
            "UPDATE ai_provider SET kind = 'azure_openai', endpoint = %s WHERE id = %s",
            ("https://recurso.openai.azure.com", provider_id),
        )

    recebido: dict = {}

    def falso(kind, endpoint, api_key):
        recebido.update(kind=kind, endpoint=endpoint, api_key=api_key)
        return "deployments", [catalog.Modelo(id="emb-large-v2", model="text-embedding-3-large")]

    monkeypatch.setattr(catalog, "listar", falso)

    class _Quem:
        def describe(self):
            return "teste"

    resposta = main.list_ai_models(
        {"kind": "azure_openai", "provider_id": provider_id}, principal=_Quem()
    )
    assert recebido["endpoint"] == "https://recurso.openai.azure.com"
    # A chave decifrada chega ao cliente, e NAO volta na resposta.
    assert recebido["api_key"] == "chave-de-teste"
    assert "chave-de-teste" not in str(resposta)
    assert resposta["source"] == "deployments"
    assert resposta["models"] == [
        {"id": "emb-large-v2", "model": "text-embedding-3-large", "label": ""}
    ]


# ── desalinhamento: motor E modo ──────────────────────────────────────────
#
# `chunk_engine` sozinho deixava passar a troca de modo -- e o modo muda mais do
# que a fronteira do corte: ele muda o TEXTO INDEXADO. Medido com `ts_rank_cd`
# no mesmo trecho, a pergunta "qual a politica de alcadas de contratacao" pontua
# 0,0000 sem o cabecalho do conceito e 0,4000 com ele. Uma base com os dois
# modos convivendo responde pela metade, sem nada na tela dizendo por que.


def _documento(cur, espaco: str, nome: str, engine: str, enriquecimento: str) -> int:
    cur.execute(
        """
        INSERT INTO document
            (space_slug, filename, title, content_sha, mime, size_bytes, raw_key,
             canonical_md, extractor, chunk_engine, chunk_enrichment, version, status)
        VALUES (%s,%s,%s,%s,'text/markdown',10,'k','corpo','plain-text',%s,%s,1,'indexed')
        RETURNING id
        """,
        (espaco, nome, nome, f"sha-{nome}", engine, enriquecimento),
    )
    return cur.fetchone()[0]


def test_trocar_o_enriquecimento_marca_o_documento_como_desalinhado(banco):
    """O buraco que existia: so o motor era comparado."""
    from kb_api import main

    with banco.cursor() as cur:
        _espaco(cur, "teste-desalinho")
        cur.execute(
            "UPDATE space SET chunking = %s WHERE slug = %s",
            ('{"engine": "markdown", "enrichment": "conceito"}', "teste-desalinho"),
        )
        _documento(cur, "teste-desalinho", "alinhado.md", "markdown", "conceito")
        _documento(cur, "teste-desalinho", "variante-antiga.md", "markdown", "nenhum")

    pendentes = {nome for _, nome in main._documentos_para_reprocessar("teste-desalinho", True)}
    assert pendentes == {"variante-antiga.md"}


def test_variante_desconhecida_conta_como_desalinhado(banco):
    """Coluna vazia = indexado antes de ela existir.

    Desconhecido nunca pode passar por alinhado: marcar como em dia um documento
    que nao se sabe esconde justamente o que o reprocessamento precisa achar.
    """
    from kb_api import main

    with banco.cursor() as cur:
        _espaco(cur, "teste-desconhecido")
        cur.execute(
            "UPDATE space SET chunking = %s WHERE slug = %s",
            ('{"engine": "markdown", "enrichment": "nenhum"}', "teste-desconhecido"),
        )
        _documento(cur, "teste-desconhecido", "antigo.md", "markdown", "")

    pendentes = {nome for _, nome in main._documentos_para_reprocessar("teste-desconhecido", True)}
    assert pendentes == {"antigo.md"}


def test_motor_e_enriquecimento_iguais_nao_pedem_reprocesso(banco):
    from kb_api import main

    with banco.cursor() as cur:
        _espaco(cur, "teste-em-dia")
        cur.execute(
            "UPDATE space SET chunking = %s WHERE slug = %s",
            ('{"engine": "sentence", "enrichment": "conceito"}', "teste-em-dia"),
        )
        _documento(cur, "teste-em-dia", "ok.md", "sentence", "conceito")

    assert main._documentos_para_reprocessar("teste-em-dia", True) == []


# ── teste de cadastro: exercita o que aquele provedor FAZ ─────────────────


def test_provedor_de_chat_e_testado_com_chat(banco, monkeypatch):
    """O defeito: o botao "Testar" mandava embedding em todo provedor.

    Num modelo de chat o Azure responde `OperationNotSupported` -- um erro
    verdadeiro sobre uma pergunta que ninguem fez, que fazia um cadastro correto
    parecer quebrado na tela.
    """
    from kb_api import embedding, llm, main

    with banco.cursor() as cur:
        provider_id = _provedor(cur, "chat-de-teste", "chat", "gpt-x", 0, False)

    chamadas = []
    monkeypatch.setattr(llm, "testar", lambda p: (chamadas.append("chat"), (True, "", 7))[1])
    monkeypatch.setattr(
        embedding, "_post",
        lambda *a, **k: chamadas.append("embedding") or ([[0.0] * 3072], 3),
    )

    resposta = main.test_ai_provider(provider_id, principal=None)
    assert chamadas == ["chat"], "nao pode chamar embedding num provedor de chat"
    assert resposta["ok"] is True
    assert resposta["purpose"] == "chat"
    # Sem dimensao: ela nao existe numa resposta de chat, e reporta-la levaria a
    # tela a comparar com a dimensao do indice.
    assert "dimensions" not in resposta


def test_provedor_de_embedding_continua_testado_com_embedding(banco, monkeypatch):
    from kb_api import embedding, llm, main

    with banco.cursor() as cur:
        provider_id = _provedor(cur, "emb-de-teste", "embedding", "emb-x", 3072, False)

    chamadas = []
    monkeypatch.setattr(llm, "testar", lambda p: (chamadas.append("chat"), (True, "", 0))[1])
    monkeypatch.setattr(
        embedding, "_post",
        lambda *a, **k: (chamadas.append("embedding"), ([[0.0] * 3072], 3))[1],
    )

    resposta = main.test_ai_provider(provider_id, principal=None)
    assert chamadas == ["embedding"]
    assert resposta["dimensions"] == 3072
    assert resposta["dimension_mismatch"] is False


def test_erro_do_chat_chega_na_tela(banco, monkeypatch):
    """O texto do provedor E o diagnostico: "nao deu" nao diz qual das causas foi."""
    from kb_api import llm, main

    with banco.cursor() as cur:
        provider_id = _provedor(cur, "chat-quebrado", "chat", "gpt-x", 0, False)

    monkeypatch.setattr(llm, "testar", lambda p: (False, "HTTP 404 deployment nao existe", 0))
    resposta = main.test_ai_provider(provider_id, principal=None)
    assert resposta["ok"] is False
    assert "deployment nao existe" in resposta["error"]
