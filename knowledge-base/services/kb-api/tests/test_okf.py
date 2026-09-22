"""Open Knowledge Format: reconhecer, tolerar e NAO mudar quem nao pediu.

Tres coisas diferentes sendo travadas aqui, e a terceira e a que mais importa:

1. **reconhecimento.** O que e conceito OKF e o que so parece: `---` no meio do
   texto e regra horizontal em Markdown, nao frontmatter, e frontmatter sem
   `type` nao e conceito;
2. **tolerancia.** A especificacao PROIBE o consumidor de recusar um bundle por
   campo opcional ausente, `type` desconhecido, chave extra ou link quebrado.
   Um parser que valida demais quebra bundles validos;
3. **isolamento.** Com o modo desligado, absolutamente nada muda. Este e o teste
   que impede o OKF de virar uma reindexacao silenciosa em base que nunca o
   pediu;
4. **procedencia.** Conceito escrito ganha do derivado, e conceito derivado
   nunca finge ter sido revisado. Sem isso, um reprocessamento rebaixaria em
   silencio o metadado que alguem escreveu a mao.

A derivacao e testada com o `llm.complete_json` trocado por uma funcao de
mentira. Nao e preguica de integracao: o que precisa de trava aqui e o que este
codigo faz COM a resposta -- validar o tipo contra o vocabulario, marcar a
procedencia, degradar quando nao vem nada. Se a resposta viesse de um modelo de
verdade, o teste mediria o modelo, nao o codigo.
"""

from __future__ import annotations

CONCEITO = """---
type: Metric
title: Usuários ativos mensais
description: Contagem distinta de usuários com ao menos uma sessão no mês.
status: stable
tags: [produto, engajamento]
verified:
  - by: human:diogo
    at: 2026-09-01T10:00:00Z
---

# Usuários ativos mensais

O cálculo roda toda madrugada, sobre a tabela de sessões.

Ver [tabela de sessões](/tables/sessions.md) e o [runbook](./ops/runbook.md).
"""

SEM_FRONTMATTER = """# Política de férias

O pedido vai ao gestor com trinta dias.

---

A regra acima vale para CLT.
"""


# ── reconhecimento ────────────────────────────────────────────────────────


def test_reconhece_conceito():
    from kb_api import okf

    conceito = okf.parse(CONCEITO)
    assert conceito is not None
    assert conceito.type == "Metric"
    assert conceito.title == "Usuários ativos mensais"
    assert conceito.tags == ["produto", "engajamento"]


def test_regra_horizontal_no_meio_do_texto_nao_e_frontmatter():
    """`---` fora do topo e separador de secao, e virou um bug obvio se contar.

    Um documento comum com separador seria lido como conceito OKF, e o corpo
    dele -- tudo que vem antes do separador -- sumiria do indice.
    """
    from kb_api import okf

    assert okf.parse(SEM_FRONTMATTER) is None


def test_frontmatter_sem_type_nao_e_conceito():
    """`type` e o unico campo sempre obrigatorio da especificacao.

    Markdown de gerador estatico (Jekyll, Hugo) comeca com frontmatter e nao e
    OKF. Tratar como se fosse poria `: ` e nomes de chave no cabecalho de cada
    trecho indexado.
    """
    from kb_api import okf

    assert okf.parse("---\ntitle: Post\ndate: 2026-01-01\n---\n\n# Oi\n") is None


def test_yaml_invalido_nao_levanta():
    """Frontmatter quebrado degrada para "nao e OKF", nunca para falha."""
    from kb_api import okf

    assert okf.parse("---\ntype: [nao fecha\n---\n\ncorpo\n") is None


# ── tolerancia exigida pela especificacao ─────────────────────────────────


def test_conceito_so_com_type_e_conformante():
    """A especificacao diz isso com todas as letras."""
    from kb_api import okf

    conceito = okf.parse("---\ntype: Playbook\n---\n\nPasso 1.\n")
    assert conceito is not None
    assert conceito.type == "Playbook"
    assert conceito.title == ""


