#!/usr/bin/env python3
"""Reconstroi o grafo de termos a partir do que ja esta no Postgres.

QUANDO USAR: o Memgraph e DERIVADO -- ele nao guarda nada que nao possa ser
refeito do documento canonico. Normalmente e escrito durante a ingestao, mas
some em duas situacoes:

  * o pod reinicia sem ter feito snapshot (parar o cluster e o caso comum);
  * o banco foi restaurado de um dump, sem passar pela ingestao.

Nos dois casos os "documentos relacionados" somem da tela de documento e nada
mais quebra. Este script refaz o grafo em segundos, sem reextrair nem reembedar:
o canonico ja esta no Postgres.

QUANDO USAR TAMBEM: AMBIENTE QUE JA TINHA DADO
---
O Postgres tem migracao; o Memgraph nao, porque ele e inteiramente derivado. Duas
correcoes recentes so valem para o que for ingerido DEPOIS delas, e este script e
o caminho para alcancar o que ja estava la:

  * **`Term.norm`** (nome sem acento, usado pelo foco do desenho). Termo gravado
    antes dela ficava invisivel para quem digitasse `diario` procurando
    `diário`. Uma passada aqui resolveu os 88 documentos em segundos;
  * **`:Chunk` repetido**, criado pelo MERGE de caminho antigo -- o trecho 4651
    tinha virado oito nos. Ver `deduplicar_chunks`.

Rodar isto num ambiente que veio de uma versao anterior NAO e opcional se o grafo
estiver ligado: sem ele o desenho fica errado e o foco fica cego a acento, sem
nada falhar.

    kubectl -n stack-knowledge-base cp scripts/rebuild-graph.py \\
      $(kubectl -n stack-knowledge-base get pod -l app=kb-api \\
        -o jsonpath='{.items[0].metadata.name}'):/tmp/rebuild-graph.py
    kubectl -n stack-knowledge-base exec deploy/kb-api -- python /tmp/rebuild-graph.py
"""
from kb_api import graph
from kb_api.db import conn


def deduplicar_chunks() -> int:
    """Junta os `:Chunk` repetidos que o MERGE de caminho criou.

    O DEFEITO QUE ISTO CONSERTA
    ---
    `MERGE (e)-[:FROM_CHUNK]->(c:Chunk {id: $chunk})` casa o CAMINHO inteiro: se
    aquela entidade ainda nao aponta para aquele trecho, o MERGE cria tudo,
    **inclusive um `:Chunk` novo**, em vez de reusar o que ja existe. Medido
    antes da correcao: o trecho 4651 tinha virado OITO nos, um por entidade.

    O codigo ja foi corrigido (o no e casado sozinho, a aresta vem depois), mas
    isso so vale para o que for ingerido DEPOIS. Num ambiente que ja rodava a
    versao antiga os nos repetidos continuam la, e o desenho fica salpicado de
    pontos cinzas que parecem trechos diferentes e sao o mesmo.

    O `:Chunk` e ponteiro puro -- nao guarda texto, so o id da linha no Postgres.
    Por isso da para refaze-lo inteiro sem perder nada: le as ligacoes, apaga os
    nos, recria com um por (id, espaco).
    """
    driver = graph._driver()
    if driver is None:
        print("grafo indisponivel: nada a deduplicar")
        return 0
    try:
        with driver.session() as session:
            ligacoes = [
                (linha["entidade"], linha["espaco_e"], linha["chunk"], linha["espaco_c"])
                for linha in session.run(
                    """
                    MATCH (e:Entity)-[:FROM_CHUNK]->(c:Chunk)
                    WHERE e.space IS NOT NULL AND c.space IS NOT NULL
                    RETURN e.name AS entidade, e.space AS espaco_e,
                           c.id AS chunk, c.space AS espaco_c
                    """
                )
            ]
            # ⚠ `space IS NOT NULL` NAO E DETALHE. O Memgraph de dev e
            # COMPARTILHADO com o agentic-sdlc, e um `MATCH (c:Chunk) DETACH
            # DELETE c` sem dono apagaria o que for do outro servico -- sem erro
            # e sem rastro. O `:Chunk` do knowledge-base sempre tem `space`.
            antes = session.run(
                "MATCH (c:Chunk) WHERE c.space IS NOT NULL RETURN count(c) AS n"
            ).single()["n"]
            session.run("MATCH (c:Chunk) WHERE c.space IS NOT NULL DETACH DELETE c")
            for entidade, espaco_e, chunk, espaco_c in ligacoes:
                session.run(
                    """
                    MATCH (e:Entity {name: $nome, space: $espaco_e})
                    MERGE (c:Chunk {id: $chunk, space: $espaco_c})
                    MERGE (e)-[:FROM_CHUNK]->(c)
                    """,
                    nome=entidade, espaco_e=espaco_e, chunk=chunk, espaco_c=espaco_c,
                )
            depois = session.run(
                "MATCH (c:Chunk) WHERE c.space IS NOT NULL RETURN count(c) AS n"
            ).single()["n"]
        print(f"chunks no grafo: {antes} -> {depois} ({antes - depois} repetidos removidos)")
        return antes - depois
    except Exception as exc:  # noqa: BLE001 - o grafo e auxiliar
        print(f"deduplicacao falhou (o grafo e auxiliar, nada mais quebra): {exc}")
        return 0
    finally:
        driver.close()


