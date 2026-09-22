"""O repertorio versionado em `content/` confere com o que o plano fixou.

POR QUE ISTO E TESTE, E NAO REVISAO DE PULL REQUEST

Tres propriedades deste conteudo nao sobrevivem a leitura humana repetida:

1. **"nenhum agente e irrestrito"** (§2.2 do plano). Com 39 identidades e 17
   Espacos, um grant a mais num arquivo de 500 linhas passa em qualquer review --
   e o efeito dele e um especialista de aereo lendo repertorio bancario, que nao
   quebra nada e nao aparece em lugar nenhum;
2. **o nivel de confianca do seed**. Ele e DERIVADO do frontmatter (ADR-0015 e
   ADR-0025), entao um `verified` escrito no lugar errado num dos 67 arquivos
   promove conteudo em verificacao a conteudo consultavel, em silencio. A
   auditoria diz que citacao em verificacao "nao pode ser usada por nenhum agente
   em parecer ou peca" -- esta e a unica trava automatica que existe hoje sobre
   essa regra;
3. **as duas vozes do conjunto de avaliacao**. Metade e metade e uma afirmacao do
   §9 do plano; uma pergunta trocada de grupo desbalanceia a comparacao sem
   nenhum sintoma, e a medicao passa a comparar conjuntos de tamanhos diferentes.

Nada aqui toca Postgres: e tudo arquivo e `okf.parse`.
"""

from __future__ import annotations

import pathlib

import pytest
import yaml

from kb_api import benchmark, chunking, okf

CONTENT = pathlib.Path(__file__).resolve().parents[3] / "content"
SPACES_YAML = CONTENT / "spaces.yaml"
SEED = CONTENT / "auditoria-citacoes"
EVAL = CONTENT / "evaluation"

# Os 17 slugs da §2.1, na ordem da tabela. Repetidos aqui de proposito: se o
# teste lesse a lista do proprio arquivo que testa, ele nao testaria nada.
SLUGS_DO_PLANO = {
    "cdc", "bancario", "aereo", "saude-suplementar", "imobiliario",
    "civil-contratos", "processual-civil", "calculo-monetario", "trabalhista",
    "previdenciario", "tributario-pf", "seguros", "lgpd-digital", "condominial",
    "fazenda-publica", "etica-regulatorio", "estilo-peca",
}

# Os 5 do `planning/00-MVP-PLANO.md` §5.4 item 2. Conjunto separado, e nao
# somado ao de cima, para que a origem de cada slug continue legivel: os 17
# vem da §2.1, estes vem do plano do MVP, e misturar esconderia qual documento
# autoriza qual Espaco.
SLUGS_DO_MVP = {
    "telecom-essenciais", "transito-veiculos", "educacao", "extrajudicial",
    "encaminhamento",
}
TODOS_OS_SLUGS = SLUGS_DO_PLANO | SLUGS_DO_MVP

# §10 do plano. A onda 1 e pre-requisito de tudo, e e a unica que tem conjunto
# de avaliacao nesta entrega.
ONDA_1 = {"cdc", "bancario", "calculo-monetario", "etica-regulatorio", "estilo-peca"}


@pytest.fixture(scope="module")
def config() -> dict:
    with SPACES_YAML.open(encoding="utf-8") as arquivo:
        return yaml.safe_load(arquivo)


# ── os Espacos ─────────────────────────────────────────────────────────────


def test_os_dezessete_espacos_da_secao_2_1_e_os_cinco_do_mvp(config):
    assert {e["slug"] for e in config["spaces"]} == TODOS_OS_SLUGS


def test_onda_1_e_a_do_plano(config):
    onda_1 = {e["slug"] for e in config["spaces"] if e.get("onda") == 1}
    assert onda_1 == ONDA_1


