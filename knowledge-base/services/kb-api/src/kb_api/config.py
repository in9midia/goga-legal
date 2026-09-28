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


S3_PROVIDERS = ("minio", "aws", "oci")


@dataclass(frozen=True)
class S3Config:
    """Um bucket S3 alcancavel: onde fica, como assinar, como enderecar.

    `provider` so escolhe PADROES -- todo campo pode ser sobrescrito. A
    diferenca que importa entre eles:

      minio  endpoint `http://minio:9000`, path-style, cria o bucket na subida,
             credencial de laboratorio como padrao.
      oci    OCI Object Storage pela API compativel: endpoint
             `https://<S3_NAMESPACE>.compat.objectstorage.<regiao>.oraclecloud.com`,
             path-style (o `compat` nao atende virtual-hosted), NAO cria bucket
             (o CreateBucket do compat cai no compartimento padrao do tenancy,
             e bucket e recurso de infra), credencial = Customer Secret Key.
      aws    endpoint regional `https://s3.<regiao>.amazonaws.com`,
             virtual-hosted, NAO cria bucket (em conta real bucket e recurso de
             infra, com politica e criptografia decididas fora daqui), e aceita
             as variaveis padrao da AWS (`AWS_ACCESS_KEY_ID`...) como fallback.
    """

    provider: str
    endpoint: str
    bucket: str
    region: str
    access_key: str
    secret_key: str
    # Credencial temporaria (STS). Vazio = chave estatica de usuario IAM.
    session_token: str
    # `path` (host/bucket/chave) ou `virtual` (bucket.host/chave). Ja resolvido.
    addressing: str
    create_bucket: bool
    # Criptografia do lado do servidor pedida em cada PUT: "", "AES256" ou
    # "aws:kms". Vazio = a padrao do bucket (na AWS, SSE-S3 desde 2023).
    sse: str
    sse_kms_key_id: str


