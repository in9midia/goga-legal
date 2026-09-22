"""Migracoes de esquema versionadas.

POR QUE ISTO EXISTE

Ate aqui o esquema era UM arquivo (`schema.sql`) reaplicado inteiro a cada
subida, todo escrito em `IF NOT EXISTS`. Isso funciona enquanto a mudanca cabe
em "criar coisa nova". Assim que aparece um backfill, um `UPDATE` de correcao,
um rename ou um `NOT NULL` que precisa preencher o que ja existe, o DDL
idempotente nao consegue expressar a mudanca -- e a saida foi a cauda de
`ALTER TABLE ... IF NOT EXISTS` que crescia no fim do arquivo: sem ordem, sem
registro do que ja rodou e sem como responder em que ponto cada ambiente esta.

Agora cada mudanca e um arquivo numerado em `migrations/`, aplicado UMA vez e
anotado em `schema_migration`. O que isso compra:

* **Historico por ambiente.** `applied_at` por versao responde "esta base ja
  tem a coluna X?" sem inspecionar o catalogo do Postgres.
* **Mudanca com dados.** Uma migracao pode fazer UPDATE/backfill justamente
  porque roda exatamente uma vez.
* **Concorrencia.** As replicas sobem juntas e todas chamam `migrate()`. Um
  advisory lock serializa a janela; sem ele, dois pods executando
  `CREATE INDEX IF NOT EXISTS` na mesma tabela travam um no outro.

A migracao 0001 e o `schema.sql` anterior palavra por palavra: como ela e toda
idempotente, reaplica-la numa base ja criada e um no-op, e o ambiente que ja
estava de pe entra no controle de versao sem passo de baseline.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import psycopg

from .config import settings
from .db import close_pool, conn

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).with_name("migrations")

# NNNN_nome_em_snake_case.sql. O numero e a ordem e a identidade da migracao;
# o nome existe so para o arquivo (e a linha do log) serem legiveis.
_FILENAME = re.compile(r"^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$")

# Marcador de linha inteira que tira a migracao do bloco de transacao. Ver
# `_apply` para o contrato que isso impoe.
NO_TRANSACTION = "-- kb:no-transaction"

# Marcador de migracao ACESSORIA: se falhar, o servico sobe assim mesmo.
#
# Existe para uma unica categoria: otimizacao que depende de recurso do servidor.
# O caso real e o indice vetorial HNSW (0008), que precisa do tipo `halfvec`
# (pgvector >= 0.7). Um ambiente com pgvector mais velho nao pode cria-lo -- e
# derrubar o servico por causa de um INDICE inverteria a logica do projeto, que
# e a mesma do grafo e dos metodos de busca: acessorio degrada, nao derruba. Sem
# o indice a busca funciona, so mais lenta.
#
# A falha NAO e registrada no ledger, de proposito. Assim a proxima subida tenta
# de novo, e o dia em que alguem atualizar o pgvector o indice aparece sozinho.
# Por isso migracao opcional PRECISA ser reexecutavel, como a sem transacao.
OPCIONAL = "-- kb:opcional"

# Chave do advisory lock: "kb_mig" em ASCII. Qualquer int64 fixo serviria; o que
# importa e ser o MESMO em toda replica e nao colidir com outro uso no banco.
_LOCK_KEY = 0x6B625F6D6967

_LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS schema_migration (
    version     INT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- sha256 do arquivo como esta em disco. Serve para detectar migracao
    -- aplicada que foi editada depois -- caso em que o banco NAO tem o que o
    -- arquivo diz, e a divergencia so apareceria em ambiente novo.
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT NOT NULL DEFAULT 0
);
"""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path
    checksum: str
    in_transaction: bool
    opcional: bool = False

    @property
    def label(self) -> str:
        return f"{self.version:04d}_{self.name}"

    def sql(self) -> str:
        """O SQL do arquivo, com a dimensao do vetor ajustada ao modelo.

        O `vector(N)` do pgvector e fixo no DDL, mas o modelo de embedding e
        configuravel. Em vez de manter um arquivo por dimensao, o literal
        canonico (3072, do text-embedding-3-large) e substituido na leitura.
        O checksum e do arquivo ORIGINAL, entao trocar `KB_EMBEDDING_DIM` nao
        vira falso alarme de migracao editada.
        """
        text = self.path.read_text(encoding="utf-8")
        if settings.embedding_dim != 3072:
            text = text.replace("vector(3072)", f"vector({settings.embedding_dim})")
        return text


