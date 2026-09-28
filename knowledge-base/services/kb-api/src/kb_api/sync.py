"""Armazenamentos externos e a sincronizacao de pastas com uma base.

O QUE "SINCRONIZAR" PROMETE

A pasta e a fonte de verdade dos documentos QUE VIERAM DELA. A cada rodada:

- arquivo novo na pasta entra na base (pela fila de ingestao, como um upload);
- arquivo alterado vira versao nova do MESMO documento;
- arquivo renomeado ou movido dentro da pasta so troca de nome, sem reingerir;
- arquivo apagado, levado para fora da pasta ou para a lixeira sai da base.

E o que ela promete NAO fazer: tocar em documento enviado a mao, ou vindo de
outra pasta. A fronteira e a coluna `document.sync_id` (migracao 0022), e todo
DELETE daqui filtra por ela.

POR QUE CONSULTA PERIODICA, e nao notificacao

O Drive notifica mudanca por webhook (`changes.watch`), mas o webhook exige uma
URL publica com HTTPS e dominio verificado, e o canal expira em uma semana.
Nenhuma das duas coisas existe no k3d local. A consulta periodica funciona em
qualquer lugar, e o custo e uma listagem por pasta a cada rodada -- barato: o
que se baixa e so o que mudou (`remote_version` em `storage_sync_item`).

O ESTADO ESTA NO POSTGRES, como na fila: a thread nao guarda nada que importe.
"""

from __future__ import annotations

import logging
import re
import threading
from pathlib import PurePosixPath
from typing import Any

from . import fila, gdrive, ingest, providers
from .config import settings
from .db import conn, jsonb
from .extract import SUPPORTED

log = logging.getLogger(__name__)

TIPOS = {"google_drive": "Google Drive"}
# Menor intervalo aceito. Abaixo disso a listagem de uma pasta grande (uma
# chamada por subpasta) come a cota da API do Drive sem ganho real: quem edita
# um documento nao espera ve-lo na busca em segundos.
INTERVALO_MINIMO = 5
INTERVALO_MAXIMO = 24 * 60
# O laco acorda neste intervalo para ver se alguma pasta venceu. O pedido de
# "sincronizar agora" (`acordar`) e o caminho rapido.
TIQUE_SEGUNDOS = 30.0

_acordar = threading.Event()
_parar = threading.Event()


class SyncError(RuntimeError):
    """Erro com o status HTTP que a rota deve devolver."""

    def __init__(self, mensagem: str, status: int = 400) -> None:
        super().__init__(mensagem)
        self.status = status


# ── conexoes ───────────────────────────────────────────────────────────────


def _conexao_para_tela(linha: tuple) -> dict[str, Any]:
    id_, kind, label, config, dica, criada, atualizada, pastas = linha
    return {
        "id": id_, "kind": kind, "kind_label": TIPOS.get(kind, kind), "label": label,
        # So o que nao e segredo. A chave privada nunca sai (ADR-0009).
        "client_email": (config or {}).get("client_email", ""),
        "project_id": (config or {}).get("project_id", ""),
        "secret_hint": dica,
        "created_at": criada.isoformat() if criada else None,
        "updated_at": atualizada.isoformat() if atualizada else None,
        "syncs": int(pastas or 0),
    }


_COLUNAS_CONEXAO = """
    c.id, c.kind, c.label, c.config, c.secret_hint, c.created_at, c.updated_at,
    (SELECT count(*) FROM storage_sync s WHERE s.connection_id = c.id)
"""


def listar_conexoes() -> list[dict[str, Any]]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(f"SELECT {_COLUNAS_CONEXAO} FROM storage_connection c ORDER BY c.label")
        return [_conexao_para_tela(linha) for linha in cur.fetchall()]