def test_chave_desconhecida_sobrevive():
    """Nao ha registro de esquema no OKF: o produtor inventa chave, e ela fica.

    Descartar o que nao se entende apagaria justamente o que aquele bundle tem
    de proprio, e a especificacao proibe recusar por isso.
    """
    from kb_api import okf

    conceito = okf.parse("---\ntype: Coisa\ninventado_pelo_produtor: 42\n---\n\nx\n")
    assert conceito is not None
    assert conceito.meta["inventado_pelo_produtor"] == 42


def test_nivel_de_confianca_e_derivado_nao_declarado():
    from kb_api import okf

    assert okf.parse("---\ntype: X\n---\n\n.\n").trust == "unverified"
    assert okf.parse(CONCEITO).trust == "human-reviewed"

    maquina = okf.parse(
        "---\ntype: X\nverified:\n  - by: reference_agent/gemini-2.5-pro\n    at: 2026-01-01\n---\n\n.\n"
    )
    assert maquina.trust == "machine-confirmed"

    # Conceito nao ganha nivel por escrever que tem.
    mentiroso = okf.parse("---\ntype: X\ntrust: human-reviewed\n---\n\n.\n")
    assert mentiroso.trust == "unverified"


# ── links ─────────────────────────────────────────────────────────────────


def test_links_nas_duas_formas_da_especificacao():
    from kb_api import okf

    alvos = okf.link_targets(okf.parse(CONCEITO))
    assert alvos == ["sessions.md", "runbook.md"]


def test_imagem_e_link_externo_nao_sao_aresta():
    from kb_api import okf

    conceito = okf.parse(
        "---\ntype: X\n---\n\n![diagrama](/img/a.png) e [doc](https://ex.com/b.html)\n"
    )
    assert okf.link_targets(conceito) == []


def test_arquivo_reservado_nao_e_conceito():
    """`index.md` e `log.md` tem papel definido: sumario e historico.

    Ingeridos como conceito, virariam o pior tipo de ruido para a busca --
    documento que casa com tudo e nao responde nada.
    """
    from kb_api import okf

    assert okf.is_reserved("index.md")
    assert okf.is_reserved("bundle/log.md")
    assert not okf.is_reserved("metrics/mau.md")


# ── corte ─────────────────────────────────────────────────────────────────


def _cfg(okf_ligado: bool):
    from kb_api.chunking import ChunkConfig

    return ChunkConfig(
        engine="markdown", child_chars=400, child_overlap=40,
        parent_chars=1200, enrichment="conceito" if okf_ligado else "nenhum",
    )


def test_desligado_nao_muda_nada():
    """O teste que impede reindexacao silenciosa.

    Com o modo desligado o comportamento e o de antes, frontmatter incluido: a
    unica forma de mudar o texto indexado de uma base e alguem ligar a chave.
    """
    from kb_api.chunking import plan

    plano = plan(CONCEITO, _cfg(False))
    assert plano.concept is None
    assert not plano.technique.startswith("okf+")
    assert "type: Metric" in plano.parents[0].content


def test_ligado_tira_o_frontmatter_da_prosa():
    from kb_api.chunking import plan

    plano = plan(CONCEITO, _cfg(True))
    assert plano.concept is not None
    assert plano.technique.startswith("okf+")
    texto = "\n".join(p.content for p in plano.parents)
    assert "type: Metric" not in texto
    assert "human:diogo" not in texto
    assert "O cálculo roda toda madrugada" in texto


def test_ligado_poe_a_identidade_do_conceito_em_cada_trecho():
    """O ganho central do modo: filho anonimo nao recupera.

    "o cálculo roda toda madrugada" solto nao fica perto de pergunta nenhuma.
    Com o tipo e o titulo na frente, fica.
    """
    from kb_api.chunking import plan

    plano = plan(CONCEITO, _cfg(True))
    for pai in plano.parents:
        for filho in pai.children:
            assert "Usuários ativos mensais" in filho.content