def discover() -> list[Migration]:
    """Le `migrations/` e devolve as migracoes em ordem de versao.

    Nome fora do padrao e versao repetida sao ERRO, nao aviso: os dois
    significam que a ordem de aplicacao e ambigua, e adivinhar aqui produziria
    bases diferentes em ambientes diferentes.
    """
    if not MIGRATIONS_DIR.is_dir():
        raise RuntimeError(
            f"diretorio de migracoes nao encontrado: {MIGRATIONS_DIR}.\n"
            "Em imagem instalada isso costuma ser package-data faltando no "
            "pyproject.toml (kb_api = [\"migrations/*.sql\"])."
        )

    encontradas: dict[int, Migration] = {}
    for path in sorted(MIGRATIONS_DIR.iterdir()):
        if path.suffix != ".sql":
            continue
        casamento = _FILENAME.match(path.name)
        if not casamento:
            raise RuntimeError(
                f"migracao com nome fora do padrao NNNN_nome.sql: {path.name}"
            )
        version = int(casamento.group(1))
        if version in encontradas:
            raise RuntimeError(
                f"versao {version:04d} duplicada: "
                f"{encontradas[version].path.name} e {path.name}"
            )
        bruto = path.read_bytes()
        linhas = bruto.decode("utf-8").splitlines()
        encontradas[version] = Migration(
            version=version,
            name=casamento.group(2),
            path=path,
            checksum=hashlib.sha256(bruto).hexdigest(),
            in_transaction=not any(linha.strip() == NO_TRANSACTION for linha in linhas),
            opcional=any(linha.strip() == OPCIONAL for linha in linhas),
        )

    if not encontradas:
        raise RuntimeError(f"nenhuma migracao em {MIGRATIONS_DIR}")
    return [encontradas[v] for v in sorted(encontradas)]


def _applied(connection: psycopg.Connection) -> dict[int, tuple[str, str]]:
    with connection.cursor() as cur:
        cur.execute("SELECT version, name, checksum FROM schema_migration")
        return {linha[0]: (linha[1], linha[2]) for linha in cur.fetchall()}