def _validar_credencial(kind: str, credencial: str) -> tuple[dict[str, Any], str, str]:
    """(config visivel, segredo cifrado, dica). Valida ANTES de gravar."""
    if kind != "google_drive":
        raise SyncError(f"tipo de armazenamento desconhecido: {kind}. Tipos: {', '.join(TIPOS)}.")
    try:
        cred = gdrive.Credencial.from_json(credencial)
        # Assinar agora tira do caminho a chave que nao abre: o erro aparece no
        # cadastro, e nao na primeira rodada, horas depois.
        gdrive.assinar_jwt(cred)
    except gdrive.DriveError as exc:
        raise SyncError(str(exc)) from None
    try:
        cifrado = providers.cifrar(credencial)
    except providers.ProviderError as exc:
        raise SyncError(str(exc), 500) from None
    config = {"client_email": cred.client_email, "project_id": cred.project_id}
    return config, cifrado, f"…{cred.client_email.split('@')[0][-4:]}"


def criar_conexao(payload: dict[str, Any], por_quem: str) -> dict[str, Any]:
    kind = (payload.get("kind") or "google_drive").strip()
    label = (payload.get("label") or "").strip()
    credencial = (payload.get("credential") or "").strip()
    if not label:
        raise SyncError("de um nome a conexao, por exemplo \"Drive do escritorio\".")
    if not credencial:
        raise SyncError("cole o JSON da chave da conta de servico.")
    config, cifrado, dica = _validar_credencial(kind, credencial)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO storage_connection (kind, label, config, secret_enc, secret_hint, created_by)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING id
            """,
            (kind, label, jsonb(config), cifrado, dica, por_quem),
        )
        id_ = cur.fetchone()[0]
        connection.commit()
    log.info("armazenamento %s (%s) cadastrado por %s", label, kind, por_quem)
    return obter_conexao(id_)


def obter_conexao(connection_id: int) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUNAS_CONEXAO} FROM storage_connection c WHERE c.id = %s",
            (connection_id,),
        )
        linha = cur.fetchone()
    if linha is None:
        raise SyncError("armazenamento nao encontrado", 404)
    return _conexao_para_tela(linha)


def atualizar_conexao(connection_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    atual = obter_conexao(connection_id)
    label = (payload.get("label") or "").strip() or atual["label"]
    credencial = (payload.get("credential") or "").strip()
    with conn() as connection, connection.cursor() as cur:
        # Credencial vazia = "nao mexa na que esta la", como nos provedores de
        # IA: a tela nunca reexibe a chave, e editar o nome nao pode exigir cola-la.
        if credencial:
            config, cifrado, dica = _validar_credencial(atual["kind"], credencial)
            cur.execute(
                "UPDATE storage_connection SET label=%s, config=%s, secret_enc=%s,"
                " secret_hint=%s, updated_at=now() WHERE id=%s",
                (label, jsonb(config), cifrado, dica, connection_id),
            )
        else:
            cur.execute(
                "UPDATE storage_connection SET label=%s, updated_at=now() WHERE id=%s",
                (label, connection_id),
            )
        connection.commit()
    return obter_conexao(connection_id)


def remover_conexao(connection_id: int) -> None:
    atual = obter_conexao(connection_id)
    if atual["syncs"]:
        raise SyncError(
            f"este armazenamento sincroniza {atual['syncs']} pasta(s). Remova as "
            "sincronizacoes nas bases antes; sem a credencial elas parariam em erro.",
            409,
        )
    with conn() as connection, connection.cursor() as cur:
        cur.execute("DELETE FROM storage_connection WHERE id = %s", (connection_id,))
        connection.commit()


def _credencial(connection_id: int) -> gdrive.Credencial:
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT secret_enc FROM storage_connection WHERE id = %s", (connection_id,))
        linha = cur.fetchone()
    if linha is None:
        raise SyncError("armazenamento nao encontrado", 404)
    try:
        return gdrive.Credencial.from_json(providers.decifrar(linha[0]))
    except (providers.ProviderError, gdrive.DriveError) as exc:
        raise SyncError(str(exc), 502) from None


def testar_conexao(connection_id: int) -> dict[str, Any]:
    """Chamada real ao Drive: token e a lista do que foi compartilhado."""
    cred = _credencial(connection_id)
    try:
        pastas = gdrive.subpastas(cred, None)
    except gdrive.DriveError as exc:
        return {"ok": False, "error": str(exc), "client_email": cred.client_email}
    return {"ok": True, "client_email": cred.client_email, "folders": len(pastas)}


def pastas(connection_id: int, parent: str | None) -> dict[str, Any]:
    cred = _credencial(connection_id)
    try:
        itens = gdrive.subpastas(cred, parent or None)
    except gdrive.DriveError as exc:
        raise SyncError(str(exc), 502) from None
    return {"parent": parent or None, "client_email": cred.client_email, "folders": itens}


# ── sincronizacoes ─────────────────────────────────────────────────────────

_URL_PASTA = re.compile(r"/folders/([A-Za-z0-9_-]+)")


def id_da_pasta(valor: str) -> str:
    """Aceita o id ou o link da pasta (`.../drive/folders/<id>?usp=...`)."""
    valor = (valor or "").strip()
    achado = _URL_PASTA.search(valor)
    if achado:
        return achado.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{10,}", valor):
        return valor
    raise SyncError("informe a pasta: escolha na lista ou cole o link dela no Drive.")


def _intervalo(valor: Any) -> int:
    try:
        minutos = int(valor)
    except (TypeError, ValueError):
        raise SyncError("o intervalo precisa ser um numero de minutos") from None
    if not INTERVALO_MINIMO <= minutos <= INTERVALO_MAXIMO:
        raise SyncError(
            f"o intervalo vai de {INTERVALO_MINIMO} a {INTERVALO_MAXIMO} minutos. Abaixo de "
            f"{INTERVALO_MINIMO} a listagem gasta a cota da API do Drive sem ganho real."
        )
    return minutos


_COLUNAS_SYNC = """
    s.id, s.connection_id, c.label, c.kind, s.space_slug, s.folder_id, s.folder_name,
    s.recursive, s.interval_minutes, s.enabled, s.status, s.last_run_at, s.last_ok_at,
    s.next_run_at, s.last_error, s.last_summary, s.created_at,
    (SELECT count(*) FROM document d WHERE d.sync_id = s.id AND d.active),
    (SELECT count(*) FROM storage_sync_item i WHERE i.sync_id = s.id AND i.status = 'error'),
    (SELECT count(*) FROM storage_sync_item i WHERE i.sync_id = s.id AND i.status = 'skipped'),
    (SELECT count(*) FROM ingest_run r
      WHERE r.sync_id = s.id AND r.status IN ('queued', 'running'))