def test_ligado_preserva_o_offset_no_canonico():
    """O cabecalho entra DEPOIS de localizar; se entrar antes, some a pagina.

    O trecho prefixado nao existe no canonico, entao `_locate` devolveria -1
    para todos e o documento inteiro perderia a pagina de cada evidencia -- sem
    erro nenhum, so evidencia apontando para o arquivo em vez do lugar.
    """
    from kb_api.chunking import plan

    plano = plan(CONCEITO, _cfg(True))
    pedacos = [p for pai in plano.parents for p in (pai, *pai.children)]
    assert pedacos, "o plano nao pode sair vazio"
    assert all(p.start >= 0 for p in pedacos), "trecho nao localizado no canonico"
    # O offset tem de cair DEPOIS do frontmatter, no corpo.
    assert all(p.start >= plano.concept.body_start for p in pedacos)


def test_ligado_em_arquivo_que_nao_e_okf_passa_reto():
    """Base em modo OKF continua recebendo PDF e docx, e sao a maioria."""
    from kb_api.chunking import plan

    ligado = plan(SEM_FRONTMATTER, _cfg(True))
    desligado = plan(SEM_FRONTMATTER, _cfg(False))
    assert ligado.concept is None
    assert ligado.technique == desligado.technique
    assert [p.content for p in ligado.parents] == [p.content for p in desligado.parents]


def test_cabecalho_nao_duplica_titulo_que_ja_abre_o_trecho():
    from kb_api import okf
    from kb_api.chunking import plan

    plano = plan(CONCEITO, _cfg(True))
    cabecalho = okf.header(plano.concept)
    for pai in plano.parents:
        assert pai.content.count(cabecalho) == 1


# ── configuracao ──────────────────────────────────────────────────────────


def test_enriquecimento_e_ortogonal_ao_motor():
    """Sao dois SLOTS em sequencia, nao um enum so.

    O motor preenche o slot de chunking (onde cortar); o enriquecimento preenche
    o seguinte (o que prepender antes do embedding). Se virassem um enum so,
    escolher o cabecalho de conceito significaria abrir mao do corte por
    estrutura -- e as duas coisas se somam.
    """
    from kb_api import chunking

    for variante in chunking.ENRIQUECIMENTOS:
        assert variante not in chunking.MOTORES
    for motor in chunking.MOTORES:
        cfg = chunking.ChunkConfig.from_space({"engine": motor, "enrichment": "conceito"})
        assert cfg.engine == motor
        assert cfg.enrichment == "conceito"


def test_espaco_sem_a_chave_fica_no_padrao():
    """Todo Espaco ja gravado nao tem a chave. Nenhum pode mudar."""
    from kb_api import chunking

    for bruto in ({"engine": "sentence"}, None, {}):
        cfg = chunking.ChunkConfig.from_space(bruto)
        assert cfg.enrichment == chunking.ENRIQUECIMENTO_PADRAO
        assert cfg.okf is False


def test_os_dois_nomes_antigos_continuam_sendo_lidos():
    """A MESMA escolha ja teve tres formatos, e os tres foram para producao.

    `okf: true` (booleano), `mode: okf` (enum de "modo de ingestao") e o atual
    `enrichment: conceito`. Sem estas leituras, um Espaco gravado num formato
    antigo voltaria em silencio ao padrao no deploy, reindexando a base com
    outro texto sem ninguem pedir.
    """
    from kb_api import chunking

    assert chunking.ChunkConfig.from_space({"okf": True}).enrichment == "conceito"
    assert chunking.ChunkConfig.from_space({"mode": "okf"}).enrichment == "conceito"
    assert chunking.ChunkConfig.from_space({"mode": "padrao"}).enrichment == "nenhum"


