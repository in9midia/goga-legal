"""Backend `s3` do object storage e a migracao entre lojas.

O que estes testes protegem:

1. que `S3_PROVIDER=aws` resolva os padroes certos (endpoint regional,
   virtual-hosted, sem criar bucket) e que o `minio` continue como era;
2. que o `S3Store` cumpra o mesmo contrato do disco contra um servidor S3 de
   verdade no protocolo -- inclusive a paginacao do ListObjectsV2, que e onde
   um bucket de 1001 objetos viraria 1000 sem erro;
3. que a migracao copie tudo, seja idempotente e nunca apague.

A ASSINATURA nao e conferida aqui (o servidor falso aceita qualquer uma). Ela
foi comparada byte a byte com a do botocore na implementacao; um teste disso
exigiria botocore como dependencia so de teste.
"""

from __future__ import annotations

import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

import pytest

# Acesso pelo modulo, e nao `from kb_api.storage import ...`: o teste do backend
# em disco da `reload` no modulo, e uma classe importada antes do reload deixa
# de ser a mesma que o codigo levanta -- `pytest.raises(StorageError)` falhava
# so quando os dois arquivos rodavam juntos.
from kb_api import migrar_storage, storage
from kb_api.config import s3_config

# ── servidor S3 falso, path-style ──────────────────────────────────────────


class _S3Falso(BaseHTTPRequestHandler):
    buckets: dict[str, dict[str, tuple[bytes, str]]]
    pagina = 2  # pequena de proposito: forca a paginacao com poucos objetos

    def log_message(self, *args):  # silencio no pytest
        pass

    def _alvo(self):
        partes = urllib.parse.urlsplit(self.path)
        bucket, _, chave = partes.path.lstrip("/").partition("/")
        return bucket, urllib.parse.unquote(chave), urllib.parse.parse_qs(partes.query)

    def _responder(self, status, corpo=b"", headers=None):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corpo)

    def do_HEAD(self):
        bucket, chave, _ = self._alvo()
        if bucket not in self.buckets:
            return self._responder(404)
        if not chave:
            return self._responder(200)
        if chave not in self.buckets[bucket]:
            return self._responder(404)
        dados, _tipo = self.buckets[bucket][chave]
        self.send_response(200)
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()

    def do_PUT(self):
        bucket, chave, _ = self._alvo()
        corpo = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not chave:
            self.buckets.setdefault(bucket, {})
            return self._responder(200)
        if bucket not in self.buckets:
            return self._responder(404)
        self.buckets[bucket][chave] = (corpo, self.headers.get("Content-Type", ""))
        self._responder(200)

    def do_DELETE(self):
        bucket, chave, _ = self._alvo()
        self.buckets.get(bucket, {}).pop(chave, None)
        self._responder(204)

    def do_GET(self):
        bucket, chave, query = self._alvo()
        if bucket not in self.buckets:
            return self._responder(404)
        if chave:
            if chave not in self.buckets[bucket]:
                return self._responder(404)
            dados, tipo = self.buckets[bucket][chave]
            return self._responder(200, dados, {"Content-Type": tipo})
        prefixo = query.get("prefix", [""])[0]
        chaves = sorted(k for k in self.buckets[bucket] if k.startswith(prefixo))
        inicio = int(query.get("continuation-token", ["0"])[0])
        fatia = chaves[inicio : inicio + self.pagina]
        truncado = inicio + self.pagina < len(chaves)
        itens = "".join(
            f"<Contents><Key>{escape(k)}</Key><Size>{len(self.buckets[bucket][k][0])}</Size></Contents>"
            for k in fatia
        )
        cursor = (
            f"<NextContinuationToken>{inicio + self.pagina}</NextContinuationToken>"
            if truncado
            else ""
        )
        xml = (
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f"{itens}<IsTruncated>{'true' if truncado else 'false'}</IsTruncated>{cursor}"
            "</ListBucketResult>"
        )
        self._responder(200, xml.encode())


@pytest.fixture
def s3_falso():
    buckets: dict = {}
    handler = type("H", (_S3Falso,), {"buckets": buckets})
    servidor = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{servidor.server_address[1]}", buckets
    servidor.shutdown()


