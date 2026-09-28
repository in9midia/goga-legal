"""Cliente do Google Drive para a sincronizacao de pastas (`sync.py`).

AUTENTICACAO POR CONTA DE SERVICO, e nao por OAuth de usuario

O OAuth de usuario pede um redirect de volta para a API. No k3d local a API vive
em `localhost:8890`, e cada instalacao teria de cadastrar o proprio redirect no
Google Cloud -- alem de o refresh token morrer quando a pessoa troca a senha ou
o app fica em modo de teste (7 dias). A conta de servico nao depende de nada
disso: a pessoa compartilha a pasta com o e-mail dela, como faria com um
colega, e a leitura continua funcionando sem ninguem logado. O escopo e
`drive.readonly`: a sincronizacao nunca escreve no Drive.

SEM O SDK DO GOOGLE

`google-api-python-client` + `google-auth` arrastam uma arvore grande para
dentro da imagem para tres chamadas REST e um JWT. O JWT e assinado com o
`cryptography`, que ja e dependencia (a cifra das credenciais, ADR-0009), e o
HTTP e o `requests`, mesma escolha de `embedding.py`. Mesmo raciocinio do
cliente S3 escrito a mao em `storage.py` (ADR-0008).
"""

from __future__ import annotations

import base64
import json
import threading
import time
from dataclasses import dataclass
from typing import Any

import requests

ESCOPO = "https://www.googleapis.com/auth/drive.readonly"
API = "https://www.googleapis.com/drive/v3"
MIME_PASTA = "application/vnd.google-apps.folder"
# Documento, Planilha e Apresentacao do Google nao tem arquivo: so existem como
# exportacao. Formato Office e nao PDF porque o docling le a estrutura (titulos,
# tabelas) do .docx/.xlsx direto, sem passar pela triagem de pagina do PDF.
EXPORTACOES = {
    "application/vnd.google-apps.document": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
    "application/vnd.google-apps.spreadsheet": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.presentation": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
}
TIMEOUT = 60
CAMPOS_ARQUIVO = "id,name,mimeType,md5Checksum,modifiedTime,size,parents,trashed"


class DriveError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credencial:
    client_email: str
    private_key: str
    token_uri: str
    project_id: str

    @classmethod
    def from_json(cls, texto: str) -> Credencial:
        """Valida a chave JSON da conta de servico, com mensagem que diz o que fazer."""
        try:
            dados = json.loads(texto)
        except (TypeError, ValueError):
            raise DriveError(
                "a credencial precisa ser o arquivo JSON da chave da conta de servico "
                "(Google Cloud > IAM > Contas de servico > Chaves > Adicionar chave > JSON)."
            ) from None
        if not isinstance(dados, dict) or dados.get("type") != "service_account":
            raise DriveError(
                "este JSON nao e de conta de servico (falta `\"type\": \"service_account\"`). "
                "Chave de cliente OAuth nao serve aqui."
            )
        faltando = [c for c in ("client_email", "private_key") if not dados.get(c)]
        if faltando:
            raise DriveError(f"a chave JSON esta incompleta: falta {', '.join(faltando)}.")
        return cls(
            client_email=dados["client_email"],
            private_key=dados["private_key"],
            token_uri=dados.get("token_uri") or "https://oauth2.googleapis.com/token",
            project_id=dados.get("project_id") or "",
        )


def _b64(dados: bytes) -> str:
    return base64.urlsafe_b64encode(dados).rstrip(b"=").decode()