def test_motor_de_corte_e_enriquecimento_sao_aceitos_pela_api(config):
    """O arquivo nao pode descrever configuracao que a rota recusaria.

    Sem isto, o erro aparece na metade de uma rodada de aplicacao, com parte dos
    Espacos criados e parte nao -- que e o estado mais caro de consertar.
    """
    padrao = config["defaults"]["chunking"]
    for espaco in config["spaces"]:
        corte = {**padrao, **(espaco.get("chunking") or {})}
        assert corte["engine"] in chunking.MOTORES, espaco["slug"]
        assert corte["enrichment"] in chunking.ENRIQUECIMENTOS, espaco["slug"]
        # A rota recusa mais de 20 tipos: o vocabulario inteiro viaja no pedido
        # de cada documento.
        assert len(corte["okf_types"]) <= 20, espaco["slug"]


def test_wiki_ligada_so_nos_espacos_de_merito_que_a_secao_6_nomeia(config):
    ligada = {e["slug"] for e in config["spaces"] if e.get("wiki")}
    assert ligada == {"cdc", "bancario", "aereo", "saude-suplementar",
                      "imobiliario", "fazenda-publica"}


# ── os grants ──────────────────────────────────────────────────────────────


def test_nenhum_agente_e_irrestrito(config):
    for agente in config["agents"]:
        alcance = set(agente.get("spaces") or [])
        assert alcance != TODOS_OS_SLUGS, agente["group"]
        assert not SLUGS_DO_PLANO <= alcance, agente["group"]


def test_o_orquestrador_nao_tem_grant_nenhum(config):
    orquestrador = next(a for a in config["agents"] if a["runtime"] == "orquestrador")
    assert not orquestrador["spaces"]


def test_todo_agente_aponta_para_espaco_que_existe(config):
    for agente in config["agents"]:
        for slug in agente.get("spaces") or []:
            assert slug in TODOS_OS_SLUGS, f"{agente['group']} -> {slug}"


def test_todo_agente_sem_grant_diz_por_que(config):
    """Espaco vazio tem de ser escolha registrada, nao linha pela metade."""
    for agente in config["agents"]:
        if not agente.get("spaces"):
            assert agente.get("motivo"), agente["group"]


def test_cada_identidade_de_agente_tem_grupo_proprio(config):
    grupos = [a["group"] for a in config["agents"]]
    assert len(grupos) == len(set(grupos))


def test_curadoria_escreve_e_responsavel_tecnico_le(config):
    por_grupo = {g["group"]: g for g in config["groups"]}
    assert por_grupo["/goga/curadoria"]["role"] == "editor"
    assert por_grupo["/goga/responsavel-tecnico"]["role"] == "reader"
    for grupo in por_grupo.values():
        assert grupo["spaces"] == "todos"


# ── o seed da auditoria ────────────────────────────────────────────────────


def conceitos() -> list[tuple[pathlib.Path, okf.Concept]]:
    saida = []
    for arquivo in sorted(SEED.rglob("*.md")):
        conceito = okf.parse(arquivo.read_text(encoding="utf-8"))
        assert conceito is not None, arquivo
        saida.append((arquivo, conceito))
    return saida


def test_todo_arquivo_do_seed_e_conceito_okf_valido():
    for arquivo, conceito in conceitos():
        assert conceito.type in ("Norma", "Precedente", "Tese"), arquivo
        assert conceito.title, arquivo
        assert conceito.auditoria.get("status"), arquivo
        assert conceito.auditoria.get("fonte"), arquivo


def test_o_seed_mora_em_espaco_declarado():
    for arquivo, _ in conceitos():
        assert arquivo.parent.name in SLUGS_DO_PLANO, arquivo