def test_variante_desconhecida_cai_no_padrao_sem_quebrar():
    """Voltar a uma versao anterior nao pode deixar a base sem ingerir.

    O Espaco gravado com uma variante que aquela versao nao conhece degrada para
    o padrao, com aviso no log -- mesma regra do motor desconhecido.
    """
    from kb_api import chunking

    assert chunking.ChunkConfig.from_space({"enrichment": "xyz"}).enrichment == "nenhum"
    assert chunking.ChunkConfig.from_space({"mode": "wiki"}).enrichment == "nenhum"


def test_o_enriquecimento_viaja_no_to_dict():
    from kb_api import chunking

    cfg = chunking.ChunkConfig.from_space({"enrichment": "conceito"})
    assert cfg.to_dict()["enrichment"] == "conceito"


def test_titulo_nao_e_o_traco_do_frontmatter():
    """Antes disto, todo arquivo com frontmatter era titulado "---" na tela.

    Vale independente do modo OKF: o titulo e exibicao, e mostrar o delimitador
    do YAML nunca foi o comportamento pretendido em lugar nenhum.
    """
    from kb_api.extract import _titulo

    assert _titulo(CONCEITO, "mau.md") == "Usuários ativos mensais"
    # Sem `title` no frontmatter, cai para o primeiro cabecalho do CORPO.
    assert _titulo("---\ntype: X\n---\n\n# Cabeçalho real\n\ntexto\n", "x") == "Cabeçalho real"
    # Frontmatter que nao e OKF tambem para de virar titulo.
    assert _titulo("---\ndate: 2026-01-01\n---\n\n# Post\n", "x") == "Post"


# ── derivacao: o conceito que o arquivo nao traz ──────────────────────────


PDF_CONVERTIDO = """# Política de Contratação e Alçadas

## Alçadas de aprovação

Até R$ 50.000, o gerente da área aprova sozinho.
"""


def _modelo(resposta: dict | None, registro: list | None = None):
    """Troca o `llm.complete_json` por um dublê que devolve o que se pedir."""
    from kb_api import llm

    def falso(instrucao, entrada, operation, max_tokens=600, space=""):
        if registro is not None:
            registro.append(
                {"instrucao": instrucao, "entrada": entrada, "operation": operation, "space": space}
            )
        if resposta is None:
            return None
        return llm.Resposta(dados=resposta, tokens=120, latency_ms=10, model="modelo-de-teste")

    return falso


def test_sem_provedor_de_chat_a_derivacao_devolve_nada(monkeypatch):
    """O caso que NAO pode virar falha de ingestao.

    Documento sem metadado auxiliar continua perfeitamente buscável; documento
    que nao entrou, nao. Esta base ja perdeu quatro arquivos para um provedor de
    IA mal configurado, e a licao vale para o de chat tambem.
    """
    from kb_api import llm, okf

    monkeypatch.setattr(llm, "complete_json", _modelo(None))
    assert okf.derive(PDF_CONVERTIDO, "politica.pdf") is None
    # E o corte segue normalmente sem conceito nenhum.
    from kb_api.chunking import plan

    plano = plan(PDF_CONVERTIDO, _cfg(True))
    assert plano.parents and plano.concept is None


def test_deriva_conceito_de_documento_comum(monkeypatch):
    from kb_api import llm, okf

    monkeypatch.setattr(llm, "complete_json", _modelo({
        "type": "Política",
        "title": "Política de Contratação e Alçadas",
        "description": "Quem aprova contratação por faixa de valor.",
        "tags": ["contratação", "alçada"],
    }))
    conceito = okf.derive(PDF_CONVERTIDO, "politica.pdf")
    assert conceito.type == "Política"
    assert conceito.tags == ["contratação", "alçada"]
    # O corpo inteiro e o corpo: nao ha frontmatter para retirar.
    assert conceito.body == PDF_CONVERTIDO
    assert conceito.body_start == 0


