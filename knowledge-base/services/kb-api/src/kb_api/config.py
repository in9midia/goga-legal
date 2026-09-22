"""Configuracao por variavel de ambiente.

Regra herdada do agentic-sdlc: nada de host, segredo, path ou credencial no
codigo. Todo valor vem do ambiente, com default so quando o default e seguro
para o ambiente local.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _env_list(name: str) -> list[str]:
    return [part.strip() for part in _env(name).split(",") if part.strip()]


@dataclass(frozen=True)
class Settings:
    env: str = field(default_factory=lambda: _env("KB_ENV", "k8s-local"))
    log_level: str = field(default_factory=lambda: _env("KB_LOG_LEVEL", "INFO"))

    # --- Postgres (pgvector) ---
    pg_host: str = field(default_factory=lambda: _env("POSTGRES_HOST", "postgres"))
    pg_port: int = field(default_factory=lambda: _env_int("POSTGRES_PORT", 5432))
    pg_db: str = field(default_factory=lambda: _env("POSTGRES_DB", "knowledge_base"))
    pg_user: str = field(default_factory=lambda: _env("POSTGRES_USER", "knowledge_base"))
    pg_password: str = field(default_factory=lambda: _env("POSTGRES_PASSWORD", "knowledge_base"))
    # `prefer` mantem o local (Postgres em pod, sem TLS) funcionando sem
    # configuracao: tenta cifrado e aceita texto puro. O Postgres GERENCIADO da
    # OCI recusa conexao nao cifrada, entao la o valor precisa ser `require` --
    # sem isto a conexao falha no boot com "server does not support SSL" ou o
    # servidor derruba o handshake, e o sintoma nao diz que faltou uma flag.
    pg_sslmode: str = field(default_factory=lambda: _env("POSTGRES_SSLMODE", "prefer"))

    # --- Migracoes de esquema ---
    # Estrito = recusa subir se uma migracao JA APLICADA foi editada depois.
    # Desligado por padrao porque em desenvolvimento a divergencia costuma ser
    # um `git pull` trazendo a correcao de outra pessoa, e derrubar o pod por
    # isso atrapalha mais do que protege. Em producao vale ligar: la a
    # divergencia significa que o banco nao e o que o codigo pensa que e.
    migrations_strict: bool = field(
        default_factory=lambda: _env_bool("KB_MIGRATIONS_STRICT", False)
    )
    # Quanto esperar pelo advisory lock quando outra replica esta migrando.
    # Precisa cobrir a migracao mais lenta do repositorio, nao o tempo de subida
    # do pod: quem espera aqui esta certo, e desistir cedo so troca a espera por
    # um CrashLoopBackOff.
    migrations_lock_seconds: int = field(
        default_factory=lambda: _env_int("KB_MIGRATIONS_LOCK_SECONDS", 300)
    )

    # --- MinIO / object storage ---
    s3_endpoint: str = field(default_factory=lambda: _env("S3_ENDPOINT", "http://minio:9000"))
    s3_bucket: str = field(default_factory=lambda: _env("S3_BUCKET", "knowledge-base-raw"))
    s3_access_key: str = field(default_factory=lambda: _env("S3_ACCESS_KEY", "kbkey"))
    s3_secret_key: str = field(default_factory=lambda: _env("S3_SECRET_KEY", "kbsecret123"))
    # Regiao do escopo da assinatura SigV4. O MinIO local nao confere; o OCI
    # Object Storage sim (`sa-saopaulo-1`), e erra com 403 SignatureDoesNotMatch.
    s3_region: str = field(default_factory=lambda: _env("S3_REGION", "us-east-1"))

    # Onde o documento bruto e guardado. Duas implementacoes atras da MESMA
    # interface (`storage.py`):
    #
    #   s3          MinIO ou OCI Object Storage, por SigV4. O padrao, e o que
    #               roda em producao.
    #   filesystem  um diretorio em disco, normalmente um PVC. Existe para o
    #               ambiente subir SEM depender de credencial de object storage
    #               -- em DEV a Customer Secret Key da OCI e um pedido a infra,
    #               e esperar por ela travava o ambiente inteiro.
    #
    # A troca e so de configuracao: nenhuma linha de chamada muda.
    storage_backend: str = field(
        default_factory=lambda: _env("KB_STORAGE_BACKEND", "s3").strip().lower()
    )
    # Raiz do backend `filesystem`. Ignorada pelo `s3`.
    storage_dir: str = field(default_factory=lambda: _env("KB_STORAGE_DIR", "/data/objects"))

    # --- Memgraph ---
    graph_host: str = field(default_factory=lambda: _env("MEMGRAPH_HOST", "memgraph"))
    graph_port: int = field(default_factory=lambda: _env_int("MEMGRAPH_PORT", 7687))
    graph_enabled: bool = field(default_factory=lambda: _env_bool("MEMGRAPH_ENABLED", True))

    # --- Keycloak / OIDC ---
    # Vazio = auth desligada (dev offline), igual ao agentic-sdlc. Com issuer, o
    # JWT passa a ser obrigatorio e os Espacos permitidos vem dos claims.
    oidc_issuer: str = field(default_factory=lambda: _env("KB_KEYCLOAK_ISSUER"))
    # Onde BUSCAR a JWKS, quando nao e o mesmo endereco do issuer.
    #
    # Isso existe porque o navegador e o kb-api alcancam o Keycloak por
    # caminhos diferentes: o operador loga por http://localhost:8890/auth (o
    # ingress), e e esse endereco que o Keycloak carimba no claim `iss`; o
    # kb-api vive dentro do cluster, onde localhost:8890 e ele mesmo. Sem
    # separar as duas coisas, ou o navegador nao consegue logar ou o kb-api nao
    # consegue validar a assinatura -- nunca os dois.
    oidc_internal_issuer: str = field(
        default_factory=lambda: _env("KB_KEYCLOAK_INTERNAL_ISSUER")
    )
    oidc_audience: str = field(default_factory=lambda: _env("KB_KEYCLOAK_AUDIENCE"))
    # Client do Identity usado pelo kb-api para FEDERAR o login do conector MCP.
    # E o mesmo client publico da interface: publico + PKCE, sem segredo para
    # guardar e sem client novo para pedir no realm.
    #
    # O realm `goga-interno` tambem tem um client `kb-mcp`, com device flow, e
    # NAO e esse. O kb-api faz authorization code com redirect para o proprio
    # `/oauth/callback` (ADR-0007), e quem tem essa redirect_uri liberada e o
    # `kb-ui`. Trocar por `kb-mcp` devolve `invalid_redirect_uri` so no fim do
    # fluxo, depois do login ja feito.
    oidc_client_id: str = field(
        default_factory=lambda: _env("KB_KEYCLOAK_CLIENT_ID", "kb-ui")
    )
    # Endereco publico deste servico, do ponto de vista de quem conecta. E o que
    # entra nos metadados OAuth e no redirect do login -- e o servidor nao tem
    # como adivinha-lo atras de ingress e de tunel.
    public_base_url: str = field(default_factory=lambda: _env("KB_PUBLIC_BASE_URL"))
    # Origens liberadas no CORS. Vazio no cluster (UI e API no mesmo host, pelo
    # nginx do kb-ui); preenchido so para o dev-server do Vite.
    cors_origins: list[str] = field(default_factory=lambda: _env_list("KB_CORS_ORIGINS"))
    # Grupo que da acesso a todos os Espacos, no formato do claim `groups`.
    #
    # E a curadoria juridica, nao o ops: o repertorio e o conteudo da KB, e
    # quem o ingere e corrige e quem precisa alcancar tudo. O `/goga/ops` opera
    # a Camada B do Goga, que nao e esta base -- dar admin a ele seria acumular
    # por padrao exatamente o que a separacao em quatro grupos evita (ADR-0023).
    admin_group: str = field(
        default_factory=lambda: _env("KB_ADMIN_GROUP", "/goga/curadoria")
    )
    # Role que tambem da acesso total. Vazia por padrao de proposito: a role de
    # administracao do Keycloak nao deve implicar acesso ao conteudo da base.
    admin_role: str = field(default_factory=lambda: _env("KB_ADMIN_ROLE"))
    # Token estatico de servico: usado pelos harnesses de IA quando nao ha um
    # usuario interativo para fazer o fluxo OIDC. Escopo dele e o dos grupos
    # declarados em KB_SERVICE_TOKEN_GROUPS.
    service_token: str = field(default_factory=lambda: _env("KB_SERVICE_TOKEN"))
    # Validade do token pessoal emitido pela tela "Conectar MCP". 90 dias e o
    # mesmo default do agentic-sdlc: longo o bastante para nao virar incomodo
    # semanal, curto o bastante para a fotografia de grupos nao envelhecer
    # indefinidamente.
    personal_token_days: int = field(
        default_factory=lambda: _env_int("KB_PERSONAL_TOKEN_DAYS", 90)
    )
    service_token_groups: list[str] = field(
        default_factory=lambda: _env_list("KB_SERVICE_TOKEN_GROUPS")
    )

    # --- Modelos de IA ---
    #
    # NAO ha mais endpoint nem chave aqui. O provedor (Azure OpenAI, OpenAI,
    # Azure AI Foundry) e uma linha da tabela `ai_provider`, editavel na tela
    # Administracao > Modelos de IA -- ver `providers.py`. Trocar de modelo
    # deixou de exigir PR de infraestrutura e deploy.
    #
    # Sobrou UMA variavel, e ela nao e credencial de provedor: e a chave que
    # CIFRA as credenciais em repouso. Ter isto no ambiente e o que impede um
    # dump do banco de virar credencial utilizavel.
    secret_key: str = field(default_factory=lambda: _env("KB_SECRET_KEY"))

    # Dimensao do vetor. Continua no ambiente de proposito: ela esta no DDL da
    # coluna `chunk_embedding.embedding vector(N)`, entao mudar aqui sem migrar
    # a tabela quebra a gravacao. A API recusa tornar padrao um provedor cuja
    # dimensao divirja deste numero.
    embedding_dim: int = field(default_factory=lambda: _env_int("KB_EMBEDDING_DIM", 3072))

    # --- Pipeline ---
    # Pai/filho: busca no filho, entrega do pai (ING-07). Os tamanhos sao em
    # caracteres, nao tokens: e uma aproximacao deliberada, barata e estavel.
    child_chunk_chars: int = field(default_factory=lambda: _env_int("KB_CHILD_CHUNK_CHARS", 1200))
    child_overlap_chars: int = field(default_factory=lambda: _env_int("KB_CHILD_OVERLAP_CHARS", 150))
    parent_chunk_chars: int = field(default_factory=lambda: _env_int("KB_PARENT_CHUNK_CHARS", 4800))
    max_upload_mb: int = field(default_factory=lambda: _env_int("KB_MAX_UPLOAD_MB", 100))

    # ── retentativa automatica da ingestao ──
    #
    # Ligada por padrao: documento que falhou por 429 do provedor e problema que
    # o sistema resolve sozinho, e deixar isso para uma pessoa notar num log de
    # trezentas linhas nao e uma escolha de produto, e um esquecimento.
    #
    # Cinco minutos e a ordem de grandeza do que se quer esperar: menor que isso
    # bate de novo no provedor que acabou de recusar, e maior demora para
    # recuperar uma carga que falhou em bloco.
    retry_enabled: bool = field(default_factory=lambda: _env_bool("KB_RETRY", True))
    retry_interval_seconds: int = field(
        default_factory=lambda: _env_int("KB_RETRY_INTERVAL", 300)
    )

    # Catalogo de preco de modelo. E a tabela que o LiteLLM mantem e que o
    # ecossistema inteiro usa; o agentic-sdlc le a mesma.
    #
    # Configuravel porque nem toda instalacao alcanca a internet. Em cluster com
    # egress fechado, um gateway LiteLLM cadastrado aqui serve de fonte pela
    # rota `/public/litellm_model_cost_map`, que e interna e sem credencial.
    # Vazio desliga a busca: a tela passa a so aceitar preco digitado.
    price_catalog_url: str = field(
        default_factory=lambda: _env(
            "KB_PRICE_CATALOG_URL",
            "https://raw.githubusercontent.com/BerriAI/litellm/main/"
            "model_prices_and_context_window.json",
        )
    )

    # Endereco da API do agente ngrok, quando o tunel esta de pe. Vazio =
    # sem tunel, e a tela de conexao oferece so a URL local.
    ngrok_api: str = field(default_factory=lambda: _env("KB_NGROK_API", "http://ngrok:4040"))

    # --- OCR e figuras ---
    # OCR LIGADO por padrao, mas sem forcar pagina inteira: o docling so chama o
    # motor onde nao existe camada de texto. PDF digital continua rapido; print
    # de tela e pagina digitalizada param de ser conteudo invisivel.
    ocr_enabled: bool = field(default_factory=lambda: _env_bool("KB_OCR", True))
    # Forcar OCR em toda pagina IGNORA a camada de texto existente. So faz
    # sentido para base inteiramente digitalizada, e custa minutos por documento.
    ocr_force_full_page: bool = field(
        default_factory=lambda: _env_bool("KB_OCR_FORCE_FULL_PAGE", False)
    )
    ocr_languages: list[str] = field(
        default_factory=lambda: _env_list("KB_OCR_LANGUAGES") or ["por", "eng"]
    )
    ocr_timeout_seconds: int = field(default_factory=lambda: _env_int("KB_OCR_TIMEOUT", 120))
    # Modo de segmentacao do tesseract. 3 = automatico sem deteccao de
    # orientacao; o default do docling tenta OSD e falha em toda regiao curta.
    ocr_psm: int = field(default_factory=lambda: _env_int("KB_OCR_PSM", 3))
    figures_enabled: bool = field(default_factory=lambda: _env_bool("KB_FIGURES", True))
    # Escala da imagem gerada para a figura. Acima de 1 o OCR le print de tela de
    # forma confiavel; 2 e o ponto de equilibrio com o tamanho do PNG.
    figure_scale: float = field(default_factory=lambda: _env_float("KB_FIGURE_SCALE", 2.0))
    max_figures_per_document: int = field(
        default_factory=lambda: _env_int("KB_MAX_FIGURES", 60)
    )
    max_figure_bytes: int = field(
        default_factory=lambda: _env_int("KB_MAX_FIGURE_BYTES", 6 * 1024 * 1024)
    )
    # Teto do ACUMULADO por documento. As figuras ficam em memoria ate a
    # gravacao, e um PDF de 50 paginas cheio de print de tela ja derrubou o pod
    # por OOM com o limite so por figura.
    max_figures_total_bytes: int = field(
        default_factory=lambda: _env_int("KB_MAX_FIGURES_TOTAL_BYTES", 64 * 1024 * 1024)
    )

    # --- Busca ---
    default_top_k: int = field(default_factory=lambda: _env_int("KB_DEFAULT_TOP_K", 10))
    candidate_pool: int = field(default_factory=lambda: _env_int("KB_CANDIDATE_POOL", 40))
    # Constante do Reciprocal Rank Fusion (BUS-05). 60 e o valor do artigo
    # original e o default de praticamente toda implementacao.
    rrf_k: int = field(default_factory=lambda: _env_int("KB_RRF_K", 60))

    @property
    def pg_dsn(self) -> str:
        return (
            f"host={self.pg_host} port={self.pg_port} dbname={self.pg_db} "
            f"user={self.pg_user} password={self.pg_password} "
            f"sslmode={self.pg_sslmode}"
        )

    @property
    def auth_enabled(self) -> bool:
        return bool(self.oidc_issuer)

    @property
    def oidc_discovery_base(self) -> str:
        """Base da descoberta OIDC/JWKS: o endereco interno, quando houver."""
        return (self.oidc_internal_issuer or self.oidc_issuer).rstrip("/")


settings = Settings()