def limpar_documentos_orfaos() -> int:
    """Tira do grafo os `:Document` que o Postgres ja nao serve.

    O DEFEITO QUE ISTO CONSERTA
    ---
    Reenviar um arquivo que ja estava na base nao APAGA a versao anterior: ela
    fica com `active = FALSE` e uma linha nova entra com id novo (FUN-02). O no
    `:Document` da versao velha continuava no grafo apontando para um id que a
    API responde com 404 -- clicar nele na tela dava "documento nao encontrado".

    Achado numa carga real: 358 nos para 358 linhas, numero batendo por
    coincidencia. Um no era orfao e um documento que falhou na extracao nao
    tinha no -- os dois erros se cancelavam na contagem.

    A ingestao passou a esquecer a versao anterior, mas isso so vale para o que
    for reenviado DEPOIS. Esta funcao alcanca o que ja estava la.

    ⚠ POSSE. O Memgraph de dev e compartilhado. So entra no `DELETE` o no que
    tem `space` -- a propriedade que so o knowledge-base grava -- e so quando o
    Espaco dele e um Espaco nosso. Preferir deixar um orfao nosso para tras a
    apagar o dado de outro servico.
    """
    driver = graph._driver()
    if driver is None:
        print("grafo indisponivel: nada a limpar")
        return 0
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(
                "SELECT space_slug, id FROM document WHERE active AND status = 'indexed'"
            )
            vivos: dict[str, set[int]] = {}
            for space, doc_id in cur.fetchall():
                vivos.setdefault(space, set()).add(doc_id)

        removidos = 0
        with driver.session() as session:
            no_grafo = [
                (linha["space"], linha["doc"])
                for linha in session.run(
                    "MATCH (d:Document) WHERE d.space IS NOT NULL "
                    "RETURN d.space AS space, d.id AS doc"
                )
            ]
        for space, doc_id in no_grafo:
            # Espaco que nao existe mais no Postgres nao entra aqui: quem apaga
            # Espaco e `drop_space`, e confundir "Espaco removido" com "linha
            # desativada" apagaria grafo de uma base que so esta fora do alcance
            # desta consulta.
            if space not in vivos:
                continue
            if doc_id not in vivos[space]:
                if graph.forget_document(doc_id):
                    removidos += 1
                    print(f"  orfao removido: documento {doc_id} ({space})")
        print(f"documentos orfaos no grafo: {removidos} removido(s) de {len(no_grafo)}")
        return removidos
    except Exception as exc:  # noqa: BLE001
        print(f"limpeza de orfaos falhou (o grafo e auxiliar, nada mais quebra): {exc}")
        return 0
    finally:
        driver.close()


with conn() as c, c.cursor() as cur:
    cur.execute(
        "SELECT id, space_slug, title, canonical_md "
        "FROM document WHERE active AND status = 'indexed'"
    )
    linhas = cur.fetchall()

ok = 0
for doc_id, space, titulo, canonico in linhas:
    if graph.upsert_document(doc_id, space, titulo or "", graph.terms(canonico or "")):
        ok += 1

print(f"grafo reconstruido: {ok}/{len(linhas)} documentos")
# Depois dos termos: a deduplicacao le as ligacoes de entidade, que o passo
# acima nao toca.
deduplicar_chunks()
# Por ultimo: o passo acima recria o no de quem esta VIVO, e este tira o de quem
# nao esta. Invertendo a ordem, um documento reprocessado entre as duas
# passadas poderia ser removido logo depois de ser recriado.
limpar_documentos_orfaos()
print("stats:", graph.stats())