def test_item_em_verificacao_nao_alcanca_parecer_nem_peca():
    """A trava da §5 do documento de auditoria, conferida no nivel derivado.

    `em-verificacao` REBAIXA a `unverified` mesmo com `verified` assinado
    (ADR-0026), e `unverified` nao passa por nenhum `min_trust`. Se um destes
    arquivos subisse de nivel, a citacao nao confirmada entraria em peca sem
    nada falhar.
    """
    em_verificacao = [
        (a, c) for a, c in conceitos()
        if c.auditoria.get("status") == okf.EM_VERIFICACAO
    ]
    assert len(em_verificacao) == 9
    for arquivo, conceito in em_verificacao:
        assert conceito.trust == "unverified", arquivo
        # O nivel sozinho so trava quem filtra por `min_trust`. O aviso colado
        # chega tambem a quem busca sem filtro, e e o que a skill
        # `verificar_citacao` do Studio le para bloquear (00-MVP-PLANO §5.4.5).
        assert "EM VERIFICAÇÃO" in conceito.armadilha, arquivo
        assert conceito.meta.get("verified") is False, arquivo


def test_item_conferido_entra_como_machine_confirmed():
    """§5.1: corrigidos e mantidos entram conferidos, nunca revisados.

    `human-reviewed` e assinatura do responsavel tecnico (etapa 4 do pipeline), e
    e o unico nivel que abre a zona amarela. Nenhum arquivo desta carga pode
    nascer nele.
    """
    conferidos = [
        (a, c) for a, c in conceitos()
        if c.auditoria.get("status", "").startswith("verificada-")
    ]
    assert len(conferidos) == 56
    for arquivo, conceito in conferidos:
        assert conceito.trust == "machine-confirmed", arquivo


def test_nenhum_conceito_do_seed_nasce_human_reviewed():
    for arquivo, conceito in conceitos():
        assert conceito.trust != "human-reviewed", arquivo


def test_todo_registro_de_erro_carrega_o_aviso_colado():
    """Os 20 erros da §1 entram marcados `armadilha` (ADR-0027).

    Sem a marca, o enunciado errado e recuperado com score alto e chega ao
    agente indistinguivel do certo -- que e exatamente o caminho pelo qual o
    erro entrou no documento original.
    """
    erros = [(a, c) for a, c in conceitos() if a.name.startswith("armadilha-")]
    assert len(erros) == 21  # 20 itens, e o da Sumula 385 em dois Espacos
    for arquivo, conceito in erros:
        assert conceito.armadilha, arquivo


def test_a_sumula_385_leva_o_aviso_tambem_no_conceito_correto():
    """§5.1, textual: o aviso viaja com o item.

    A Sumula 385 tem sentido OPOSTO ao que se supunha, e quem a recupera pelo
    enunciado certo pode estar chegando pela lembranca errada. E o unico caso em
    que a §5.1 exige o aviso nos dois lados.
    """
    corretos = [
        c for a, c in conceitos() if a.name == "sumula-385-stj-sentido-correto.md"
    ]
    assert len(corretos) == 2  # `bancario` e `cdc`
    for conceito in corretos:
        assert "defensiva" in conceito.armadilha


def test_copia_do_mesmo_conceito_em_dois_espacos_e_identica():
    """Duplicar conteudo e o preco do alcance; duplicar divergente e bug.

    Um item cujas competencias moram em Espacos disjuntos precisa de uma copia em
    cada um, senao o aviso nao chega a quem erraria. O que nao pode acontecer e
    as duas copias divergirem numa correcao futura.
    """
    por_nome: dict[str, set[str]] = {}
    for arquivo, _ in conceitos():
        por_nome.setdefault(arquivo.name, set()).add(
            arquivo.read_text(encoding="utf-8")
        )
    for nome, versoes in por_nome.items():
        assert len(versoes) == 1, nome


# ── legislacao e modelos (00-MVP-PLANO §5.4, itens 4 e 6) ───────────────────

LEGISLACAO = CONTENT / "legislacao"
MODELOS = CONTENT / "modelos"
SCRIPTS = CONTENT.parent / "scripts"