def s3_config(prefixo: str = "S3_", provider_padrao: str = "minio") -> S3Config:
    """Le um `S3Config` das variaveis `<prefixo>*`.

    O `prefixo` existe por causa da migracao: a origem e `S3_*` (o que o pod
    usa hoje) e o destino e `DEST_S3_*`, lidos pela mesma regra.
    """

    def v(nome: str, padrao: str = "") -> str:
        return _env(f"{prefixo}{nome}", padrao)

    provider = v("PROVIDER", provider_padrao).lower()
    aws = provider == "aws"
    oci = provider == "oci"
    # Nuvem de verdade: sem credencial de laboratorio e sem criar bucket.
    nuvem = aws or oci
    region = (
        v("REGION")
        or ((_env("AWS_REGION") or _env("AWS_DEFAULT_REGION")) if aws else "")
        or "us-east-1"
    )
    bucket = v("BUCKET", "knowledge-base-raw")
    if v("ENDPOINT"):
        endpoint = v("ENDPOINT")
    elif aws:
        endpoint = f"https://s3.{region}.amazonaws.com"
    elif oci:
        # Sem namespace nao ha endpoint possivel; o vazio faz a subida falhar
        # com "object store inacessivel" em vez de apontar para outro lugar.
        namespace = v("NAMESPACE")
        endpoint = (
            f"https://{namespace}.compat.objectstorage.{region}.oraclecloud.com"
            if namespace
            else ""
        )
    else:
        endpoint = "http://minio:9000"
    addressing = v("ADDRESSING", "auto").lower()
    if addressing not in ("path", "virtual"):
        # Bucket com ponto no nome quebra o certificado do virtual-hosted
        # (`a.b.s3.amazonaws.com` nao casa com `*.s3.amazonaws.com`), entao
        # esse cai para path-style, que a AWS ainda atende.
        addressing = "virtual" if aws and "." not in bucket else "path"
    return S3Config(
        provider=provider,
        endpoint=endpoint.rstrip("/"),
        bucket=bucket,
        region=region,
        access_key=v("ACCESS_KEY")
        or (_env("AWS_ACCESS_KEY_ID") if aws else "" if oci else "kbkey"),
        secret_key=v("SECRET_KEY")
        or (_env("AWS_SECRET_ACCESS_KEY") if aws else "" if oci else "kbsecret123"),
        session_token=v("SESSION_TOKEN") or (_env("AWS_SESSION_TOKEN") if aws else ""),
        addressing=addressing,
        create_bucket=_env_bool(f"{prefixo}CREATE_BUCKET", not nuvem),
        sse=v("SSE"),
        sse_kms_key_id=v("SSE_KMS_KEY_ID"),
    )


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

    # --- object storage (MinIO, AWS S3 ou qualquer S3-compativel) ---
    # Montado por `s3_config`, que resolve os padroes conforme o provedor. O
    # mesmo leitor serve ao destino da migracao (`DEST_S3_*`), para os dois
    # lados nao divergirem em regra de padrao.
    s3: S3Config = field(default_factory=lambda: s3_config("S3_"))

    # Onde o documento bruto e guardado. Duas implementacoes atras da MESMA
    # interface (`storage.py`):
    #
    #   s3          MinIO, AWS S3 ou OCI Object Storage, por SigV4 (qual deles
    #               e `S3_PROVIDER`). O padrao, e o que roda em producao.
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
    oidc_internal_issuer: str = field(default_factory=lambda: _env("KB_KEYCLOAK_INTERNAL_ISSUER"))
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
    oidc_client_id: str = field(default_factory=lambda: _env("KB_KEYCLOAK_CLIENT_ID", "kb-ui"))
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
    admin_group: str = field(default_factory=lambda: _env("KB_ADMIN_GROUP", "/goga/curadoria"))
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
    personal_token_days: int = field(default_factory=lambda: _env_int("KB_PERSONAL_TOKEN_DAYS", 90))
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
    child_overlap_chars: int = field(
        default_factory=lambda: _env_int("KB_CHILD_OVERLAP_CHARS", 150)
    )
    parent_chunk_chars: int = field(default_factory=lambda: _env_int("KB_PARENT_CHUNK_CHARS", 4800))
    max_upload_mb: int = field(default_factory=lambda: _env_int("KB_MAX_UPLOAD_MB", 1024))

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
    retry_interval_seconds: int = field(default_factory=lambda: _env_int("KB_RETRY_INTERVAL", 300))

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
    max_figures_per_document: int = field(default_factory=lambda: _env_int("KB_MAX_FIGURES", 60))
    max_figure_bytes: int = field(
        default_factory=lambda: _env_int("KB_MAX_FIGURE_BYTES", 6 * 1024 * 1024)
    )
    # Teto do ACUMULADO por documento. As figuras ficam em memoria ate a
    # gravacao, e um PDF de 50 paginas cheio de print de tela ja derrubou o pod
    # por OOM com o limite so por figura.
    max_figures_total_bytes: int = field(
        default_factory=lambda: _env_int("KB_MAX_FIGURES_TOTAL_BYTES", 64 * 1024 * 1024)
    )
    # Paginas por chamada ao docling. Um livro inteiro (800+ paginas) numa
    # chamada so estourou os 8 Gi do pod: o docling segura todas as paginas
    # renderizadas ate o fim da conversao. Em lotes, o pico e o de um lote.
    docling_page_batch: int = field(default_factory=lambda: _env_int("KB_DOCLING_PAGE_BATCH", 40))

    # --- PDF hibrido (hibrido.py) ---
    # O docling leva ~3,7 s por pagina em CPU (medido: 40 paginas em 2,5 min no
    # pod de 3 CPU). Num livro digital de 1.169 paginas isso e mais de uma hora
    # para chegar ao MESMO texto que o PyMuPDF le em 1,1 s. A triagem manda para
    # o docling so as paginas que precisam dele (sem texto, imagem grande,
    # tabela, texto corrompido).
    pdf_hibrido: bool = field(default_factory=lambda: _env_bool("KB_PDF_HIBRIDO", True))
    # Abaixo disto o docling inteiro leva poucos minutos, e o layout dele (titulos
    # e tabelas em Markdown) vale o tempo. 80 paginas ~ 5 min.
    pdf_hibrido_min_paginas: int = field(
        default_factory=lambda: _env_int("KB_PDF_HIBRIDO_MIN_PAGINAS", 80)
    )
    # Se mais que esta fracao das paginas precisa do docling, o PDF e escaneado ou
    # quase todo imagem: a triagem nao ganha nada e o arquivo vai inteiro para ele.
    pdf_hibrido_max_fracao_docling: float = field(
        default_factory=lambda: _env_float("KB_PDF_HIBRIDO_MAX_FRACAO_DOCLING", 0.5)
    )
    # Imagem cobrindo mais que isto da pagina = print, grafico, fluxograma: vale OCR.
    pdf_imagem_area: float = field(default_factory=lambda: _env_float("KB_PDF_IMAGEM_AREA", 0.3))
    # Mais tracos vetoriais que isto na pagina = provavel tabela (as grades sao
    # linhas desenhadas). Pagina de texto corrido tem de 0 a poucos.
    pdf_tabela_desenhos: int = field(default_factory=lambda: _env_int("KB_PDF_TABELA_DESENHOS", 40))

    # --- Documento longo: grafo e wiki alem do comeco (fase 3) ---
    # Teto de chamadas de extracao de grafo por documento. Antes eram 6 pais
    # fixos, o que num livro de 450 pais cobria ~1% (sumario e prefacio). Cada
    # pai e uma chamada ao modelo de chat.
    grafo_max_pais: int = field(default_factory=lambda: _env_int("KB_GRAFO_MAX_PAIS", 40))
    # Teto de destilacoes da wiki por documento longo (uma por secao amostrada).
    # A destilacao e a chamada mais cara do pipeline (ate 8000 tokens de saida).
    wiki_max_secoes: int = field(default_factory=lambda: _env_int("KB_WIKI_MAX_SECOES", 8))

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

    # Nomes antigos, lidos pela tela tecnica e por quem ja escrevia
    # `settings.s3_endpoint`. A fonte e o `s3`.
    @property
    def s3_endpoint(self) -> str:
        return self.s3.endpoint

    @property
    def s3_bucket(self) -> str:
        return self.s3.bucket

    @property
    def s3_region(self) -> str:
        return self.s3.region


settings = Settings()
