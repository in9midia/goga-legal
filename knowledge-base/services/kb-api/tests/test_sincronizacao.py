"""Sincronizacao de pastas do Google Drive: o que da para travar sem rede.

O que estes testes protegem:

1. que a chave da conta de servico seja validada NO CADASTRO, com mensagem que
   diz o que fazer, e que o JWT saia assinado de um jeito que o Google aceita;
2. que a listagem recursiva nao duplique arquivo de pasta com dois pais, e
   ignore atalho;
3. que manual e sincronizado nunca se misturem no versionamento e na
   deduplicacao (`escopo_da_origem`) -- a promessa de que a sincronizacao nao
   toca em upload manual depende disto.

A rodada contra o Drive e o Postgres de verdade nao tem teste automatico; ver
`docs/testes.md`.
"""

from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from kb_api import gdrive, ingest, sync


@pytest.fixture(scope="module")
def chave_privada():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def chave_json(chave_privada):
    pem = chave_privada.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return json.dumps({
        "type": "service_account",
        "project_id": "goga",
        "client_email": "kb-sync@goga.iam.gserviceaccount.com",
        "private_key": pem,
        "token_uri": "https://oauth2.googleapis.com/token",
    })


def _decodificar(parte: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(parte + "=" * (-len(parte) % 4)))


def test_jwt_assinado_e_verificavel(chave_json, chave_privada):
    cred = gdrive.Credencial.from_json(chave_json)
    jwt = gdrive.assinar_jwt(cred, agora=1_000)
    cabecalho, corpo, assinatura = jwt.split(".")
    assert _decodificar(cabecalho) == {"alg": "RS256", "typ": "JWT"}
    claims = _decodificar(corpo)
    assert claims["iss"] == "kb-sync@goga.iam.gserviceaccount.com"
    # Somente leitura: a sincronizacao nunca escreve no Drive.
    assert claims["scope"].endswith("/drive.readonly")
    assert claims["exp"] - claims["iat"] == 3600
    chave_privada.public_key().verify(
        base64.urlsafe_b64decode(assinatura + "=" * (-len(assinatura) % 4)),
        f"{cabecalho}.{corpo}".encode(),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )


@pytest.mark.parametrize(
    ("texto", "trecho"),
    [
        ("nao e json", "arquivo JSON da chave"),
        (json.dumps({"type": "authorized_user"}), "nao e de conta de servico"),
        (json.dumps({"type": "service_account", "client_email": "x@y"}), "private_key"),
    ],
)
def test_chave_invalida_diz_o_que_fazer(texto, trecho):
    with pytest.raises(gdrive.DriveError, match=trecho):
        gdrive.Credencial.from_json(texto)


def test_private_key_corrompida_falha_no_cadastro(chave_json):
    dados = json.loads(chave_json)
    dados["private_key"] = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"
    cred = gdrive.Credencial.from_json(json.dumps(dados))
    with pytest.raises(gdrive.DriveError, match="nao abre"):
        gdrive.assinar_jwt(cred)


def test_nativo_do_google_ganha_extensao_exportada():
    doc = {"name": "Contrato padrao", "mimeType": "application/vnd.google-apps.document"}
    planilha = {"name": "Prazos.xlsx", "mimeType": "application/vnd.google-apps.spreadsheet"}
    pdf = {"name": "ata.pdf", "mimeType": "application/pdf"}
    assert gdrive.nome_local(doc) == "Contrato padrao.docx"
    assert gdrive.nome_local(planilha) == "Prazos.xlsx"
    assert gdrive.nome_local(pdf) == "ata.pdf"


def test_versao_usa_md5_e_cai_para_data_no_nativo():
    assert gdrive.versao({"md5Checksum": "abc", "modifiedTime": "t"}) == "abc"
    assert gdrive.versao({"modifiedTime": "2026-09-24T10:00:00Z"}) == "mtime:2026-09-24T10:00:00Z"


def test_listagem_recursiva_sem_duplicar_e_sem_atalho(monkeypatch):
    pasta = gdrive.MIME_PASTA
    arvore = {
        "raiz": [
            {"id": "a", "name": "a.pdf", "mimeType": "application/pdf"},
            {"id": "sub", "name": "Sub", "mimeType": pasta},
            # A MESMA subpasta de novo: item com dois pais no Drive.
            {"id": "sub", "name": "Sub", "mimeType": pasta},
            {"id": "at", "name": "atalho", "mimeType": "application/vnd.google-apps.shortcut"},
        ],
        "sub": [{"id": "b", "name": "b.docx", "mimeType": "application/msword"}],
    }

    def listar(_cred, q, campos=gdrive.CAMPOS_ARQUIVO):
        return arvore[q.split("'")[1]]

    monkeypatch.setattr(gdrive, "_listar", listar)
    recursivo = gdrive.arquivos(None, "raiz", recursivo=True)
    assert [(i["id"], i["path"]) for i in recursivo] == [("a", "a.pdf"), ("b", "Sub/b.docx")]
    raso = gdrive.arquivos(None, "raiz", recursivo=False)
    assert [i["id"] for i in raso] == ["a"]


@pytest.mark.parametrize(
    ("valor", "esperado"),
    [
        ("https://drive.google.com/drive/folders/1AbC_def-GHIjkl?usp=sharing", "1AbC_def-GHIjkl"),
        ("https://drive.google.com/drive/u/0/folders/0B7xyzXYZ12345", "0B7xyzXYZ12345"),
        ("1AbC_def-GHIjkl", "1AbC_def-GHIjkl"),
    ],
)
def test_id_da_pasta_aceita_link_ou_id(valor, esperado):
    assert sync.id_da_pasta(valor) == esperado


def test_id_da_pasta_recusa_lixo():
    with pytest.raises(sync.SyncError):
        sync.id_da_pasta("minha pasta")


def test_intervalo_tem_faixa():
    assert sync._intervalo("15") == 15
    for ruim in (1, 99999, "x"):
        with pytest.raises(sync.SyncError):
            sync._intervalo(ruim)


def test_manual_e_sincronizado_nao_se_misturam():
    manual, params = ingest.escopo_da_origem(None)
    assert manual == "sync_id IS NULL" and params == ()
    drive, params = ingest.escopo_da_origem(ingest.Origem(7, "fileX"), alias="d")
    assert drive == "d.sync_id = %s AND d.source_ref = %s"
    assert params == (7, "fileX")


def test_formatos_fora_do_extrator_ficam_de_fora():
    assert sync._suportado("Contrato.docx")
    assert sync._suportado("ata.PDF")
    assert not sync._suportado("foto.heic")
    assert not sync._suportado("sem-extensao")
