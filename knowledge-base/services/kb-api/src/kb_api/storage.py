"""Object storage do documento bruto (ING-02).

O bruto e preservado intacto para auditoria e reprocessamento com outra tecnica
de extracao (FUN-12).

DOIS BACKENDS, MESMA INTERFACE, ESCOLHIDOS POR `KB_STORAGE_BACKEND`:

  s3          MinIO no local; AWS S3 ou OCI Object Storage fora dele
              (`S3_PROVIDER`, ver `config.S3Config`). Cliente escrito na mao
              com assinatura AWS SigV4: evita arrastar boto3 (e as
              dependencias dele) para dentro da imagem.
  filesystem  um diretorio em disco, normalmente um PVC.

O `filesystem` existe por uma razao concreta: em DEV a credencial de object
storage da OCI (Customer Secret Key) e um pedido a infra, e esperar por ela
deixava o ambiente inteiro parado. Com ele o cluster sobe hoje; quando a
credencial chegar, muda `KB_STORAGE_BACKEND=s3` e mais nada -- nenhuma linha de
chamada muda, porque as funcoes publicas tem contrato identico nos dois.

Cada backend e uma classe (`S3Store`, `FsStore`) e as funcoes do modulo
despacham para a configurada. As classes existem por causa da migracao
(`migrar_storage.py`): ela precisa de DUAS lojas vivas ao mesmo tempo -- a de
hoje e a de destino -- e isso nao cabe em funcao que le `settings` global.

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
import mimetypes
import os
import shutil
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path

from .config import S3_PROVIDERS, S3Config, settings

log = logging.getLogger(__name__)

# A regiao entra no ESCOPO da assinatura SigV4, entao ela precisa casar com o
# que o servidor espera. O MinIO nao confere e aceita qualquer valor -- por isso
# `us-east-1` bastou ate agora. O OCI Object Storage (endpoint `compat`) e a
# AWS CONFEREM: com a regiao errada o OCI devolve 403 SignatureDoesNotMatch, que
# parece credencial invalida e nao e, e a AWS devolve 301 com a regiao certa no
# cabecalho `x-amz-bucket-region` (que o `ensure_bucket` repassa na mensagem).
SERVICE = "s3"
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


class StorageError(RuntimeError):
    pass


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


class S3Store:
    """Um bucket S3 (MinIO, AWS, OCI) falado por SigV4."""

    def __init__(self, cfg: S3Config) -> None:
        if cfg.provider not in S3_PROVIDERS:
            raise StorageError(
                f"S3_PROVIDER desconhecido: {cfg.provider!r}. Use {' ou '.join(S3_PROVIDERS)}."
            )
        self.cfg = cfg

    def descricao(self) -> str:
        return f"s3[{self.cfg.provider}] {self.cfg.endpoint} bucket={self.cfg.bucket}"

    # ── assinatura ──

    def _request(
        self,
        method: str,
        key: str,
        body: bytes = b"",
        query: str = "",
        amz_headers: dict[str, str] | None = None,
    ) -> urllib.request.Request:
        cfg = self.cfg
        parsed = urllib.parse.urlsplit(cfg.endpoint)
        # Cada segmento e escapado separadamente: barra e separador de path,
        # nao caractere de nome.
        chave = (
            "/".join(urllib.parse.quote(part, safe="") for part in key.split("/")) if key else ""
        )
        if cfg.addressing == "virtual":
            host = f"{cfg.bucket}.{parsed.netloc}"
            path = f"/{chave}"
            url = f"{parsed.scheme}://{host}{path}"
        else:
            host = parsed.netloc
            path = f"/{cfg.bucket}" + (f"/{chave}" if chave else "")
            url = f"{cfg.endpoint}{path}"

        now = dt.datetime.now(dt.UTC)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()

        # Todo `x-amz-*` enviado TEM de entrar na assinatura -- a AWS recusa
        # cabecalho amz fora da lista assinada. Por isso o token de sessao e a
        # SSE passam por aqui, e o Content-Type (que nao e amz) nao.
        assinados = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
            **{k.lower(): v for k, v in (amz_headers or {}).items()},
        }
        if cfg.session_token:
            assinados["x-amz-security-token"] = cfg.session_token
        nomes = sorted(assinados)
        canonical_headers = "".join(f"{n}:{assinados[n].strip()}\n" for n in nomes)
        signed_headers = ";".join(nomes)
        canonical_request = "\n".join(
            [method, path, query, canonical_headers, signed_headers, payload_hash]
        )

        scope = f"{date_stamp}/{cfg.region}/{SERVICE}/aws4_request"
        to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )

        signing_key = _sign(f"AWS4{cfg.secret_key}".encode(), date_stamp)
        for part in (cfg.region, SERVICE, "aws4_request"):
            signing_key = _sign(signing_key, part)
        signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()

        headers = {n: assinados[n] for n in nomes}
        headers["Authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={cfg.access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        headers["Content-Length"] = str(len(body))
        if query:
            url += f"?{query}"
        return urllib.request.Request(url, data=body or None, method=method, headers=headers)

    # ── operacoes ──

    def ensure_bucket(self) -> None:
        """Confere o bucket e, se permitido, cria.

        HEAD primeiro, e nao PUT direto: na AWS a credencial da aplicacao
        normalmente NAO tem `s3:CreateBucket` (e nem deveria), e o PUT
        devolveria 403 para um bucket que existe e funciona.
        """
        cfg = self.cfg
        try:
            urllib.request.urlopen(self._request("HEAD", ""), timeout=30)
            return
        except urllib.error.HTTPError as exc:
            status = exc.code
            regiao_real = exc.headers.get("x-amz-bucket-region", "") if exc.headers else ""
        except Exception as exc:  # noqa: BLE001 - rede
            raise StorageError(f"object store inacessivel em {cfg.endpoint}: {exc}") from None

        if regiao_real and regiao_real != cfg.region:
            raise StorageError(
                f"o bucket {cfg.bucket} fica em {regiao_real}, mas S3_REGION={cfg.region}"
            )
        if status == 403:
            raise StorageError(
                f"sem permissao no bucket {cfg.bucket} (HTTP 403): credencial invalida, "
                "sem s3:ListBucket, ou bucket de outra conta"
            )
        if status != 404:
            raise StorageError(f"nao consegui conferir o bucket {cfg.bucket}: HTTP {status}")
        if not cfg.create_bucket:
            raise StorageError(
                f"o bucket {cfg.bucket} nao existe. Crie-o na conta (recomendado) ou "
                "ligue S3_CREATE_BUCKET=true"
            )

        corpo = b""
        # Fora de us-east-1 a AWS exige a regiao no corpo do CreateBucket.
        if cfg.provider == "aws" and cfg.region != "us-east-1":
            corpo = (
                '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f"<LocationConstraint>{cfg.region}</LocationConstraint>"
                "</CreateBucketConfiguration>"
            ).encode()
        try:
            urllib.request.urlopen(self._request("PUT", "", corpo), timeout=30)
            log.info("bucket %s criado", cfg.bucket)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:200]
            # Corrida com outra replica subindo junto: ja existe e e nosso.
            if "BucketAlreadyOwnedByYou" not in body:
                raise StorageError(f"nao consegui criar o bucket: HTTP {exc.code} {body}") from None
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"object store inacessivel em {cfg.endpoint}: {exc}") from None

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        extras: dict[str, str] = {}
        if self.cfg.sse:
            extras["x-amz-server-side-encryption"] = self.cfg.sse
            if self.cfg.sse == "aws:kms" and self.cfg.sse_kms_key_id:
                extras["x-amz-server-side-encryption-aws-kms-key-id"] = self.cfg.sse_kms_key_id
        request = self._request("PUT", key, data, amz_headers=extras)
        request.add_header("Content-Type", content_type)
        try:
            urllib.request.urlopen(request, timeout=300)
        except urllib.error.HTTPError as exc:
            raise StorageError(
                f"falha ao gravar {key}: HTTP {exc.code} "
                f"{exc.read().decode('utf-8', errors='replace')[:200]}"
            ) from None
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"falha ao gravar {key}: {exc}") from None
        return key

    def get_com_tipo(self, key: str) -> tuple[bytes, str]:
        try:
            with urllib.request.urlopen(self._request("GET", key), timeout=300) as response:
                tipo = response.headers.get("Content-Type") or "application/octet-stream"
                return response.read(), tipo
        except urllib.error.HTTPError as exc:
            raise StorageError(f"falha ao ler {key}: HTTP {exc.code}") from None
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"falha ao ler {key}: {exc}") from None

    def get(self, key: str) -> bytes:
        return self.get_com_tipo(key)[0]

    def tamanho(self, key: str) -> int | None:
        """Bytes do objeto, ou None se ele nao existe."""
        try:
            with urllib.request.urlopen(self._request("HEAD", key), timeout=60) as response:
                return int(response.headers.get("Content-Length", "0"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise StorageError(f"nao consegui conferir {key}: HTTP {exc.code}") from None
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"nao consegui conferir {key}: {exc}") from None

    def delete(self, key: str) -> None:
        """Remove um objeto. Chave que ja nao existe nao e erro.

        O 404 e tratado como sucesso de proposito: a remocao de um documento
        percorre varias chaves, e abortar na primeira ausente deixaria o resto
        para tras -- justamente o caso em que a remocao anterior falhou pela
        metade.
        """
        try:
            urllib.request.urlopen(self._request("DELETE", key), timeout=60)
        except urllib.error.HTTPError as exc:
            if exc.code in (204, 404):
                return
            raise StorageError(f"nao consegui remover {key}: HTTP {exc.code}") from None
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"nao consegui remover {key}: {exc}") from None

    def listar(self, prefixo: str = "") -> Iterator[tuple[str, int]]:
        """Todas as chaves do bucket, com o tamanho, via ListObjectsV2 paginado.

        Sem seguir o cursor, um bucket com mais de 1000 chaves reportaria 1000 e
        o numero pareceria certo -- que e o pior tipo de numero errado.
        """
        token = ""
        while True:
            # A query da assinatura SigV4 tem de vir ORDENADA por chave e com
            # cada valor escapado -- ordem diferente e assinatura invalida, e o
            # MinIO responde 403 sem dizer por que.
            parametros = {"list-type": "2", "max-keys": "1000"}
            if token:
                parametros["continuation-token"] = token
            if prefixo:
                parametros["prefix"] = prefixo
            query = "&".join(
                f"{chave}={urllib.parse.quote(valor, safe='')}"
                for chave, valor in sorted(parametros.items())
            )
            try:
                with urllib.request.urlopen(
                    self._request("GET", "", query=query), timeout=60
                ) as response:
                    raiz = ET.fromstring(response.read())
            except Exception as exc:  # noqa: BLE001
                raise StorageError(f"nao consegui listar o bucket: {exc}") from None

            for item in raiz.iter(f"{_NS}Contents"):
                yield item.findtext(f"{_NS}Key", ""), int(item.findtext(f"{_NS}Size", "0"))

            if raiz.findtext(f"{_NS}IsTruncated") != "true":
                return
            token = raiz.findtext(f"{_NS}NextContinuationToken") or ""
            if not token:
                return

    def stats(self) -> dict:
        """Quantos objetos e quantos bytes o bucket guarda (tela tecnica)."""
        total_objetos = 0
        total_bytes = 0
        for _chave, tamanho in self.listar():
            total_objetos += 1
            total_bytes += tamanho
        return {
            "objects": total_objetos,
            "bytes": total_bytes,
            "bucket": self.cfg.bucket,
            "provider": self.cfg.provider,
        }


# ── backend `filesystem` ───────────────────────────────────────────────────
#
# Um objeto = um arquivo sob `KB_STORAGE_DIR`, com a chave virando caminho
# relativo. As chaves ja tem a forma `<espaco>/<sha[:2]>/<sha>/<nome>`, entao a
# arvore em disco fica legivel e casa 1:1 com o que o backend s3 mostraria.


def _raiz() -> Path:
    return Path(settings.storage_dir)


def _eh_parcial(nome: str) -> bool:
    # Os `.parcial` sao escrita em andamento, nao acervo.
    return nome.startswith(".") and nome.endswith(".parcial")


class FsStore:
    """Um diretorio em disco, normalmente um PVC."""

    def __init__(self, raiz: str | Path) -> None:
        self.raiz = Path(raiz)

    def descricao(self) -> str:
        return f"filesystem {self.raiz}"

    def _caminho(self, key: str) -> Path:
        """Resolve a chave para um caminho DENTRO da raiz, ou recusa.

        A ultima parte da chave e o nome do arquivo ENVIADO por quem faz
        upload. Sem esta checagem, um nome como `../../etc/cron.d/x` sairia da
        raiz e escreveria onde nao devia -- e o mesmo vale para leitura e
        remocao. Isto nao e defesa contra usuario malicioso apenas: `..`
        aparece sozinho em export de sistema legado.
        """
        if not key or key.startswith("/"):
            raise StorageError(f"chave invalida: {key!r}")
        raiz = self.raiz.resolve()
        alvo = (raiz / key).resolve()
        # `is_relative_to` (3.9+) compara os caminhos JA resolvidos, entao pega
        # tanto `..` quanto symlink apontando para fora.
        if not alvo.is_relative_to(raiz):
            raise StorageError(f"chave escapa da raiz do storage: {key!r}")
        return alvo

    def ensure_bucket(self) -> None:
        try:
            self.raiz.mkdir(parents=True, exist_ok=True)
            # Escrita de verdade: `mkdir` num volume montado read-only passa em
            # silencio se o diretorio ja existir, e a falha so apareceria na
            # primeira ingestao -- depois de o usuario esperar o upload inteiro.
            sonda = self.raiz / ".escrita-ok"
            sonda.write_bytes(b"")
            sonda.unlink()
        except OSError as exc:
            raise StorageError(f"diretorio de storage inutilizavel ({self.raiz}): {exc}") from None

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        alvo = self._caminho(key)
        alvo.parent.mkdir(parents=True, exist_ok=True)
        # Grava em temporario e renomeia: `rename` no mesmo sistema de arquivos
        # e atomico, entao um pod morto no meio da escrita deixa o arquivo
        # ANTIGO ou nenhum -- nunca um truncado, que a extracao leria como
        # documento corrompido.
        temporario = alvo.with_name(f".{alvo.name}.parcial")
        try:
            temporario.write_bytes(data)
            os.replace(temporario, alvo)
        except OSError as exc:
            temporario.unlink(missing_ok=True)
            raise StorageError(f"falha ao gravar {key}: {exc}") from None
        return key

    def get(self, key: str) -> bytes:
        try:
            return self._caminho(key).read_bytes()
        except FileNotFoundError:
            raise StorageError(f"falha ao ler {key}: nao encontrado") from None
        except OSError as exc:
            raise StorageError(f"falha ao ler {key}: {exc}") from None

    def get_com_tipo(self, key: str) -> tuple[bytes, str]:
        # O disco nao guarda Content-Type; o nome do arquivo e o que ha.
        tipo = mimetypes.guess_type(key)[0] or "application/octet-stream"
        return self.get(key), tipo

    def tamanho(self, key: str) -> int | None:
        try:
            return self._caminho(key).stat().st_size
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise StorageError(f"nao consegui conferir {key}: {exc}") from None

    def delete(self, key: str) -> None:
        """Remove um objeto. Chave que ja nao existe nao e erro -- ver `S3Store.delete`."""
        try:
            self._caminho(key).unlink(missing_ok=True)
        except OSError as exc:
            raise StorageError(f"nao consegui remover {key}: {exc}") from None

    def listar(self, prefixo: str = "") -> Iterator[tuple[str, int]]:
        if not self.raiz.is_dir():
            return
        for atual, _dirs, arquivos in os.walk(self.raiz):
            for nome in arquivos:
                if _eh_parcial(nome) or nome == ".escrita-ok":
                    continue
                caminho = Path(atual) / nome
                chave = caminho.relative_to(self.raiz).as_posix()
                if prefixo and not chave.startswith(prefixo):
                    continue
                try:
                    yield chave, caminho.stat().st_size
                except OSError:
                    # Arquivo removido entre o walk e o stat: nao e erro de
                    # storage, e uma foto tirada durante a mudanca.
                    continue

    def stats(self) -> dict:
        total_objetos = 0
        total_bytes = 0
        for _chave, tamanho in self.listar():
            total_objetos += 1
            total_bytes += tamanho
        livres = shutil.disk_usage(self.raiz).free if self.raiz.is_dir() else 0
        return {
            "objects": total_objetos,
            "bytes": total_bytes,
            # A tela tecnica mostra este campo como "bucket". No disco, o que
            # identifica o acervo e o caminho.
            "bucket": str(self.raiz),
            "free_bytes": livres,
        }


def _caminho(key: str) -> Path:
    return FsStore(_raiz())._caminho(key)


# ── despacho ───────────────────────────────────────────────────────────────

_BACKENDS = {
    "s3": lambda: S3Store(settings.s3),
    "filesystem": lambda: FsStore(settings.storage_dir),
}

Store = S3Store | FsStore


def loja() -> Store:
    """A loja configurada para este processo (`KB_STORAGE_BACKEND`)."""
    escolhido = settings.storage_backend
    if escolhido not in _BACKENDS:
        raise StorageError(
            f"KB_STORAGE_BACKEND desconhecido: {escolhido!r}. Use {' ou '.join(sorted(_BACKENDS))}."
        )
    return _BACKENDS[escolhido]()


def ensure_bucket() -> None:
    return loja().ensure_bucket()


def put(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    return loja().put(key, data, content_type)


def get(key: str) -> bytes:
    return loja().get(key)


def delete(key: str) -> None:
    return loja().delete(key)


def stats() -> dict:
    return loja().stats()