def _loja(monkeypatch, endpoint, bucket="acervo", **extra) -> storage.S3Store:
    for nome in list(__import__("os").environ):
        if nome.startswith(("T_S3_", "AWS_")):
            monkeypatch.delenv(nome, raising=False)
    monkeypatch.setenv("T_S3_ENDPOINT", endpoint)
    monkeypatch.setenv("T_S3_BUCKET", bucket)
    for chave, valor in extra.items():
        monkeypatch.setenv(f"T_S3_{chave}", valor)
    return storage.S3Store(s3_config("T_S3_"))


# ── configuracao ───────────────────────────────────────────────────────────


def test_minio_continua_com_os_padroes_de_antes(monkeypatch):
    for nome in ("X_PROVIDER", "X_ENDPOINT", "X_ACCESS_KEY", "X_REGION", "X_CREATE_BUCKET"):
        monkeypatch.delenv(nome, raising=False)
    cfg = s3_config("X_")
    assert cfg.provider == "minio"
    assert cfg.endpoint == "http://minio:9000"
    assert cfg.addressing == "path"
    assert cfg.create_bucket is True
    assert cfg.access_key == "kbkey"


def test_aws_resolve_endpoint_regional_e_nao_cria_bucket(monkeypatch):
    monkeypatch.setenv("Y_PROVIDER", "aws")
    monkeypatch.setenv("Y_REGION", "sa-east-1")
    monkeypatch.setenv("Y_BUCKET", "goga-kb")
    monkeypatch.delenv("Y_ENDPOINT", raising=False)
    monkeypatch.delenv("Y_CREATE_BUCKET", raising=False)
    monkeypatch.delenv("Y_ACCESS_KEY", raising=False)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA_DO_AMBIENTE")
    cfg = s3_config("Y_")
    assert cfg.endpoint == "https://s3.sa-east-1.amazonaws.com"
    assert cfg.addressing == "virtual"
    assert cfg.create_bucket is False
    # Credencial padrao da AWS serve de fallback, para quem ja injeta assim.
    assert cfg.access_key == "AKIA_DO_AMBIENTE"


def test_oci_monta_endpoint_compat_e_usa_path_style(monkeypatch):
    for nome in ("W_ENDPOINT", "W_ADDRESSING", "W_CREATE_BUCKET", "W_ACCESS_KEY"):
        monkeypatch.delenv(nome, raising=False)
    monkeypatch.setenv("W_PROVIDER", "oci")
    monkeypatch.setenv("W_NAMESPACE", "grc4sekoeyuf")
    monkeypatch.setenv("W_REGION", "sa-saopaulo-1")
    cfg = s3_config("W_")
    assert cfg.endpoint == "https://grc4sekoeyuf.compat.objectstorage.sa-saopaulo-1.oraclecloud.com"
    assert cfg.addressing == "path"
    assert cfg.create_bucket is False
    # Nada de credencial de laboratorio caindo num endpoint de nuvem.
    assert cfg.access_key == ""


def test_aws_com_ponto_no_bucket_cai_para_path_style(monkeypatch):
    monkeypatch.setenv("Z_PROVIDER", "aws")
    monkeypatch.setenv("Z_BUCKET", "kb.goga.legal")
    monkeypatch.delenv("Z_ADDRESSING", raising=False)
    assert s3_config("Z_").addressing == "path"


def test_url_virtual_hosted(monkeypatch):
    loja = _loja(monkeypatch, "https://s3.sa-east-1.amazonaws.com", "goga-kb", PROVIDER="aws")
    req = loja._request("GET", "rh/ab/x y.pdf")
    assert req.full_url == "https://goga-kb.s3.sa-east-1.amazonaws.com/rh/ab/x%20y.pdf"
    assert req.get_header("Host") == "goga-kb.s3.sa-east-1.amazonaws.com"


def test_token_de_sessao_e_sse_entram_na_assinatura(monkeypatch):
    loja = _loja(
        monkeypatch,
        "https://s3.sa-east-1.amazonaws.com",
        PROVIDER="aws",
        SESSION_TOKEN="tok",
        SSE="AES256",
    )
    req = loja._request("PUT", "a", b"x", amz_headers={"x-amz-server-side-encryption": "AES256"})
    assinados = req.get_header("Authorization").split("SignedHeaders=")[1].split(",")[0]
    assert "x-amz-security-token" in assinados
    assert "x-amz-server-side-encryption" in assinados


def test_provider_desconhecido_e_recusado(monkeypatch):
    with pytest.raises(storage.StorageError, match="S3_PROVIDER"):
        _loja(monkeypatch, "http://x", PROVIDER="gcs")