def _record(connection: psycopg.Connection, mig: Migration, duration_ms: int) -> None:
    with connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO schema_migration (version, name, checksum, duration_ms)
            VALUES (%s, %s, %s, %s)
            """,
            (mig.version, mig.name, mig.checksum, duration_ms),
        )


def _check_drift(migrations: list[Migration], aplicadas: dict[int, tuple[str, str]]) -> None:
    """Confere se alguma migracao ja aplicada foi editada depois.

    Nao bloqueia por padrao. Um pod que se recusa a subir por causa de um
    checksum e pior que a divergencia que ele denuncia -- e a divergencia, em
    geral, e um `git pull` que trouxe a correcao de outra pessoa. Com
    `KB_MIGRATIONS_STRICT=1` a politica inverte, que e o que se quer em
    producao.
    """
    divergentes = [
        mig for mig in migrations
        if mig.version in aplicadas and aplicadas[mig.version][1] != mig.checksum
    ]
    if not divergentes:
        return
    msg = (
        "migracao ja aplicada foi EDITADA depois: "
        + ", ".join(m.label for m in divergentes)
        + ". O banco nao contem o que o arquivo diz hoje, e a diferenca so vai "
        "aparecer num ambiente novo. Corrija com uma migracao NOVA, nunca "
        "editando a antiga."
    )
    if settings.migrations_strict:
        raise RuntimeError(msg)
    log.error("%s (KB_MIGRATIONS_STRICT=1 recusa subir nesse caso)", msg)


def _lock(connection: psycopg.Connection) -> None:
    """Toma o advisory lock, esperando a replica que estiver migrando.

    `pg_try_advisory_lock` em laco, e nao `pg_advisory_lock` direto, para a
    espera ser VISIVEL no log: um lock que bloqueia sem dizer nada e
    indistinguivel de um pod travado, e e exatamente durante a subida que
    alguem esta olhando o log tentando entender por que o pod nao fica pronto.

    O lock e de SESSAO, nao de transacao: ele precisa sobreviver ao commit de
    cada migracao. Por isso o `finally` com unlock em `migrate()` nao e opcional.
    """
    limite = time.monotonic() + settings.migrations_lock_seconds
    tentativa = 0
    while True:
        with connection.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (_LOCK_KEY,))
            obtido = cur.fetchone()[0]
        connection.commit()
        if obtido:
            return
        tentativa += 1
        if time.monotonic() >= limite:
            raise RuntimeError(
                "outra instancia esta migrando ha mais de "
                f"{settings.migrations_lock_seconds}s e o lock nao foi liberado"
            )
        if tentativa == 1 or tentativa % 10 == 0:
            log.info("outra instancia esta migrando; aguardando o lock (%ss)", tentativa)
        time.sleep(1)


def _unlock(connection: psycopg.Connection) -> None:
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_KEY,))
        connection.commit()
    except Exception as exc:  # noqa: BLE001 - a conexao pode ja ter morrido
        # Nao e fatal: o lock de sessao cai sozinho quando a conexao fecha.
        log.warning("nao foi possivel liberar o lock de migracao: %s", exc)


def separar_instrucoes(sql: str) -> list[str]:
    """Quebra o script em instrucoes, respeitando aspas, cifrao e comentario.

    POR QUE ISTO EXISTE
    ---
    Fora de transacao, psycopg manda o script inteiro numa mensagem so, e o
    Postgres trata consulta com MAIS DE UMA instrucao como bloco de transacao
    implicito. O resultado e o erro que a migracao 0008 encontrou na primeira
    subida: `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`,
    mesmo com `autocommit = True` e com o marcador `-- kb:no-transaction` no
    lugar certo. O marcador estava sendo respeitado; o que faltava era mandar uma
    instrucao por vez.

    Cortar em `;` sem olhar o contexto seria pior que nao cortar: um `;` dentro
    de literal, de corpo `$$ ... $$` ou de comentario quebraria o script em
    pedacos invalidos. Por isso o laco caractere a caractere.
    """
    instrucoes: list[str] = []
    atual: list[str] = []
    i = 0
    aspas: str | None = None   # "'" ou '"' quando dentro de literal/identificador
    cifrao: str | None = None  # a etiqueta $tag$ quando dentro de corpo citado
    comentario = False
    bloco = 0
    while i < len(sql):
        c = sql[i]
        dois = sql[i : i + 2]
        if comentario:
            atual.append(c)
            if c == "\n":
                comentario = False
            i += 1
            continue
        if bloco:
            atual.append(c)
            if dois == "*/":
                atual.append(sql[i + 1])
                bloco -= 1
                i += 2
                continue
            i += 1
            continue
        if cifrao:
            atual.append(c)
            if sql.startswith(cifrao, i):
                atual.extend(sql[i + 1 : i + len(cifrao)])
                i += len(cifrao)
                cifrao = None
                continue
            i += 1
            continue
        if aspas:
            atual.append(c)
            if c == aspas:
                # Aspa dobrada e escape, nao fim do literal.
                if sql[i + 1 : i + 2] == aspas:
                    atual.append(aspas)
                    i += 2
                    continue
                aspas = None
            i += 1
            continue
        if dois == "--":
            comentario = True
            atual.append(c)
            i += 1
            continue
        if dois == "/*":
            bloco += 1
            atual.append(c)
            i += 1
            continue
        if c in "'\"":
            aspas = c
            atual.append(c)
            i += 1
            continue
        if c == "$":
            fim = sql.find("$", i + 1)
            etiqueta = sql[i : fim + 1] if fim != -1 else ""
            # `$$` ou `$nome$`: so conta como citacao se o miolo for identificador.
            if etiqueta and (etiqueta[1:-1] == "" or etiqueta[1:-1].isidentifier()):
                cifrao = etiqueta
                atual.append(etiqueta)
                i = fim + 1
                continue
        if c == ";":
            instrucoes.append("".join(atual))
            atual = []
            i += 1
            continue
        atual.append(c)
        i += 1
    instrucoes.append("".join(atual))
    return [texto for texto in (t.strip() for t in instrucoes) if texto and not _so_comentario(texto)]


def _so_comentario(texto: str) -> bool:
    """Um pedaco que so tem comentario nao e instrucao.

    O rabo do arquivo depois do ultimo `;` costuma ser exatamente isso, e mandar
    `-- fim` para o Postgres e um erro de sintaxe.
    """
    for linha in texto.splitlines():
        limpa = linha.strip()
        if limpa and not limpa.startswith("--"):
            return False
    return True


def _apply(connection: psycopg.Connection, mig: Migration) -> int:
    """Aplica uma migracao e anota no ledger. Devolve a duracao em ms."""
    sql = mig.sql()
    log.info("migracao %s: aplicando", mig.label)
    inicio = time.monotonic()
    try:
        if mig.in_transaction:
            # DDL do Postgres e transacional: SQL e registro entram no MESMO
            # commit. Falhou no meio, nao sobra nem meia tabela nem linha no
            # ledger dizendo que rodou.
            with connection.cursor() as cur:
                cur.execute(sql)
            duracao = int((time.monotonic() - inicio) * 1000)
            _record(connection, mig, duracao)
            connection.commit()
        else:
            # Escotilha para o DDL que o Postgres recusa dentro de bloco de
            # transacao -- CREATE INDEX CONCURRENTLY e o caso real aqui, para
            # criar indice de vetor sem travar a escrita numa base grande.
            #
            # O preco: falha no meio deixa o banco parcialmente mudado SEM
            # registro, e a proxima subida tenta tudo de novo. Migracao marcada
            # com `-- kb:no-transaction` PRECISA ser reexecutavel.
            connection.commit()  # autocommit exige nao haver transacao aberta
            connection.autocommit = True
            try:
                with connection.cursor() as cur:
                    # UMA INSTRUCAO POR VEZ. Mandar o script inteiro faria o
                    # Postgres abrir um bloco de transacao implicito, e o
                    # `CREATE INDEX CONCURRENTLY` seria recusado -- que e
                    # exatamente o que aconteceu na primeira subida da 0008.
                    for instrucao in separar_instrucoes(sql):
                        cur.execute(instrucao)
            finally:
                connection.autocommit = False
            duracao = int((time.monotonic() - inicio) * 1000)
            _record(connection, mig, duracao)
            connection.commit()
    except Exception:
        connection.rollback()
        log.error("migracao %s FALHOU", mig.label)
        raise
    log.info("migracao %s: aplicada em %sms", mig.label, duracao)
    return duracao


def _check_embedding_dim(connection: psycopg.Connection) -> None:
    """Confere a dimensao gravada contra a do modelo configurado.

    Trocar para um modelo de outra dimensao exige recriar a tabela; falhar cedo
    com mensagem clara e melhor que gravar vetor truncado e so descobrir na
    busca, quando o resultado ja esta errado ha semanas.
    """
    with connection.cursor() as cur:
        # `to_regclass` e nao `'chunk_embedding'::regclass`: o cast LEVANTA erro
        # quando a tabela nao existe, e uma conferencia de seguranca que quebra
        # na ausencia do que ela protege esta invertida. Com to_regclass a
        # ausencia vira NULL e o teste simplesmente nao se aplica.
        cur.execute(
            """
            SELECT atttypmod
              FROM pg_attribute
             WHERE attrelid = to_regclass('chunk_embedding')
               AND attname = 'embedding'
            """
        )
        linha = cur.fetchone()
    if linha and linha[0] not in (-1, settings.embedding_dim):
        raise RuntimeError(
            f"a tabela chunk_embedding tem vector({linha[0]}) mas o modelo "
            f"configurado gera {settings.embedding_dim} dimensoes.\n"
            "Troque KB_EMBEDDING_DIM ou recrie a tabela: "
            "DROP TABLE chunk_embedding;"
        )


def migrate() -> list[Migration]:
    """Aplica as migracoes pendentes, em ordem. Devolve o que foi aplicado.

    Chamada no startup da API: o ambiente local sobe sem passo manual e o pod
    fica NotReady se o esquema nao puder ser garantido, que e o comportamento
    certo.
    """
    migrations = discover()

    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute(_LEDGER_DDL)
        connection.commit()

        feitas: list[Migration] = []
        puladas: list[Migration] = []
        _lock(connection)
        try:
            aplicadas = _applied(connection)
            _check_drift(migrations, aplicadas)

            maior = max(aplicadas) if aplicadas else 0
            for mig in migrations:
                if mig.version in aplicadas:
                    continue
                if mig.version < maior:
                    # Duas branches numeraram em paralelo e a de tras chegou
                    # depois. Aplicar mesmo assim e o menor mal (a alternativa e
                    # nunca aplicar), mas precisa aparecer: a ordem que rodou
                    # aqui nao e a ordem que vai rodar num banco novo.
                    log.warning(
                        "migracao %s e anterior a %04d, que ja foi aplicada; "
                        "a ordem neste banco difere da de um banco novo",
                        mig.label, maior,
                    )
                try:
                    _apply(connection, mig)
                except Exception as exc:
                    if not mig.opcional:
                        raise
                    # Acessoria: loga alto e segue. Sem registrar no ledger, para
                    # a proxima subida tentar de novo -- e o indice aparecer
                    # sozinho no dia em que o servidor ganhar o recurso.
                    log.warning(
                        "migracao ACESSORIA %s nao pode ser aplicada e foi PULADA: %s. "
                        "O servico sobe sem ela; sera tentada de novo na proxima subida.",
                        mig.label, exc,
                    )
                    puladas.append(mig)
                    continue
                feitas.append(mig)
        finally:
            _unlock(connection)

        _check_embedding_dim(connection)

    if feitas:
        log.info("esquema atualizado: %s migracao(oes) aplicada(s)", len(feitas))
    else:
        log.info("esquema em dia (%s migracoes)", len(migrations))
    if puladas:
        log.warning(
            "%s migracao(oes) acessoria(s) pulada(s): %s",
            len(puladas), ", ".join(m.label for m in puladas),
        )
    return feitas


def status() -> list[dict]:
    """Estado de cada migracao conhecida, para o CLI e para o /v1/health."""
    migrations = discover()
    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute(_LEDGER_DDL)
        connection.commit()
        aplicadas = _applied(connection)

    linhas = []
    for mig in migrations:
        registro = aplicadas.get(mig.version)
        linhas.append({
            "version": mig.version,
            "name": mig.name,
            "applied": registro is not None,
            "drifted": bool(registro and registro[1] != mig.checksum),
        })
    # Migracao no banco que nao existe mais em disco: quase sempre e deploy de
    # uma versao ANTIGA da imagem sobre um banco ja migrado -- um rollback que
    # ninguem anunciou. Vale aparecer.
    for version in sorted(set(aplicadas) - {m.version for m in migrations}):
        linhas.append({
            "version": version,
            "name": aplicadas[version][0],
            "applied": True,
            "drifted": False,
            "missing_file": True,
        })
    return linhas


def summary() -> dict:
    """Resumo curto do estado do esquema, para o endpoint de saude."""
    linhas = status()
    pendentes = [linha for linha in linhas if not linha["applied"]]
    return {
        "applied": sum(1 for linha in linhas if linha["applied"]),
        "pending": len(pendentes),
        "current": max((linha["version"] for linha in linhas if linha["applied"]), default=0),
        "drifted": [f"{linha['version']:04d}_{linha['name']}" for linha in linhas if linha.get("drifted")],
    }


# ── CLI ────────────────────────────────────────────────────────────────────
# `python -m kb_api.migrate` permite migrar SEM subir a API: e o que o
# init-container do deploy usa, e o que resolve "quero ver em que versao esta
# este banco" sem abrir psql.


def _cmd_new(nome: str) -> int:
    limpo = re.sub(r"[^a-z0-9]+", "_", nome.strip().lower()).strip("_")
    if not limpo:
        print("nome invalido", file=sys.stderr)
        return 2
    proxima = max((m.version for m in discover()), default=0) + 1
    destino = MIGRATIONS_DIR / f"{proxima:04d}_{limpo}.sql"
    if destino.exists():
        print(f"ja existe: {destino.name}", file=sys.stderr)
        return 1
    destino.write_text(
        f"-- {proxima:04d} — {nome.strip()}\n"
        "--\n"
        "-- Descreva POR QUE a mudanca existe, nao o que o DDL abaixo ja diz.\n"
        "--\n"
        "-- Roda UMA vez, dentro de uma transacao. Para DDL que o Postgres nao\n"
        "-- aceita em transacao (CREATE INDEX CONCURRENTLY), acrescente a linha\n"
        f"-- `{NO_TRANSACTION}` -- e entao esta migracao precisa ser reexecutavel.\n"
        "\n",
        encoding="utf-8",
    )
    print(destino)
    return 0


def _cmd_status() -> int:
    for linha in status():
        if linha.get("missing_file"):
            marca = "?"
        elif linha.get("drifted"):
            marca = "!"
        elif linha["applied"]:
            marca = "x"
        else:
            marca = " "
        print(f"[{marca}] {linha['version']:04d}_{linha['name']}")
    resumo = summary()
    print(f"\naplicadas: {resumo['applied']}  pendentes: {resumo['pending']}")
    if resumo["drifted"]:
        print(f"EDITADAS DEPOIS DE APLICADAS: {', '.join(resumo['drifted'])}")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(levelname)-7s %(message)s",
    )
    parser = argparse.ArgumentParser(
        prog="python -m kb_api.migrate",
        description="Migracoes de esquema do kb-api.",
    )
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("up", help="aplica as migracoes pendentes (padrao)")
    sub.add_parser("status", help="lista as migracoes e o que ja foi aplicado")
    novo = sub.add_parser("new", help="cria o arquivo da proxima migracao")
    novo.add_argument("nome", help="nome curto, ex.: 'indice de figura por pagina'")
    args = parser.parse_args(argv)

    if args.cmd == "new":
        # Nao toca no banco: nao vale abrir pool para escrever um arquivo.
        return _cmd_new(args.nome)

    try:
        if args.cmd == "status":
            return _cmd_status()

        feitas = migrate()
        for mig in feitas:
            print(f"aplicada: {mig.label}")
        if not feitas:
            print("nada a aplicar")
        return 0
    finally:
        close_pool()


if __name__ == "__main__":
    raise SystemExit(main())