def assinar_jwt(cred: Credencial, agora: int | None = None) -> str:
    """O JWT de concessao da conta de servico (RFC 7523), assinado em RS256."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    agora = int(agora if agora is not None else time.time())
    cabecalho = {"alg": "RS256", "typ": "JWT"}
    corpo = {
        "iss": cred.client_email,
        "scope": ESCOPO,
        "aud": cred.token_uri,
        "iat": agora,
        "exp": agora + 3600,
    }
    entrada = (
        f"{_b64(json.dumps(cabecalho, separators=(',', ':')).encode())}."
        f"{_b64(json.dumps(corpo, separators=(',', ':')).encode())}"
    )
    try:
        chave = serialization.load_pem_private_key(cred.private_key.encode(), password=None)
    except ValueError:
        raise DriveError(
            "a `private_key` da chave JSON nao abre. Ela foi copiada inteira, com as "
            "quebras de linha (\\n)? Gere uma chave nova se estiver em duvida."
        ) from None
    assinatura = chave.sign(entrada.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{entrada}.{_b64(assinatura)}"


# Token por e-mail da conta. Vale uma hora; renovar a cada chamada custaria uma
# ida ao Google por arquivo baixado.
_tokens: dict[str, tuple[str, float]] = {}
_trava = threading.Lock()


def _token(cred: Credencial) -> str:
    with _trava:
        guardado = _tokens.get(cred.client_email)
        if guardado and guardado[1] > time.time() + 60:
            return guardado[0]
    resposta = requests.post(
        cred.token_uri,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assinar_jwt(cred),
        },
        timeout=TIMEOUT,
    )
    if resposta.status_code != 200:
        raise DriveError(
            f"o Google recusou a conta de servico (HTTP {resposta.status_code}): "
            f"{_motivo(resposta)}. A chave pode ter sido revogada; gere outra no Google Cloud."
        )
    dados = resposta.json()
    with _trava:
        _tokens[cred.client_email] = (dados["access_token"], time.time() + int(dados.get("expires_in", 3600)))
    return dados["access_token"]


def _motivo(resposta: requests.Response) -> str:
    try:
        dados = resposta.json()
    except ValueError:
        return resposta.text[:200]
    erro = dados.get("error")
    if isinstance(erro, dict):
        return str(erro.get("message") or erro)[:300]
    return str(dados.get("error_description") or erro or dados)[:300]


def _get(cred: Credencial, caminho: str, params: dict[str, Any], stream: bool = False):
    resposta = requests.get(
        f"{API}{caminho}",
        params=params,
        headers={"Authorization": f"Bearer {_token(cred)}"},
        timeout=TIMEOUT,
        stream=stream,
    )
    if resposta.status_code == 404:
        raise DriveError(
            "nao encontrado no Drive. Confira se a pasta ou o arquivo foi compartilhado com "
            f"{cred.client_email} e se nao foi apagado."
        )
    if resposta.status_code == 403 and "has not been used" in resposta.text:
        raise DriveError(
            "a Google Drive API nao esta ativada no projeto da conta de servico. Ative em "
            "Google Cloud > APIs e servicos > Biblioteca > Google Drive API."
        )
    if resposta.status_code != 200:
        raise DriveError(f"Drive respondeu HTTP {resposta.status_code}: {_motivo(resposta)}")
    return resposta


def _listar(cred: Credencial, q: str, campos: str = CAMPOS_ARQUIVO) -> list[dict[str, Any]]:
    itens: list[dict[str, Any]] = []
    pagina = None
    while True:
        params: dict[str, Any] = {
            "q": q,
            "fields": f"nextPageToken,files({campos})",
            "pageSize": 1000,
            # Sem estes dois, pasta de Drive compartilhado (Shared Drive) volta
            # vazia sem erro nenhum -- e parece pasta sem arquivo.
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
            "orderBy": "folder,name",
        }
        if pagina:
            params["pageToken"] = pagina
        dados = _get(cred, "/files", params).json()
        itens.extend(dados.get("files", []))
        pagina = dados.get("nextPageToken")
        if not pagina:
            return itens


def _escapar(valor: str) -> str:
    return valor.replace("\\", "\\\\").replace("'", "\\'")


def pasta(cred: Credencial, folder_id: str) -> dict[str, Any]:
    """Metadados de uma pasta. Levanta se nao for pasta ou nao estiver ao alcance."""
    dados = _get(cred, f"/files/{folder_id}",
                 {"fields": "id,name,mimeType", "supportsAllDrives": "true"}).json()
    if dados.get("mimeType") != MIME_PASTA:
        raise DriveError(f"\"{dados.get('name')}\" e um arquivo, nao uma pasta.")
    return {"id": dados["id"], "name": dados.get("name", "")}


def subpastas(cred: Credencial, parent: str | None) -> list[dict[str, Any]]:
    """Pastas dentro de `parent`, ou as compartilhadas com a conta quando `None`.

    A conta de servico nao tem "Meu Drive" util: o que ela alcanca e o que foi
    compartilhado com ela, e por isso a raiz do seletor e `sharedWithMe` mais os
    Drives compartilhados de que ela e membro.
    """
    if parent:
        q = f"'{_escapar(parent)}' in parents and mimeType = '{MIME_PASTA}' and trashed = false"
        return [{"id": f["id"], "name": f["name"]} for f in _listar(cred, q, "id,name")]
    q = f"sharedWithMe and mimeType = '{MIME_PASTA}' and trashed = false"
    pastas = [{"id": f["id"], "name": f["name"]} for f in _listar(cred, q, "id,name")]
    drives = _get(cred, "/drives", {"pageSize": 100}).json().get("drives", [])
    return [{"id": d["id"], "name": d["name"], "shared_drive": True} for d in drives] + pastas


def arquivos(cred: Credencial, folder_id: str, recursivo: bool) -> list[dict[str, Any]]:
    """Todos os arquivos da pasta, com `path` relativo a ela.

    Uma listagem por pasta, em largura. Guarda contra ciclo porque no Drive um
    item pode ter mais de um pai (atalho antigo, "adicionar a outra pasta"), e a
    mesma pasta visitada duas vezes duplicaria cada arquivo dela.
    """
    resultado: list[dict[str, Any]] = []
    vistas: set[str] = set()
    fila: list[tuple[str, str]] = [(folder_id, "")]
    while fila:
        atual, prefixo = fila.pop(0)
        if atual in vistas:
            continue
        vistas.add(atual)
        q = f"'{_escapar(atual)}' in parents and trashed = false"
        for item in _listar(cred, q):
            caminho = f"{prefixo}{item['name']}"
            if item["mimeType"] == MIME_PASTA:
                if recursivo:
                    fila.append((item["id"], f"{caminho}/"))
                continue
            if item["mimeType"] == "application/vnd.google-apps.shortcut":
                # Atalho aponta para arquivo de OUTRA pasta, que pode nem estar
                # compartilhada. Seguir faria a base depender de algo fora da
                # pasta escolhida; ignorar e o previsivel.
                continue
            resultado.append({**item, "path": caminho})
    return resultado


def versao(item: dict[str, Any]) -> str:
    """O que muda quando o CONTEUDO muda. md5 no binario, data no nativo do Google."""
    return item.get("md5Checksum") or f"mtime:{item.get('modifiedTime', '')}"


def nome_local(item: dict[str, Any]) -> str:
    """Nome com que o arquivo entra na base. Nativo do Google ganha a extensao exportada."""
    exportacao = EXPORTACOES.get(item["mimeType"])
    if exportacao and not item["name"].lower().endswith(exportacao[1]):
        return item["name"] + exportacao[1]
    return item["name"]


def baixar(cred: Credencial, item: dict[str, Any], limite_bytes: int) -> bytes:
    """O conteudo do arquivo. Nativo do Google sai exportado em formato Office.

    A exportacao recusa documento acima de 10 MB (`exportSizeLimitExceeded`).
    Nao ha contorno do lado de ca: o item fica como erro, com a mensagem do
    Google, e a pessoa decide se divide o documento.
    """
    exportacao = EXPORTACOES.get(item["mimeType"])
    if exportacao:
        resposta = _get(cred, f"/files/{item['id']}/export", {"mimeType": exportacao[0]},
                        stream=True)
    elif item["mimeType"].startswith("application/vnd.google-apps."):
        raise DriveError(f"tipo nativo do Google sem exportacao suportada ({item['mimeType']}).")
    else:
        resposta = _get(cred, f"/files/{item['id']}",
                        {"alt": "media", "supportsAllDrives": "true"}, stream=True)
    partes: list[bytes] = []
    total = 0
    # Le em pedacos e para no limite: um PDF de 2 GB esquecido na pasta nao
    # pode ser carregado inteiro na memoria do pod so para ser recusado depois.
    for pedaco in resposta.iter_content(1024 * 1024):
        total += len(pedaco)
        if total > limite_bytes:
            resposta.close()
            raise DriveError(
                f"arquivo passa do limite de {limite_bytes // 1048576} MB (KB_MAX_UPLOAD_MB)"
            )
        partes.append(pedaco)
    return b"".join(partes)