"""


def _sync_para_tela(linha: tuple) -> dict[str, Any]:
    def quando(valor):
        return valor.isoformat() if valor else None

    return {
        "id": linha[0], "connection_id": linha[1], "connection_label": linha[2],
        "kind": linha[3], "space": linha[4], "folder_id": linha[5], "folder_name": linha[6],
        "recursive": linha[7], "interval_minutes": linha[8], "enabled": linha[9],
        "status": linha[10], "last_run_at": quando(linha[11]), "last_ok_at": quando(linha[12]),
        "next_run_at": quando(linha[13]), "last_error": linha[14],
        "last_summary": linha[15] or {}, "created_at": quando(linha[16]),
        "documents": int(linha[17]), "errors": int(linha[18]), "skipped": int(linha[19]),
        "pending": int(linha[20]),
    }


def listar_syncs(space: str | None = None) -> list[dict[str, Any]]:
    sql = (f"SELECT {_COLUNAS_SYNC} FROM storage_sync s "
           "JOIN storage_connection c ON c.id = s.connection_id")
    params: tuple = ()
    if space:
        sql += " WHERE s.space_slug = %s"
        params = (space,)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(sql + " ORDER BY s.space_slug, s.folder_name", params)
        return [_sync_para_tela(linha) for linha in cur.fetchall()]


def obter_sync(sync_id: int) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUNAS_SYNC} FROM storage_sync s "
            "JOIN storage_connection c ON c.id = s.connection_id WHERE s.id = %s",
            (sync_id,),
        )
        linha = cur.fetchone()
    if linha is None:
        raise SyncError("sincronizacao nao encontrada", 404)
    return _sync_para_tela(linha)


def criar_sync(space: str, payload: dict[str, Any], por_quem: str) -> dict[str, Any]:
    try:
        connection_id = int(payload.get("connection_id"))
    except (TypeError, ValueError):
        raise SyncError("escolha o armazenamento de onde a pasta vem") from None
    folder_id = id_da_pasta(payload.get("folder") or payload.get("folder_id") or "")
    intervalo = _intervalo(payload.get("interval_minutes", 10))
    recursivo = bool(payload.get("recursive", True))

    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT 1 FROM space WHERE slug = %s AND active", (space,))
        if cur.fetchone() is None:
            raise SyncError(f"Espaco {space} nao existe", 404)

    # Confere a pasta AGORA, com a credencial: o erro mais comum (pasta nao
    # compartilhada com a conta de servico) precisa aparecer na hora de ligar,
    # e nao como "erro" na primeira rodada.
    cred = _credencial(connection_id)
    try:
        meta = gdrive.pasta(cred, folder_id)
    except gdrive.DriveError as exc:
        raise SyncError(str(exc), 400) from None

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO storage_sync
                (connection_id, space_slug, folder_id, folder_name, recursive,
                 interval_minutes, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (space_slug, connection_id, folder_id) DO NOTHING
            RETURNING id
            """,
            (connection_id, space, meta["id"], meta["name"], recursivo, intervalo, por_quem),
        )
        linha = cur.fetchone()
        connection.commit()
    if linha is None:
        raise SyncError(f"a pasta \"{meta['name']}\" ja esta sincronizada com esta base.", 409)
    log.info("pasta %s sincronizada com %s por %s", meta["name"], space, por_quem)
    acordar()
    return obter_sync(linha[0])