def test_conceito_derivado_nunca_finge_ter_sido_revisado(monkeypatch):
    """`generated` marca a procedencia, e `trust` cai sozinho em `unverified`.

    Sao os campos que a propria especificacao reserva para isso, e nao invencao
    nossa: um bundle exportado daqui continua dizendo a sua procedencia em
    qualquer outro consumidor de OKF.
    """
    from kb_api import llm, okf

    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "Norma", "title": "X"}))
    conceito = okf.derive(PDF_CONVERTIDO, "x.pdf")
    assert conceito.derived is True
    assert conceito.trust == "unverified"
    assert conceito.meta["generated"]["by"] == "kb-api/modelo-de-teste"
    assert okf.parse(CONCEITO).derived is False


def test_tipo_fora_do_vocabulario_cai_no_generico(monkeypatch):
    """O vocabulario existe para a etiqueta AGRUPAR.

    Com tipo livre, 40 documentos rendem 31 tipos quase-duplicados e a etiqueta
    para de servir para qualquer coisa. Ver o generico aparecendo muito e o
    sinal de que aquela base precisa de mais uma entrada na lista.
    """
    from kb_api import llm, okf

    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "Diretriz Interna"}))
    conceito = okf.derive(PDF_CONVERTIDO, "x.pdf", ["Política", "Norma"])
    assert conceito.type == okf.TIPO_GENERICO


def test_tipo_casa_ignorando_caixa(monkeypatch):
    """O modelo devolve "política" onde a lista diz "Política"."""
    from kb_api import llm, okf

    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "  política "}))
    conceito = okf.derive(PDF_CONVERTIDO, "x.pdf", ["Política", "Norma"])
    assert conceito.type == "Política"


def test_o_vocabulario_da_base_vai_no_pedido(monkeypatch):
    from kb_api import llm, okf

    registro: list = []
    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "Contrato"}, registro))
    okf.derive(PDF_CONVERTIDO, "x.pdf", ["Contrato", "Aditivo"])
    assert "Contrato, Aditivo" in registro[0]["entrada"]
    assert registro[0]["operation"] == "okf-derive"


def test_o_espaco_chega_ate_a_chamada_de_chat(monkeypatch):
    """Cada base escolhe o seu modelo de chat, e a derivacao tem de usar o dela.

    Sem o Espaco chegando ate aqui, toda derivacao usaria o padrao da
    instalacao -- e a escolha na tela nao faria nada, em silencio.
    """
    from kb_api import llm, okf

    registro: list = []
    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "Norma"}, registro))
    okf.resolve(PDF_CONVERTIDO, "x.pdf", ["Norma"], "", "juridico")
    assert registro[0]["space"] == "juridico"


def test_documento_gigante_nao_vai_inteiro(monkeypatch):
    """O que diz o que um documento E aparece no comeco dele.

    Mandar um PDF de 121 paginas inteiro multiplicaria o custo por documento sem
    mudar a resposta, e estouraria a janela do modelo pequeno que e justamente o
    que faz sentido usar aqui.
    """
    from kb_api import llm, okf

    registro: list = []
    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "Manual"}, registro))
    okf.derive("# Manual\n\n" + ("texto muito longo. " * 5000), "m.pdf")
    assert len(registro[0]["entrada"]) < 8000


def test_conceito_escrito_ganha_do_derivado(monkeypatch):
    """A regra de procedencia, e a razao dela.

    Reprocessar um bundle escrito a mao NAO pode rebaixar a `unverified` um
    conceito que alguem revisou -- de graca, e ainda pagando uma chamada de IA
    para piorar o dado.
    """
    from kb_api import llm, okf

    registro: list = []
    monkeypatch.setattr(llm, "complete_json", _modelo({"type": "Outro"}, registro))

    escrito = okf.resolve(CONCEITO, "mau.md", ["Outro"])
    assert escrito.type == "Metric"
    assert escrito.trust == "human-reviewed"
    assert registro == [], "nao pode gastar chamada de IA com conceito que ja vem escrito"

    derivado = okf.resolve(PDF_CONVERTIDO, "politica.pdf", ["Outro"])
    assert derivado.type == "Outro"
    assert len(registro) == 1