# ── contrato contra o servidor falso ───────────────────────────────────────


def test_ida_e_volta_com_tipo_e_nome_acentuado(monkeypatch, s3_falso):
    endpoint, _ = s3_falso
    loja = _loja(monkeypatch, endpoint)
    loja.ensure_bucket()
    chave = "rh/ab/abc/Política de Férias (1).pdf"
    assert loja.put(chave, b"conteudo", "application/pdf") == chave
    assert loja.get_com_tipo(chave) == (b"conteudo", "application/pdf")
    assert loja.tamanho(chave) == 8
    assert loja.tamanho("nao/existe") is None
    loja.delete(chave)
    loja.delete(chave)  # ausente nao e erro
    with pytest.raises(storage.StorageError):
        loja.get(chave)


def test_listagem_segue_o_cursor(monkeypatch, s3_falso):
    endpoint, _ = s3_falso
    loja = _loja(monkeypatch, endpoint)
    loja.ensure_bucket()
    for i in range(5):  # pagina do falso = 2 → tres paginas
        loja.put(f"e/{i}", b"x" * i)
    assert sorted(loja.listar()) == [(f"e/{i}", i) for i in range(5)]
    assert loja.stats()["objects"] == 5


def test_bucket_ausente_sem_permissao_de_criar(monkeypatch, s3_falso):
    endpoint, _ = s3_falso
    loja = _loja(monkeypatch, endpoint, CREATE_BUCKET="false")
    with pytest.raises(storage.StorageError, match="nao existe"):
        loja.ensure_bucket()


# ── migracao ───────────────────────────────────────────────────────────────


def _acervo(tmp_path) -> storage.FsStore:
    origem = storage.FsStore(tmp_path / "origem")
    origem.ensure_bucket()
    origem.put("rh/ab/abc/Politica.pdf", b"%PDF-1.7 ...")
    origem.put("rh/cd/cde/figura-1.png", b"\x89PNG")
    origem.put("juridico/ef/efg/Contrato de Locação.docx", b"PK..")
    return origem


def test_migracao_copia_tudo_e_e_idempotente(monkeypatch, s3_falso, tmp_path):
    endpoint, buckets = s3_falso
    origem = _acervo(tmp_path)
    destino = _loja(monkeypatch, endpoint)
    destino.ensure_bucket()

    primeira = migrar_storage.migrar(origem, destino, saida=lambda *_: None)
    assert (primeira.copiados, primeira.pulados, primeira.falhas) == (3, 0, [])
    assert buckets["acervo"]["rh/ab/abc/Politica.pdf"] == (b"%PDF-1.7 ...", "application/pdf")

    segunda = migrar_storage.migrar(origem, destino, saida=lambda *_: None)
    assert (segunda.copiados, segunda.pulados) == (0, 3)
    assert migrar_storage.verificar(origem, destino, saida=lambda *_: None)


def test_dry_run_nao_grava(monkeypatch, s3_falso, tmp_path):
    endpoint, buckets = s3_falso
    destino = _loja(monkeypatch, endpoint)
    destino.ensure_bucket()
    placar = migrar_storage.migrar(_acervo(tmp_path), destino, dry_run=True, saida=lambda *_: None)
    assert placar.copiados == 3
    assert buckets["acervo"] == {}


def test_verificar_acusa_falta_e_nao_apaga_sobra(monkeypatch, s3_falso, tmp_path):
    endpoint, buckets = s3_falso
    origem = _acervo(tmp_path)
    destino = _loja(monkeypatch, endpoint)
    destino.ensure_bucket()
    destino.put("so/no/destino", b"x")
    assert not migrar_storage.verificar(origem, destino, saida=lambda *_: None)

    migrar_storage.migrar(origem, destino, saida=lambda *_: None)
    assert migrar_storage.verificar(origem, destino, saida=lambda *_: None)
    assert "so/no/destino" in buckets["acervo"]


def test_main_recusa_destino_sem_credencial(monkeypatch, tmp_path):
    for nome in (
        "DEST_S3_ACCESS_KEY",
        "DEST_S3_SECRET_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(nome, raising=False)
    monkeypatch.setenv("DEST_S3_BUCKET", "goga-kb")
    assert migrar_storage.main(["--dry-run"]) == 2