def _arquivos(raiz: pathlib.Path) -> list[tuple[pathlib.Path, okf.Concept]]:
    saida = []
    for arquivo in sorted(raiz.rglob("*.md")):
        conceito = okf.parse(arquivo.read_text(encoding="utf-8"))
        assert conceito is not None, arquivo
        saida.append((arquivo, conceito))
    return saida


def _script(nome: str):
    """Carrega um script de `scripts/` como modulo (o nome tem hifen)."""
    import importlib.util
    import sys

    spec = importlib.util.spec_from_file_location(nome.replace("-", "_"), SCRIPTS / f"{nome}.py")
    modulo = importlib.util.module_from_spec(spec)
    # Registrar antes de executar: `@dataclass` procura o modulo em
    # `sys.modules`, e sem isto o carregamento morre com AttributeError.
    sys.modules[spec.name] = modulo
    spec.loader.exec_module(modulo)
    return modulo


def test_legislacao_e_norma_conferida_por_maquina_e_nunca_revisada():
    """Texto do Planalto e fonte primaria coletada por maquina, e so isso.

    `human-reviewed` e a assinatura do responsavel tecnico; um arquivo baixado
    nascer nesse nivel abriria a zona amarela sem ninguem ter lido.
    """
    for arquivo, conceito in _arquivos(LEGISLACAO):
        assert arquivo.parent.name in TODOS_OS_SLUGS, arquivo
        assert conceito.type == "Norma", arquivo
        assert conceito.trust == "machine-confirmed", arquivo
        assert conceito.meta.get("fonte", {}).get("url", "").startswith(
            "https://www.planalto.gov.br/"), arquivo


def test_mapa_de_legislacao_aponta_para_espaco_declarado():
    fetch = _script("fetch-legislacao")
    for diploma in fetch.DIPLOMAS:
        for espaco in diploma.espacos:
            assert espaco in TODOS_OS_SLUGS, f"{diploma.slug} -> {espaco}"


def test_conversor_descarta_o_texto_riscado_e_preserva_o_ordinal():
    """As duas metades da regra do riscado, no HTML do Planalto.

    O revogado dentro de `<strike>` sai (senao a redacao velha e recuperada
    com o mesmo score da vigente); o `<s>º</s>` do CC fica (senao "§ 1º" vira
    "§ 1" e a busca lexical pelo paragrafo deixa de casar).
    """
    fetch = _script("fetch-legislacao")
    html_cp1252 = (
        "<p>CAPÍTULO I</p><p>DAS COISAS</p>"
        "<p><strike>Art. 7º Redação revogada.</strike></p>"
        "<p>Art. 7º Redação vigente.</p><p>§ 1<s>º</s> Parágrafo.</p>"
    ).encode("cp1252")
    diploma = fetch.Diploma("t", "T", "https://www.planalto.gov.br/t", ("cdc",))
    partes = fetch.para_markdown(fetch.decodificar(html_cp1252), diploma)
    texto = "\n".join(linha for parte in partes for linha in parte.linhas)
    assert "revogada" not in texto
    assert "Redação vigente" in texto
    assert "§ 1º Parágrafo" in texto
    assert "###### Art. 7" in texto


def test_todo_modelo_e_conceito_okf_do_tipo_modelo():
    modelos = _arquivos(MODELOS)
    assert modelos
    for arquivo, conceito in modelos:
        assert conceito.type == "Modelo", arquivo
        assert arquivo.parent.name in TODOS_OS_SLUGS, arquivo
        # Modelo nao nasce conferido: e texto operacional que o responsavel
        # tecnico ainda nao assinou.
        assert conceito.trust == "unverified", arquivo


def test_copia_do_mesmo_modelo_em_dois_espacos_e_identica():
    por_nome: dict[str, set[str]] = {}
    for arquivo, _ in _arquivos(MODELOS):
        por_nome.setdefault(arquivo.name, set()).add(arquivo.read_text(encoding="utf-8"))
    for nome, versoes in por_nome.items():
        assert len(versoes) == 1, nome