def test_vocabulario_do_espaco():
    from kb_api import chunking, okf

    assert okf.tipos_do_espaco(None) == list(okf.TIPOS_PADRAO)
    assert okf.tipos_do_espaco({}) == list(okf.TIPOS_PADRAO)
    # Lista vazia significa "use o padrao", nao "nenhum tipo permitido".
    assert okf.tipos_do_espaco({"okf_types": []}) == list(okf.TIPOS_PADRAO)
    assert okf.tipos_do_espaco({"okf_types": ["Contrato", "Aditivo"]}) == ["Contrato", "Aditivo"]
    # E chega resolvido na configuracao, para a tela mostrar o que esta em vigor.
    cfg = chunking.ChunkConfig.from_space({"okf": True, "okf_types": ["Contrato"]})
    assert cfg.okf_types == ["Contrato"]
    assert chunking.ChunkConfig.from_space({"okf": True}).okf_types == list(okf.TIPOS_PADRAO)


def test_derivado_entra_no_corte_igual_ao_escrito(monkeypatch):
    """O ganho de recuperacao vale para PDF tambem, que era o ponto todo."""
    from kb_api import llm, okf
    from kb_api.chunking import plan

    monkeypatch.setattr(llm, "complete_json", _modelo({
        "type": "Política",
        "title": "Contratação e Alçadas",
        "description": "Quem aprova o quê, por faixa de valor.",
    }))
    conceito = okf.resolve(PDF_CONVERTIDO, "politica.pdf", ["Política"])
    plano = plan(PDF_CONVERTIDO, _cfg(True), concept=conceito)

    assert plano.technique.startswith("okf+")
    for pai in plano.parents:
        for filho in pai.children:
            assert "Política: Contratação e Alçadas" in filho.content
    # E o offset continua apontando para o canonico, como no conceito escrito.
    assert all(p.start >= 0 for pai in plano.parents for p in (pai, *pai.children))


def test_o_motor_continua_valendo_no_modo_okf():
    """A pergunta que a tela nao respondia: com OKF o motor ainda e necessario?

    E. O conceito e metadado do DOCUMENTO INTEIRO -- diz o que ele e, nao onde o
    corpo deve ser fatiado, e a especificacao nao limita o tamanho de um
    conceito. Um conceito longo que virasse um trecho so devolveria paginas
    inteiras como "passagem", que e o problema que o pai/filho existe para
    evitar.
    """
    from kb_api import okf
    from kb_api.chunking import ChunkConfig, plan

    longo = "---\ntype: Manual\ntitle: Manual\n---\n\n" + "\n\n".join(
        f"## Secao {i}\n\n" + ("Texto da secao sobre contratacao. " * 40) for i in range(1, 9)
    )
    cfg = ChunkConfig.from_space(
        {"engine": "markdown", "mode": "okf", "child_chars": 1200, "parent_chars": 4800}
    )
    plano = plan(longo, cfg, concept=okf.parse(longo))
    assert len(plano.parents) > 1, "conceito longo tem de virar varios pais"
    assert plano.child_count > len(plano.parents)


def test_conceito_curto_sai_igual_em_qualquer_motor():
    """O outro lado: quando o conceito cabe num trecho, o motor nao muda nada.

    E o que justifica dizer na tela que o PESO da escolha depende do tamanho do
    conceito, em vez de so afirmar que o motor "e necessario".
    """
    from kb_api import okf
    from kb_api.chunking import ChunkConfig, plan

    resultados = set()
    for motor in ("markdown", "sentence", "fixed"):
        cfg = ChunkConfig.from_space(
            {"engine": motor, "mode": "okf", "child_chars": 1200, "parent_chars": 4800}
        )
        plano = plan(CONCEITO, cfg, concept=okf.parse(CONCEITO))
        resultados.add((len(plano.parents), plano.child_count))
    assert resultados == {(1, 1)}
