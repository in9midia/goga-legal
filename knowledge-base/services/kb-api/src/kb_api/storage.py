"""Object storage do documento bruto (ING-02).

O bruto e preservado intacto para auditoria e reprocessamento com outra tecnica
de extracao (FUN-12).

DOIS BACKENDS, MESMA INTERFACE, ESCOLHIDOS POR `KB_STORAGE_BACKEND`:

  s3          MinIO no local, OCI Object Storage em producao. Cliente escrito na
              mao com assinatura AWS SigV4: sao ~60 linhas e evitam arrastar
              boto3 (e as dependencias dele) para dentro da imagem.
  filesystem  um diretorio em disco, normalmente um PVC.

O `filesystem` existe por uma razao concreta: em DEV a credencial de object
storage da OCI (Customer Secret Key) e um pedido a infra, e esperar por ela
deixava o ambiente inteiro parado. Com ele o cluster sobe hoje; quando a
credencial chegar, muda `KB_STORAGE_BACKEND=s3` e mais nada -- nenhuma linha de
chamada muda, porque as cinco funcoes publicas tem contrato identico nos dois.

O preco de ter dois caminhos e conhecido: o que roda em DEV nao e o que roda em
producao. Por isso o `s3` continua sendo o PADRAO -- quem quiser o disco precisa
pedir explicitamente -- e o `filesystem` NAO serve para mais de uma replica (o
disco e RWO e cada pod veria um pedaco do acervo).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import os
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)

# A regiao entra no ESCOPO da assinatura SigV4, entao ela precisa casar com o
# que o servidor espera. O MinIO nao confere e aceita qualquer valor -- por isso
# `us-east-1` bastou ate agora. O OCI Object Storage (endpoint `compat`) CONFERE:
# com a regiao errada ele devolve 403 SignatureDoesNotMatch, que parece
# credencial invalida e nao e. Por isso virou configuracao.
SERVICE = "s3"


def _region() -> str:
    return settings.s3_region


class StorageError(RuntimeError):
    pass


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def _signed_request(
    method: str, key: str, body: bytes = b"", query: str = ""
) -> urllib.request.Request:
    endpoint = settings.s3_endpoint.rstrip("/")
    parsed = urllib.parse.urlsplit(endpoint)
    host = parsed.netloc
    path = f"/{settings.s3_bucket}"
    if key:
        # Cada segmento e escapado separadamente: barra e separador de path,
        # nao caractere de nome.
        path += "/" + "/".join(urllib.parse.quote(part, safe="") for part in key.split("/"))

    now = dt.datetime.now(dt.UTC)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    canonical_headers = f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        [method, path, query, canonical_headers, signed_headers, payload_hash]
    )

    scope = f"{date_stamp}/{_region()}/{SERVICE}/aws4_request"
    to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )

    signing_key = _sign(f"AWS4{settings.s3_secret_key}".encode(), date_stamp)
    for part in (_region(), SERVICE, "aws4_request"):
        signing_key = _sign(signing_key, part)
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={settings.s3_access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    url = f"{endpoint}{path}"
    if query:
        url += f"?{query}"
    return urllib.request.Request(
        url,
        data=body or None,
        method=method,
        headers={
            "Host": host,
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
            "Authorization": authorization,
            "Content-Length": str(len(body)),
        },
    )


def _s3_ensure_bucket() -> None:
    try:
        urllib.request.urlopen(_signed_request("PUT", ""), timeout=30)
        log.info("bucket %s criado", settings.s3_bucket)
    except urllib.error.HTTPError as exc:
        # 409 = ja existe, o caso normal a partir da segunda subida.
        if exc.code not in (409, 200):
            body = exc.read().decode("utf-8", errors="replace")[:200]
            if "BucketAlreadyOwnedByYou" not in body and "BucketAlreadyExists" not in body:
                raise StorageError(f"nao consegui criar o bucket: HTTP {exc.code} {body}") from None
    except Exception as exc:  # noqa: BLE001 - rede
        raise StorageError(f"object store inacessivel em {settings.s3_endpoint}: {exc}") from None


def _s3_put(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    request = _signed_request("PUT", key, data)
    request.add_header("Content-Type", content_type)
    try:
        urllib.request.urlopen(request, timeout=300)
    except urllib.error.HTTPError as exc:
        raise StorageError(
            f"falha ao gravar {key}: HTTP {exc.code} "
            f"{exc.read().decode('utf-8', errors='replace')[:200]}"
        ) from None
    return key


def _s3_delete(key: str) -> None:
    """Remove um objeto. Chave que ja nao existe nao e erro.

    O 404 e tratado como sucesso de proposito: a remocao de um documento
    percorre varias chaves, e abortar na primeira ausente deixaria o resto para
    tras -- justamente o caso em que a remocao anterior falhou pela metade.
    """
    try:
        urllib.request.urlopen(_signed_request("DELETE", key), timeout=60)
    except urllib.error.HTTPError as exc:
        if exc.code in (204, 404):
            return
        raise StorageError(f"nao consegui remover {key}: HTTP {exc.code}") from None
    except Exception as exc:  # noqa: BLE001
        raise StorageError(f"nao consegui remover {key}: {exc}") from None


def _s3_stats() -> dict:
    """Quantos objetos e quantos bytes o bucket guarda.

    Existe para a tela tecnica poder dizer o tamanho do bruto preservado. Usa o
    ListObjectsV2 paginado: sem o cursor, um bucket com mais de 1000 chaves
    reportaria 1000 e o numero pareceria certo -- que e o pior tipo de numero
    errado.
    """
    total_objetos = 0
    total_bytes = 0
    token = ""
    for _ in range(50):  # teto de paginas: 50k objetos, muito acima desta base
        # A query da assinatura SigV4 tem de vir ORDENADA por chave e com cada
        # valor escapado -- ordem diferente e assinatura invalida, e o MinIO
        # responde 403 sem dizer por que.
        parametros = {"list-type": "2", "max-keys": "1000"}
        if token:
            parametros["continuation-token"] = token
        query = "&".join(
            f"{chave}={urllib.parse.quote(valor, safe='')}"
            for chave, valor in sorted(parametros.items())
        )
        request = _signed_request("GET", "", query=query)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"nao consegui listar o bucket: {exc}") from None

        total_objetos += len(re.findall(r"<Key>", body))
        total_bytes += sum(int(m) for m in re.findall(r"<Size>(\d+)</Size>", body))

        if "<IsTruncated>true</IsTruncated>" not in body:
            break
        match = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", body)
        if not match:
            break
        token = match.group(1)

    return {"objects": total_objetos, "bytes": total_bytes, "bucket": settings.s3_bucket}


def _s3_get(key: str) -> bytes:
    try:
        with urllib.request.urlopen(_signed_request("GET", key), timeout=300) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise StorageError(f"falha ao ler {key}: HTTP {exc.code}") from None


# ── backend `filesystem` ───────────────────────────────────────────────────
#
# Um objeto = um arquivo sob `KB_STORAGE_DIR`, com a chave virando caminho
# relativo. As chaves ja tem a forma `<espaco>/<sha[:2]>/<sha>/<nome>`, entao a
# arvore em disco fica legivel e casa 1:1 com o que o backend s3 mostraria.


def _raiz() -> Path:
    return Path(settings.storage_dir)


def _caminho(key: str) -> Path:
    """Resolve a chave para um caminho DENTRO da raiz, ou recusa.

    A ultima parte da chave e o nome do arquivo ENVIADO por quem faz upload.
    Sem esta checagem, um nome como `../../etc/cron.d/x` sairia da raiz e
    escreveria onde nao devia -- e o mesmo vale para leitura e remocao. Isto
    nao e defesa contra usuario malicioso apenas: `..` aparece sozinho em
    export de sistema legado.
    """
    if not key or key.startswith("/"):
        raise StorageError(f"chave invalida: {key!r}")
    raiz = _raiz().resolve()
    alvo = (raiz / key).resolve()
    # `is_relative_to` (3.9+) compara os caminhos JA resolvidos, entao pega
    # tanto `..` quanto symlink apontando para fora.
    if not alvo.is_relative_to(raiz):
        raise StorageError(f"chave escapa da raiz do storage: {key!r}")
    return alvo


def _fs_ensure_bucket() -> None:
    try:
        _raiz().mkdir(parents=True, exist_ok=True)
        # Escrita de verdade: `mkdir` num volume montado read-only passa em
        # silencio se o diretorio ja existir, e a falha so apareceria na
        # primeira ingestao -- depois de o usuario esperar o upload inteiro.
        sonda = _raiz() / ".escrita-ok"
        sonda.write_bytes(b"")
        sonda.unlink()
    except OSError as exc:
        raise StorageError(f"diretorio de storage inutilizavel ({_raiz()}): {exc}") from None


def _fs_put(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    alvo = _caminho(key)
    alvo.parent.mkdir(parents=True, exist_ok=True)
    # Grava em temporario e renomeia: `rename` no mesmo sistema de arquivos e
    # atomico, entao um pod morto no meio da escrita deixa o arquivo ANTIGO ou
    # nenhum -- nunca um truncado, que a extracao leria como documento corrompido.
    temporario = alvo.with_name(f".{alvo.name}.parcial")
    try:
        temporario.write_bytes(data)
        os.replace(temporario, alvo)
    except OSError as exc:
        temporario.unlink(missing_ok=True)
        raise StorageError(f"falha ao gravar {key}: {exc}") from None
    return key


def _fs_get(key: str) -> bytes:
    try:
        return _caminho(key).read_bytes()
    except FileNotFoundError:
        raise StorageError(f"falha ao ler {key}: nao encontrado") from None
    except OSError as exc:
        raise StorageError(f"falha ao ler {key}: {exc}") from None


def _fs_delete(key: str) -> None:
    """Remove um objeto. Chave que ja nao existe nao e erro -- ver `_s3_delete`."""
    try:
        _caminho(key).unlink(missing_ok=True)
    except OSError as exc:
        raise StorageError(f"nao consegui remover {key}: {exc}") from None


def _fs_stats() -> dict:
    total_objetos = 0
    total_bytes = 0
    raiz = _raiz()
    if raiz.is_dir():
        for atual, _dirs, arquivos in os.walk(raiz):
            for nome in arquivos:
                # Os `.parcial` sao escrita em andamento, nao acervo.
                if nome.startswith(".") and nome.endswith(".parcial"):
                    continue
                try:
                    total_bytes += (Path(atual) / nome).stat().st_size
                    total_objetos += 1
                except OSError:
                    # Arquivo removido entre o walk e o stat: nao e erro de
                    # storage, e uma foto tirada durante a mudanca.
                    continue
    livres = shutil.disk_usage(raiz).free if raiz.is_dir() else 0
    return {
        "objects": total_objetos,
        "bytes": total_bytes,
        # A tela tecnica mostra este campo como "bucket". No disco, o que
        # identifica o acervo e o caminho.
        "bucket": str(raiz),
        "free_bytes": livres,
    }


# ── despacho ───────────────────────────────────────────────────────────────

_BACKENDS = {
    "s3": (_s3_ensure_bucket, _s3_put, _s3_get, _s3_delete, _s3_stats),
    "filesystem": (_fs_ensure_bucket, _fs_put, _fs_get, _fs_delete, _fs_stats),
}


def _backend():
    escolhido = settings.storage_backend
    if escolhido not in _BACKENDS:
        raise StorageError(
            f"KB_STORAGE_BACKEND desconhecido: {escolhido!r}. "
            f"Use {' ou '.join(sorted(_BACKENDS))}."
        )
    return _BACKENDS[escolhido]


def ensure_bucket() -> None:
    return _backend()[0]()


def put(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    return _backend()[1](key, data, content_type)


def get(key: str) -> bytes:
    return _backend()[2](key)


def delete(key: str) -> None:
    return _backend()[3](key)


def stats() -> dict:
    return _backend()[4]()