def test_seed_de_templates_do_studio_e_o_export_dos_modelos():
    """O JSON do Studio e gerado; editado a mao, ele diverge da KB em silencio."""
    exportar = _script("export-templates")
    esperado = exportar.serializar(exportar.montar())
    if not exportar.SAIDA.exists():
        pytest.skip("studio/api/seed fora deste checkout")
    assert exportar.SAIDA.read_text(encoding="utf-8") == esperado, (
        "rode scripts/export-templates.py"
    )


# ── os conjuntos de avaliacao ──────────────────────────────────────────────


def conjunto(slug: str) -> dict:
    with (EVAL / f"{slug}.yaml").open(encoding="utf-8") as arquivo:
        return yaml.safe_load(arquivo)


def test_ha_conjunto_para_cada_espaco_da_onda_1():
    assert {a.stem for a in EVAL.glob("*.yaml")} == ONDA_1


@pytest.mark.parametrize("slug", sorted(ONDA_1))
def test_cada_conjunto_tem_pelo_menos_50_perguntas(slug):
    assert len(conjunto(slug)["questions"]) >= 50


@pytest.mark.parametrize("slug", sorted(ONDA_1))
def test_metade_em_cada_voz(slug):
    perguntas = conjunto(slug)["questions"]
    leigo = [q for q in perguntas if q["strategy"] == "dificil"]
    tecnico = [q for q in perguntas if q["strategy"] == "direta"]
    assert len(leigo) == len(tecnico) == len(perguntas) // 2


@pytest.mark.parametrize("slug", sorted(ONDA_1))
def test_o_tipo_de_dificuldade_vem_do_vocabulario_fixo(slug):
    for pergunta in conjunto(slug)["questions"]:
        estrategia, tipo = benchmark.classificar(
            pergunta["strategy"], pergunta.get("kind")
        )
        assert estrategia == pergunta["strategy"]
        if estrategia == "dificil":
            assert tipo in benchmark.TIPOS_DIFICEIS, pergunta["question"]


@pytest.mark.parametrize("slug", sorted(ONDA_1))
def test_nenhuma_pergunta_tem_gabarito(slug):
    """R4 aplicada ao conjunto de avaliacao.

    Gabarito escrito aqui seria afirmacao de direito sem proveniencia: o
    repertorio ainda nao foi ingerido, entao a unica fonte possivel seria a
    memoria de quem escreve. O esquema admite `reference` vazio (migracao 0009);
    o preenchimento e da etapa 4 do pipeline, com o responsavel tecnico.
    """
    for pergunta in conjunto(slug)["questions"]:
        assert not pergunta.get("reference")


@pytest.mark.parametrize("slug", sorted(ONDA_1))
def test_nao_ha_pergunta_repetida_no_conjunto(slug):
    """A idempotencia da carga e por TEXTO: repetida no arquivo, some na carga."""
    perguntas = [q["question"].strip() for q in conjunto(slug)["questions"]]
    assert len(perguntas) == len(set(perguntas))


# ── a classificacao da pergunta manual ─────────────────────────────────────


def test_pergunta_manual_sem_estrategia_cai_na_direta():
    assert benchmark.classificar(None, None) == ("direta", "")


def test_estrategia_desconhecida_e_recusada():
    with pytest.raises(ValueError):
        benchmark.classificar("facil", None)


def test_tipo_de_dificuldade_desconhecido_e_recusado():
    with pytest.raises(ValueError):
        benchmark.classificar("dificil", "pegadinha")


def test_tipo_so_vale_dentro_do_conjunto_dificil():
    """Rotulo de dificuldade numa pergunta direta seria grupo fantasma.

    O relatorio agrupa por tipo DENTRO do conjunto dificil; um `limite` solto no
    conjunto direto apareceria como se fosse do outro grupo.
    """
    assert benchmark.classificar("direta", "limite") == ("direta", "")