def atualizar_sync(sync_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    obter_sync(sync_id)
    campos: list[str] = []
    valores: list[Any] = []
    if "enabled" in payload:
        campos.append("enabled = %s")
        valores.append(bool(payload["enabled"]))
    if "recursive" in payload:
        campos.append("recursive = %s")
        valores.append(bool(payload["recursive"]))
    if "interval_minutes" in payload:
        campos.append("interval_minutes = %s")
        valores.append(_intervalo(payload["interval_minutes"]))
    if not campos:
        raise SyncError("nada para atualizar")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(f"UPDATE storage_sync SET {', '.join(campos)} WHERE id = %s",
                    (*valores, sync_id))
        connection.commit()
    return obter_sync(sync_id)


def pedir_rodada(sync_id: int) -> dict[str, Any]:
    """Antecipa a proxima rodada para agora. Nao espera: a rodada e da thread."""
    obter_sync(sync_id)
    with conn() as connection, connection.cursor() as cur:
        cur.execute("UPDATE storage_sync SET next_run_at = now() WHERE id = %s", (sync_id,))
        connection.commit()
    acordar()
    return obter_sync(sync_id)


def remover_sync(sync_id: int, manter_documentos: bool) -> dict[str, Any]:
    """Para de sincronizar. Os documentos saem junto, salvo `manter_documentos`.

    Mantidos, eles viram upload manual (`sync_id` vai a NULL pela FK), e a
    partir dai nenhuma sincronizacao os toca.
    """
    sync = obter_sync(sync_id)
    removidos = 0
    with conn() as connection, connection.cursor() as cur:
        # A rodada pode estar no ar: sem desligar primeiro, ela enfileiraria
        # arquivo de uma pasta que acabou de sair.
        cur.execute("UPDATE storage_sync SET enabled = FALSE WHERE id = %s", (sync_id,))
        _cancelar_fila(cur, sync_id, None, "a sincronização foi removida")
        cur.execute("SELECT id FROM document WHERE sync_id = %s", (sync_id,))
        ids = [linha[0] for linha in cur.fetchall()]
        connection.commit()
    if not manter_documentos:
        for document_id in ids:
            if ingest.remover_documento(document_id):
                removidos += 1
    with conn() as connection, connection.cursor() as cur:
        cur.execute("DELETE FROM storage_sync WHERE id = %s", (sync_id,))
        connection.commit()
    log.info("sincronizacao %s (%s -> %s) removida; %s documento(s) removido(s)",
             sync_id, sync["folder_name"], sync["space"], removidos)
    return {"removed": sync_id, "documents_removed": removidos,
            "documents_kept": 0 if not manter_documentos else len(ids)}


def itens(sync_id: int) -> list[dict[str, Any]]:
    obter_sync(sync_id)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT i.ref, i.path, i.name, i.mime, i.size_bytes, i.status, i.error,
                   i.updated_at, r.status, r.error, d.id, d.status
              FROM storage_sync_item i
              LEFT JOIN ingest_run r ON r.id = i.run_id
              LEFT JOIN LATERAL (
                   SELECT id, status FROM document
                    WHERE sync_id = i.sync_id AND source_ref = i.ref AND active
                    ORDER BY id DESC LIMIT 1) d ON TRUE
             WHERE i.sync_id = %s
             ORDER BY i.path
            """,
            (sync_id,),
        )
        linhas = cur.fetchall()
    return [
        {
            "ref": lin[0], "path": lin[1], "name": lin[2], "mime": lin[3], "size_bytes": lin[4],
            "status": lin[5], "error": lin[6],
            "updated_at": lin[7].isoformat() if lin[7] else None,
            "run_status": lin[8], "run_error": lin[9] or "",
            "document_id": lin[10], "document_status": lin[11],
        }
        for lin in linhas
    ]


# ── a rodada ───────────────────────────────────────────────────────────────


def _cancelar_fila(cur, sync_id: int, ref: str | None, motivo: str) -> None:
    """Tira da fila o que ainda nao comecou: versao superada ou arquivo que saiu."""
    sql = ("UPDATE ingest_run SET status = 'cancelled', finished_at = now(),"
           " stage = 'cancelado', stage_detail = %s"
           " WHERE sync_id = %s AND status = 'queued'")
    params: tuple = (motivo, sync_id)
    if ref is not None:
        sql += " AND source_ref = %s"
        params = (*params, ref)
    cur.execute(sql, params)


def _suportado(nome: str) -> bool:
    return PurePosixPath(nome).suffix.lower() in SUPPORTED


def _gravar_item(cur, sync_id: int, remoto: dict[str, Any], nome: str, versao: str,
                 status: str, erro: str = "", run_id: int | None = None) -> None:
    cur.execute(
        """
        INSERT INTO storage_sync_item
            (sync_id, ref, path, name, mime, size_bytes, remote_version, status, error, run_id,
             updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (sync_id, ref) DO UPDATE
           SET path = EXCLUDED.path, name = EXCLUDED.name, mime = EXCLUDED.mime,
               size_bytes = EXCLUDED.size_bytes, remote_version = EXCLUDED.remote_version,
               status = EXCLUDED.status, error = EXCLUDED.error,
               run_id = COALESCE(EXCLUDED.run_id, storage_sync_item.run_id),
               updated_at = now()
        """,
        (sync_id, remoto["id"], remoto["path"], nome, remoto["mimeType"],
         int(remoto.get("size") or 0), versao, status, erro[:500], run_id),
    )


def rodar(sync_id: int) -> dict[str, Any]:
    """Uma rodada: compara a pasta com o que ja entrou e poe a base em dia.

    Devolve o resumo, que tambem fica em `storage_sync.last_summary`.
    """
    with conn() as connection, connection.cursor() as cur:
        # A trava e a propria linha: `running` so passa uma vez. Com duas
        # replicas, duas threads nao rodariam a mesma pasta juntas.
        cur.execute(
            """
            UPDATE storage_sync SET status = 'running', last_run_at = now()
             WHERE id = %s AND status <> 'running'
            RETURNING connection_id, space_slug, folder_id, recursive, interval_minutes
            """,
            (sync_id,),
        )
        linha = cur.fetchone()
        connection.commit()
    if linha is None:
        return {"skipped": "ja em andamento"}
    connection_id, space, folder_id, recursivo, intervalo = linha
    resumo = {"novos": 0, "atualizados": 0, "renomeados": 0, "removidos": 0,
              "ignorados": 0, "erros": 0, "arquivos": 0}
    try:
        _rodada(sync_id, connection_id, space, folder_id, recursivo, resumo)
    except Exception as exc:  # noqa: BLE001 - a rodada falha, a thread nao
        mensagem = str(exc)[:500]
        log.warning("sincronizacao %s falhou: %s", sync_id, mensagem)
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                UPDATE storage_sync
                   SET status = 'error', last_error = %s, last_summary = %s,
                       next_run_at = now() + (interval_minutes || ' minutes')::interval
                 WHERE id = %s
                """,
                (mensagem, jsonb(resumo), sync_id),
            )
            connection.commit()
        return {**resumo, "error": mensagem}

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE storage_sync
               SET status = 'idle', last_error = '', last_ok_at = now(), last_summary = %s,
                   next_run_at = now() + (interval_minutes || ' minutes')::interval
             WHERE id = %s
            """,
            (jsonb(resumo), sync_id),
        )
        connection.commit()
    if resumo["novos"] or resumo["atualizados"]:
        fila.acordar()
    log.info("sincronizacao %s (%s): %s", sync_id, space, resumo)
    return resumo


def _rodada(sync_id: int, connection_id: int, space: str, folder_id: str,
            recursivo: bool, resumo: dict[str, int]) -> None:
    cred = _credencial(connection_id)
    # A pasta primeiro, e SEPARADO da listagem. Pasta descompartilhada nao da
    # erro na listagem: `'<id>' in parents` so volta vazio -- e vazio, aqui,
    # significaria remover da base todos os documentos dela. `pasta()` levanta
    # 404 nesse caso, e a rodada para antes de apagar qualquer coisa.
    meta = gdrive.pasta(cred, folder_id)
    with conn() as connection, connection.cursor() as cur:
        cur.execute("UPDATE storage_sync SET folder_name = %s WHERE id = %s",
                    (meta["name"], sync_id))
        connection.commit()
    # Listar TUDO antes de mexer em qualquer coisa. Se a listagem cair no meio
    # (cota, rede), a excecao sobe daqui e nada e removido: remover com uma
    # listagem pela metade apagaria da base metade da pasta.
    remotos = gdrive.arquivos(cred, folder_id, recursivo)
    resumo["arquivos"] = len(remotos)
    limite = settings.max_upload_mb * 1024 * 1024
    principal = f"sincronizacao:{sync_id}"

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT ref, name, remote_version, status FROM storage_sync_item WHERE sync_id = %s",
            (sync_id,),
        )
        conhecidos = {lin[0]: {"name": lin[1], "version": lin[2], "status": lin[3]}
                      for lin in cur.fetchall()}
        # O que JA esta na base, ou a caminho dela. Arquivo sem nenhum dos dois
        # foi removido a mao da tela: a pasta manda, e ele volta. So a versao
        # ATIVA conta: remover a atual deixa as anteriores (inativas) no banco,
        # e conta-las fazia o arquivo nunca mais voltar.
        cur.execute(
            "SELECT DISTINCT source_ref FROM document WHERE sync_id = %s AND active",
            (sync_id,),
        )
        na_base = {lin[0] for lin in cur.fetchall()}
        cur.execute(
            "SELECT DISTINCT source_ref FROM ingest_run"
            " WHERE sync_id = %s AND status IN ('queued', 'running')",
            (sync_id,),
        )
        a_caminho = {lin[0] for lin in cur.fetchall()}

    validos: set[str] = set()
    for remoto in remotos:
        if _parar.is_set():
            # Desligando: nao remove nada no fim, porque `validos` esta pela metade.
            raise RuntimeError("serviço desligando; a rodada continua na próxima subida")
        ref = remoto["id"]
        nome = gdrive.nome_local(remoto)
        versao = gdrive.versao(remoto)
        conhecido = conhecidos.get(ref)

        motivo_fora = ""
        if not _suportado(nome):
            motivo_fora = f"formato não suportado ({PurePosixPath(nome).suffix or 'sem extensão'})"
        elif int(remoto.get("size") or 0) > limite:
            motivo_fora = f"passa do limite de {settings.max_upload_mb} MB (KB_MAX_UPLOAD_MB)"
        if motivo_fora:
            with conn() as connection, connection.cursor() as cur:
                _gravar_item(cur, sync_id, remoto, nome, versao, "skipped", motivo_fora)
                connection.commit()
            resumo["ignorados"] += 1
            continue
        validos.add(ref)

        presente = ref in na_base or ref in a_caminho
        if (conhecido and conhecido["version"] == versao and conhecido["status"] != "error"
                and presente):
            if conhecido["name"] != nome:
                # Renomear ou mover nao muda o conteudo: reingerir custaria OCR
                # e embedding para trocar um rotulo.
                with conn() as connection, connection.cursor() as cur:
                    cur.execute(
                        "UPDATE document SET filename = %s"
                        " WHERE sync_id = %s AND source_ref = %s AND active",
                        (nome, sync_id, ref),
                    )
                    _gravar_item(cur, sync_id, remoto, nome, versao, conhecido["status"])
                    connection.commit()
                resumo["renomeados"] += 1
            continue

        try:
            dados = gdrive.baixar(cred, remoto, limite)
        except gdrive.DriveError as exc:
            # Versao vazia de proposito: a proxima rodada tenta de novo, em vez
            # de achar que ja esta em dia.
            with conn() as connection, connection.cursor() as cur:
                _gravar_item(cur, sync_id, remoto, nome, "", "error", str(exc))
                connection.commit()
            resumo["erros"] += 1
            continue

        origem = ingest.Origem(sync_id, ref)
        with conn() as connection, connection.cursor() as cur:
            _cancelar_fila(cur, sync_id, ref, "substituído por uma versão mais nova do arquivo")
            connection.commit()
        enfileirado = ingest.enfileirar(space, nome, dados, principal, origem)
        del dados
        with conn() as connection, connection.cursor() as cur:
            _gravar_item(cur, sync_id, remoto, nome, versao, "synced",
                         run_id=enfileirado["run_id"])
            connection.commit()
        resumo["atualizados" if conhecido or ref in na_base else "novos"] += 1

    # ── o que saiu da pasta ──
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT id, source_ref FROM document WHERE sync_id = %s", (sync_id,))
        sobrando = [(lin[0], lin[1]) for lin in cur.fetchall() if lin[1] not in validos]
        for ref in {r for _, r in sobrando} | (set(conhecidos) - validos):
            _cancelar_fila(cur, sync_id, ref, "o arquivo saiu da pasta sincronizada")
        remotos_ids = {r["id"] for r in remotos}
        cur.execute(
            "DELETE FROM storage_sync_item WHERE sync_id = %s AND NOT (ref = ANY(%s))",
            (sync_id, list(remotos_ids)),
        )
        connection.commit()
    refs_removidos: set[str] = set()
    for document_id, ref in sobrando:
        if ingest.remover_documento(document_id):
            refs_removidos.add(ref)
    resumo["removidos"] = len(refs_removidos)


# ── a thread ───────────────────────────────────────────────────────────────


def acordar() -> None:
    _acordar.set()


def _vencidas() -> list[int]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT id FROM storage_sync"
            " WHERE enabled AND status <> 'running' AND next_run_at <= now()"
            " ORDER BY next_run_at"
        )
        return [lin[0] for lin in cur.fetchall()]


def retomar_orfas() -> int:
    """Na subida: `running` e de uma rodada que morreu com o pod anterior."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "UPDATE storage_sync SET status = 'idle', next_run_at = now()"
            " WHERE status = 'running'"
        )
        total = cur.rowcount
        connection.commit()
    return total


def _laco() -> None:
    while not _parar.is_set():
        try:
            for sync_id in _vencidas():
                if _parar.is_set():
                    break
                rodar(sync_id)
        except Exception as exc:  # noqa: BLE001 - Postgres piscou; tenta de novo
            log.warning("sincronizacao: rodada do laco falhou: %s", exc)
        _acordar.wait(TIQUE_SEGUNDOS)
        _acordar.clear()


def iniciar() -> None:
    try:
        retomadas = retomar_orfas()
        if retomadas:
            log.warning("sincronizacao: %s rodada(s) interrompida(s) pela queda do pod", retomadas)
    except Exception as exc:  # noqa: BLE001
        log.warning("sincronizacao: nao consegui retomar rodadas orfas: %s", exc)
    threading.Thread(target=_laco, name="sincronizacao", daemon=True).start()
    log.info("sincronizacao de armazenamentos externos iniciada")


def parar() -> None:
    _parar.set()
    _acordar.set()
