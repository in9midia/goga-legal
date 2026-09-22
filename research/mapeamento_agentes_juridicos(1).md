# Mapeamento de Agentes Jurídicos — Aplicativo de Atendimento Jurídico Digital

Escopo: atendimento a pessoas físicas, com foco prioritário em defesa do consumidor, abrangendo as demais áreas cíveis e conexas. Excluídos expressamente: direito de família e direito penal (exceto análise de exclusão/encaminhamento).

Objetivo do documento: mapear todos os agentes de IA que precisam ser construídos, definindo a competência exclusiva de cada um, desde a recepção informal da demanda (texto ou voz transcrita) até o resumo do caso e a orientação preliminar ao usuário.

## 1. Visão geral da arquitetura (pipeline)

[Usuário] → (1) Recepção → (2) Compreensão/Identificação → (3) Coleta e Análise de Documentos
→ (4) Triagem e Classificação Jurídica → (5) Orquestrador/Roteador → (6) Agente Jurídico Especializado
→ (7) Análise do Caso → (7a) Adversidade e Blindagem (todas as peças: ataque → esclarecimentos/documentos → blindagem → revalidação)
→ (8) Resumo do Caso → (9) Orientação/Escolha de Via → (10) Peças e acompanhamento (JEC/civil) → (11) Monitoramento processual

Princípios de desenho:

Separação de responsabilidades — nenhum agente acumula mais de uma competência. Recepção não classifica; classificação não analisa mérito; especialista não conversa diretamente sem passar pelo orquestrador.

Estado do caso centralizado — todos os agentes leem e escrevem em um case file estruturado (fatos, partes, documentos, pedidos potenciais, prazos, riscos).

Escalão de confiança — cada agente devolve um score de confiança; abaixo do limiar, o orquestrador pede mais informação ou escala para humano.

Guardrails de exclusão — demandas de família e penal são detectadas o quanto antes (ideal: na triagem) e tratadas por um agente de exclusão/encaminhamento, nunca pelos especialistas.

O usuário fala informal; o sistema formaliza — todo o trabalho de traduzir “linguagem de WhatsApp/áudio” para linguagem jurídica é da camada de recepção/compreensão, não dos especialistas.

## 2. Camada 0 — Agentes de Recepção e Compreensão (pré-jurídica)

### Agente 1 — Recepcionista Multimodal

Missão: primeiro contato. Acolhe a mensagem de texto ou transcrição de voz, normaliza erros de transcrição, identifica idioma e tom (urgência, angústia), e inicia o case file.

Competência exclusiva: normalização de entrada informal; detecção de urgência (ex.: desligamento de energia, bloqueio de conta, voo em horas); extração de dados de contato mínimos.

Não faz: nenhum julgamento jurídico.

### Agente 2 — Identificador de Demanda (Intake)

Missão: transformar a narrativa informal em uma ficha estruturada: quem são as partes, o que aconteceu, quando, valores envolvidos, o que o usuário quer.

Pergunta discriminadora obrigatória inicial: “você busca fazer uma reclamação/cobrança contra alguém, ou recebeu uma cobrança/intimação/processo contra você?” — define o polo (autor/réu) desde o início; se réu, intake de defesa com prioridade à citação/intimação e data (marco de prazo).

Protocolo de processo preexistente (ativo ou extinto): se na interação for constatado que já houve ou há processo em andamento envolvendo o usuário (relato espontâneo, menção a número de processo, citação recebida, processo anterior sobre o mesmo fato), o agente: (i) coleta o que o usuário souber (número do processo, tribunal, vara, partes — interagindo ao máximo; se não souber o número, coleta dados para localização: nome das partes, tribunal provável, ano aproximado); (ii) orienta o usuário a exportar os autos pelo próprio acesso: a plataforma não baixa processo em nome do usuário (autos públicos são acessíveis pela consulta pública do tribunal; autos em segredo de justiça e o acesso qualificado exigem o login gov.br da própria parte — o agente conduz o usuário passo a passo na exportação do PDF integral e no envio pelo chat); (iii) cria ticket de integração com pessoa (atendimento humano da plataforma) para apoiar o usuário na localização e obtenção, com meta de resolução em 48 horas úteis; (iv) registra no case file a existência do processo preexistente com status “obtenção dos autos pendente”, e o caso segue em análise preliminar sem conclusões sobre o mérito até o recebimento e leitura dos autos (regra-mãe: nada se afirma sobre processo não lido).

Competência exclusiva: entrevista iterativa — faz perguntas curtas e objetivas para preencher lacunas mínimas, sob regras de neutralidade: perguntas abertas antes de fechadas; vedado sugerir resposta ou revelar a finalidade jurídica da pergunta (vedação a leading questions); a primeira narrativa espontânea é preservada com proveniência no case file.

Saída: ficha de intake com campos obrigatórios preenchidos + polo + lista de lacunas.

### Agente 3 — Gestor Documental e Pré-Atendimento Processual

Missão: identificar quais documentos são necessários conforme o tipo provável de caso, solicitá-los ao usuário em linguagem simples (“envie a fatura”, “foto do contrato”), receber arquivos/imagens, fazer OCR, validar legibilidade e extrair dados estruturados (nomes, CPF/CNPJ, datas, valores, cláusulas).

Módulo de pré-atendimento para ação (checklist obrigatório antes de qualquer peça): quando o caso se encaminha para via judicial (JEC/JEF), o agente monta e conduz o checklist completo de habilitação, interagindo até a completude (regra-mãe):

Identificação — documento de identidade com foto (RG/CNH/outro válido), capturado e validado pelo Agente 49 (inclui selfie com documento);

Comprovante de residência — recente (até 90 dias), em nome do usuário; se em nome de terceiro, orienta as alternativas (declaração de residência, correspondência oficial, conta de consumo + declaração);

CPF e demais dados de qualificação civil (estado civil, profissão — extraídos via intake);

Documentos probatórios do caso — catálogo por tipo de demanda (contrato, faturas, prints, protocolos de atendimento, notas fiscais, laudos, fotos, gravações lícitas, testemunhas com nome e contato);

Documentos da contraparte — razão social/CNPJ e endereço do réu (orienta o usuário a obter: nota fiscal, site, cartão CNPJ — essencial para a citação). Cada item é validado (legibilidade, vigência, pertinência) e o status do checklist fica visível ao usuário (“faltam 2 documentos: comprovante de residência e a fatura de junho”). Nenhuma petição inicial é gerada pelo Copiloto (32) sem o checklist de habilitação completo — trava de fluxo registrada no case file.

Competência exclusiva: catálogo de documentos por tipo de demanda; checklist de habilitação processual; OCR/visão; extração de campos; checagem de autenticidade aparente e de completude; versionamento documental.

Não faz: análise jurídica do conteúdo (extrai dados, não opina).

### Agente 4 — Classificador Jurídico (Triagem)

Missão: ler a ficha de intake + dados documentais e classificar a demanda: área(s) do direito, sub-tema (ex.: consumidor → telemarketing abusivo; negativação indevida; voo cancelado), polo processual (campo obrigatório: autor / réu / ambíguo) — se réu, roteamento prioritário à defesa com flag de prazo processual em curso (fast-path), urgência, foro competente provável (JEC vs. vara comum), e estimativa de complexidade (baixa/média/alta).

Competência exclusiva: taxonomia jurídica e roteamento. Devolve ranking de áreas com score de confiança e justificativa.

Regra crítica: detecta gatilhos de exclusão (família/penal) e desvia imediatamente para o Agente 5.

### Agente 5 — Agente de Exclusão e Encaminhamento (Família/Penal/Fora de escopo)

Missão: único autorizado a tratar demandas fora do escopo. Confirma se realmente é família/penal (evita falso positivo — ex.: “meu pai comprou” não é família; “ameaça do lojista” pode ser mero relato dentro de caso consumerista).

Competência exclusiva: decisão de fora-de-escopo; resposta empática ao usuário explicando a limitação; encaminhamento orientado (defensoria pública, OAB, delegacia, MP) sem prestar consultoria na área excluída.

## 3. Camada 1 — Orquestração e qualidade

### Agente 6 — Orquestrador/Roteador (Case Manager)

Missão: cérebro do fluxo. Recebe a classificação e delega ao(s) agente(s) especializado(s) correto(s); gerencia casos multiárea (ex.: consumidor + bancário + seguros no mesmo fato); controla ordem de análise; consolida pareceres parciais.

Competência exclusiva: roteamento, priorização, gestão de dependências entre agentes, resolução de conflitos de classificação.

Não faz: análise jurídica de mérito.

### Agente 7 — Analista de Prazos e Riscos Processuais (transversal)

Missão: serviço de apoio a todos os especialistas: calcula prescrição/decadência provável, prazos recursais de demandas já judiciais, marcos temporais relevantes (ex.: arrependimento art. 49 CDC em 7 dias), e sinaliza urgências.

Competência exclusiva: matriz de prazos por tema; alertas de perecimento de direito.

### Agente 8 — Guardião de Conformidade e Ética (Compliance)

Missão: revisar todas as saídas antes de chegarem ao usuário: verificar disclaimers (“não substitui advogado”), vedação de promessa de resultado, adequação ao Código de Ética da OAB e à LGPD (dados sensíveis), e consistência com o que consta no case file (anti-alucinação).

Competência exclusiva: veto de saída. Qualquer resposta ao usuário passa por ele.

### Agente 9 — Redator do Resumo do Caso (Case Summary)

Missão: consolidar ficha + documentos + parecer do especialista em um resumo claro e padronizado: partes, fatos cronológicos, provas disponíveis, enquadramento jurídico, teses aplicáveis, valores estimados, riscos, prazos e próximos passos.

Competência exclusiva: síntese final do caso em linguagem acessível, com versão técnica (para o advogado) e versão simplificada (para o usuário).

### Agente 10 — Agente de Orientação ao Usuário e Escolha de Via

Missão: transformar o resumo em orientação acionável e, após a análise, apresentar ao usuário a escolha de via:

Via extrajudicial — Procon, consumidor.gov.br, ouvidorias e reguladores setoriais (Anatel, ANS, Bacen — sem custas): a ferramenta redige a reclamação completa (Agente 52) e acompanha a resposta — é a via de menor risco regulatório e maior taxa de resolução;

Processo civil comum (vara) — sempre com advogado (art. 104, CPC): se a análise indicar essa via, por opção ou por necessidade, o agente informa expressamente ao usuário que a postulação exige advogado e que a plataforma agendará uma consulta por vídeo com advogado (Agente 11); nessa via a ferramenta não gera peça para protocolo do usuário nem minuta; envolve custas judiciais (cálculo estimado + checagem de gratuidade, art. 98 CPC), prazo mais longo, valores maiores e tese mais ampla;

Juizado Especial (JEC/JEF, conforme a matéria) — sem custas em 1º grau (art. 55, Lei 9.099/95; informadas custas recursais e risco de má-fé), mais rápido, e a ferramenta dá suporte integral: geração de todas as peças + acompanhamento (Agentes 32 e 33), com o usuário em nome próprio; recursos exigem advogado — bloqueio duro + handoff obrigatório.

Competência exclusiva: comunicação final; quadro comparativo das vias (custas, prazo, chance qualificada, esforço exigido do usuário); tomada de decisão assistida — o usuário escolhe explicitamente a via antes de qualquer peça ser gerada; no caso JEC, explica que ele próprio será o autor e a ferramenta o guiará em tudo.

Observação (corrigida — a versão anterior deste item foi excluída por contradição): petições e manifestações em nome próprio são geradas somente nos foros com jus postulandi (JEC/JEF, nos limites legais); na vara cível comum e em qualquer fase recursal a ferramenta não gera peça nem minuta — handoff para o Agente 11 é obrigatório, não opcional (Guardrail 4 prevalece).

### Agente 11 — Consulta por Vídeo com Advogado (handoff agendado pela plataforma)

Missão: gerenciar a transição para advogado humano por meio de consulta por vídeo agendada pela própria plataforma. É acionado em duas hipóteses: (i) obrigatória — causa destinada à vara cível comum, por opção ou por necessidade (art. 104, CPC), e qualquer fase recursal (recurso inominado ou outro recurso — bloqueio duro do Agente 32); (ii) opcional — usuário que prefira representação profissional em qualquer via.

Competência exclusiva: agendamento da videochamada com o advogado da plataforma (rede própria/parceira); preparação e envio prévio ao advogado do dossiê completo (resumo técnico + documentos + linha do tempo + matriz fato × prova) para aproveitamento da consulta; condução da transição pós-consulta (procuração, proposta de honorários apresentada pelo advogado, continuidade do monitoramento pelo Agente 33 após a distribuição).

Em nenhuma hipótese a ferramenta gera peça ou minuta para a via da vara cível comum — a atuação técnica é integralmente do advogado a partir da consulta.

Alerta regulatório (resolvido antes do lançamento): o modelo “advogado da plataforma apresenta proposta de honorários após a consulta” aproxima-se de captação e agenciamento de causas (art. 34, III e IV, Lei 8.906/94; arts. 5º e 7º do Código de Ética e Disciplina da OAB; Provimento 205/2021 do CFOAB). A OAB tem histórico de representações contra plataformas de intermediação. Condicionante de go-live: parecer específico sobre o modelo comercial do handoff e, idealmente, consulta prévia à comissão competente da OAB/SP. O handoff deve ser estruturado para que a relação advocatícia nasça diretamente entre usuário e advogado/sociedade, sem mercantilização da captação pela empresa de tecnologia.

### Agente 34 — Agente de Adversidade e Blindagem (stress-test de todas as peças)

Missão: porta de saída obrigatória sobre TODAS as peças produzidas em qualquer fase do caso — petição inicial, manifestações, respostas a decisões, cumprimento de sentença, pareceres e orientações — com duplo objetivo: (1) atacar cada peça sob a ótica adversária (parte contrária, Ministério Público/Procuradoria, juiz crítico) e (2) blindar a peça, ou seja, garantir que cada fragilidade identificada seja neutralizada antes do protocolo/entrega: lacuna probatória é suprida ou a alegação é removida/reformulada; nenhum ataque previsível é pré-respondido dentro da peça (vedação absoluta de antecipação — regra estratégica abaixo); contradição é sanada com esclarecimento do usuário. Nenhuma peça sai da plataforma sem versão blindada aprovada.

Competência exclusiva: (i) teste de adversidade estruturado em 4 camadas (forma, fato, prova, direito); (ii) matriz fato × prova (cada fato alegado exige prova; fato sem prova = fragilidade marcada); (iii) detecção de contradições entre intake, documentos e peça, e de prova autoincriminatória; (iv) protocolo de blindagem — para cada fragilidade: obriga suprimento (documento/esclarecimento via Agentes 2/3) ou reformulação da tese pelo especialista de origem (remover alegação improvável, qualificar pedido, reposicionar narrativa); revalida a peça blindada; (v) geração de pedido de esclarecimentos fáticos/documentais antes de liberar a peça; (vi) laudo de adversidade com veredito: BLINDADA / BLINDADA COM RESSALVA / BLOQUEADA — PENDENTE ESCLARECIMENTOS.

Regra estratégica rígida — vedação de antecipação: as simulações de defesa adversária e de decisão de improcedência são material interno de trabalho do Agente 34. É vedado antecipar na petição defesas, teses ou argumentos que a parte contrária possa suscitar — a peça blindada deve ser “limpa”: sustenta a tese própria com força máxima e prova robusta, sem revelar ao adversário os pontos de ataque identificados. A blindagem se dá por reforço probatório e reformulação, nunca por pré-resposta a tese ainda não arguida. Exceção de ordem pública (tratamento interno, não na peça): matéria cognoscível de ofício — prescrição e decadência com termo inicial evidente (art. 332, §1º, CPC autoriza improcedência liminar) — é avaliada antes do protocolo: se caracterizada, o agente não protocola peça condenada; esclarece ao usuário, em linguagem simples, o óbice temporal e as alternativas (extrajudicial, acordo). A peça permanece “limpa”, mas o caso não avança cego para o despacho de improcedência.

Regra de ciclo: peça só segue para o usuário após laudo BLINDADA; BLOQUEADA dispara automaticamente a rodada de esclarecimentos/documentos, reformulação e nova adversidade — ciclo repetido até blindagem.

Não faz: não conversa diretamente com o usuário (solicitações passam pelos Agentes 2/3/10); a reescrita técnica da tese é do especialista de origem, sob especificação de blindagem emitida pelo Agente 34.

### Agente 35 — Registro Contínuo e Autocrítica (aprendizado do sistema — uso exclusivo dos desenvolvedores)

Missão: registrar na nuvem toda a conversa e todo o processamento dos agentes de cada caso (intake, documentos, classificações, pareceres, laudos de adversidade, peças, andamentos do Monitor, decisões judiciais) e acompanhar o caso até o final; ao desfecho, executar a autocrítica do sistema: comparar o que foi alegado pela parte (e o que os agentes previram/recomendaram) com o que foi efetivamente reconhecido pelo juízo, identificando falhas e gerando insumos de aprimoramento dos agentes.

Competência exclusiva: (i) log integral e imutável de todas as interações e decisões de agentes por caso (trilha de auditoria versionada na nuvem); (ii) análise de divergência prognóstico × desfecho — ponto a ponto: tese acolhida, rejeitada ou ignorada; prova valorada ou desprezada; pedido deferido total/parcial/indeferido; (iii) classificação da falha identificada (falha de intake — pergunta não feita; falha documental — prova não solicitada; falha de classificação; falha de tese; falha de blindagem — ataque não previsto; falha de prognóstico — jurisprudência do foro mal lida); (iv) geração de relatório de aprimoramento com a falha, a causa raiz e a correção proposta no agente responsável (prompt, taxonomia, regra, checagem adicional); (v) consolidação de métricas de aprendizado por agente e por área.

Sigilo absoluto: as informações deste agente em hipótese alguma vão ao usuário do app — destino exclusivo dos desenvolvedores dos agentes. Não alimenta respostas, pareceres ou orientações ao usuário; trilha criptografada, acesso restrito (MFA + RBAC + trilha de acesso).

Arquitetura LGPD em duas camadas: Camada A (trilha do caso — base: execução de contrato) com retenção = duração do caso + prazo prescricional definido, sujeita a eliminação; Camada B (autocrítica/aprendizado) com pseudonimização obrigatória por padrão (chaves de reidentificação em cofre separado) e anonimização nos relatórios de aprimoramento; base de legítimo interesse com RIPD prévia documentada; prazo máximo de retenção e descarte automático; vedação de reidentificação; separação física/lógica entre as camadas.

Não faz: não interfere no caso em curso (não opina, não bloqueia, não sugere ao usuário); atua em leitura sobre o log — a influência no caso concreto é indireta, via melhoria futura dos agentes.

### Agente 44 — Controlador de Narrativa (estilo e concisão)

Missão: controlar a narrativa fática de tudo o que sai da plataforma para o usuário — peças JEC, resumos, orientações, respostas de texto e roteiros de áudio — garantindo o padrão: clara, direta e na menor extensão possível; direta ao ponto; sem repetições, rodeios ou argumentação redundante.

Competência exclusiva: (i) reescrita/enxugamento de qualquer texto user-facing que não atinja o padrão (corta redundâncias, elimina duplicidades, ordena a narrativa em linha reta cronológica, remove adjetivação e floreios); (ii) regras de estilo mensuráveis (uma ideia por parágrafo, frases curtas, cronologia linear, pedido em destaque ao final); (iii) parecer de estilo: APROVADO / RETORNA PARA ENXUGAMENTO, com a versão enxuta já produzida; (iv) preservação do conteúdo jurídico — corta forma, jamais fato, prova ou pedido (qualquer supressão de conteúdo substantivo é vetada e devolvida ao especialista).

Posição no fluxo: atua antes do Agente 34 (adversidade/blindagem) — a peça já chega à blindagem enxuta — e novamente depois da blindagem, se a reformulação tiver reintroduzido prolixidade. A revisão de sucinticidade do Agente 34 passa a ser feita sobre o trabalho do Controlador de Narrativa.

Não faz: não opina sobre mérito, direito ou estratégia; não altera conteúdo substantivo; não fala diretamente com o usuário.

### Agente 49 — Identificação e Assinatura Digital (KYC + prova de vida)

Missão: capturar e validar a identidade do usuário e colher suas assinaturas digitais com robustez probatória.

Competência exclusiva: (i) captura de dados do documento de identidade — o usuário fotografa RG, CNH ou outro documento válido pela legislação; o agente extrai por OCR todos os dados (nome completo, filiação, data de nascimento, número e órgão expedidor do documento, CPF quando constar, naturalidade, validade) e os grava no case file com proveniência “documento de identidade”; (ii) verificação de autenticidade aparente do documento (padrões de segurança, consistência dos campos, validade temporal, compatibilidade foto × dados); (iii) captura da assinatura digital do usuário com prova de vida — selfie do usuário segurando o documento de identidade em mãos, com validação de correspondência facial (selfie × foto do documento) e detecção de vivacidade (anti-foto-de-foto/vídeo); (iv) coleta da assinatura eletrônica em si (desenho da assinatura na tela ou aceite eletrônico), vinculada ao pacote de evidências: documento + selfie com documento + hash do documento assinado + data/hora + IP/dispositivo; (v) classificação do nível da assinatura conforme a Lei 14.063/2020 (simples/avançada) e orientação quando o ato exigir ICP-Brasil ou forma superior (handoff/cartório); (vi) integração com o núcleo contratual (45–48): minuta aprovada pelo usuário segue para este agente para assinatura com pacote de evidências.

LGPD (dado sensível — biometria): consentimento específico e destacado para coleta de biometria facial e imagem do documento (art. 11, I); finalidade exclusiva de identificação/assinatura; criptografia e retenção mínima necessária à prova dos atos; vedado uso da biometria para outra finalidade; eliminação a pedido do titular observada a necessidade de guarda probatória.

Regra-mãe aplicada: dado ilegível na foto = nova solicitação ao usuário (melhor iluminação/enquadramento), nunca preenchimento por suposição; divergência entre dados do documento e dados declarados no intake = flag ao Agente 34 (contradição crítica).

Não faz: não valida mérito do documento assinado; não certifica como cartório/ICP-Brasil (não substitui certificado digital qualificado quando exigido por lei).

### Agente 51 — Direito Processual Civil (checagem processual)

Missão: agente técnico-processual que checa ações e peças antes da entrega, analisa o andamento processual e faz análise processual de casos sob três módulos: Módulo 1 — Análise de Distribuição de Ações (competência, ação e condições da ação, partes/litisconsórcio/intervenção de terceiros, petição inicial e juízo de admissibilidade, distribuição e registro); Módulo 2 — Análise de Recursos e Meios de Impugnação (precedentes vinculantes, teoria geral recursal, tabela de cabimento por decisão atacada, impugnações não recursais); Módulo 3 — Checagem de Andamento Processual (atos, prazos e preclusão, comunicação dos atos, formação/suspensão/extinção, fases do procedimento comum e execução, com saída padronizada de 8 itens por processo).

Posição no fluxo: serviço técnico transversal — chamado pelo Orquestrador (6) para checar peças do Copiloto (32) e dos especialistas antes do Controlador de Narrativa (44) e da Adversidade (34); analisa os autos recebidos via protocolo de processo preexistente (Agente 2); dá lastro processual ao Monitor (33) na classificação de andamentos e prazos. Trabalha com o Agente 7 (prazos materiais) — o 51 é a autoridade em prazos processuais.

Manutenção normativa viva: a camada normativa do Agente 51 se sobrepõe a qualquer material de referência datado (manuais, doutrina) e exige curadoria contínua nomeada — alterações já incorporáveis desde a construção: Lei 14.195/2021 (citação e intimação eletrônicas), Lei 14.905/2024 (novo regime de juros e correção — arts. 389 e 406 CC: IPCA + Selic deduzido o IPCA) e alterações de rito dos juizados. Sem curadoria nomeada e rotina de atualização, o agente não entra em produção.

Regras de comportamento: nunca inventar prazo ou dispositivo (regra-mãe); citar sempre o artigo; sinalizar divergência doutrinária/jurisprudencial; em matéria controvertida (taxatividade mitigada do art. 1.015, estabilidade da tutela antecipada, cumulação de dobros de prazo), apresentar tese dominante e contrária; classificar sempre a decisão antes de indicar o meio de impugnação; distinguir decisão interlocutória de mérito (art. 1.015, II) das demais.

Não fala diretamente com o usuário — suas análises alimentam os especialistas, o Copiloto, o Monitor e a Adversidade.

### Agente 12 — Memória e Contexto do Cliente

Missão: manter histórico do usuário entre sessões: casos anteriores, documentos já enviados, preferências, evitando repedir informação.

Competência exclusiva: perfil longitudinal do cliente (com consentimento LGPD).

### Agente 13 — Qualidade e Auditoria (QC)

Missão: amostragem e revisão de casos fechados; mede acurácia de classificação, satisfação, divergências entre especialista e desfecho real; alimenta melhoria contínua e taxonomia.

Competência exclusiva: auditoria retroativa, não interfere no fluxo em tempo real.

## 4. Camada 2 — Agentes Jurídicos Especializados (análise de mérito)

Cada especialista recebe do orquestrador: ficha de intake, documentos extraídos, classificação e alertas de prazo. Devolve: parecer estruturado (enquadramento, normas e jurisprudência aplicáveis, tese, chance qualificada, pedidos possíveis, valor estimado, riscos, documentos faltantes, recomendação de via: extrajudicial / JEC / ação comum / escalonamento).

### 4.1 Núcleo Consumerista (foco do aplicativo)

Agente 14 — Consumidor Geral (CDC core) - Práticas abusivas, publicidade enganosa, oferta vinculante (arts. 30/35), defeito de produto e serviço, garantia, vício de qualidade, direito de arrependimento (art. 49), cláusulas abusivas, recall, responsabilidade pelo fato do produto (acidentes de consumo). - Fronteiras: desvia cobranças bancárias → Agente 15; voos → Agente 17; plano de saúde → Agente 18.

Agente 15 — Bancário e Financeiro - Negativação indevida (Serasa/SPC), fraudes em conta (PIX, cartão clonado — responsabilidade objetiva do banco, Súmula 479/STJ), juros abusivos e capitalização, renegociação de dívidas, superendividamento (Lei 14.181/2021 — CDC, Capítulo VI-A, arts. 54-A e ss.), empréstimos consignados indevidos, bloqueios indevidos em conta. - Alta prioridade de construção (maior volume em apps consumeristas). - Cálculo obrigatório atualizado: memória de cálculo de juros e correção monetária deve aplicar o novo regime da Lei 14.905/2024 (arts. 389 e 406 CC — correção pelo IPCA e juros pela Selic deduzido o IPCA); cálculo exclusivamente por código, nunca por LLM.

Agente 16 — Telecom e Serviços Essenciais - Telefonia/internet/TV por assinatura: cobranças indevidas, serviços contratados sem consentimento (telemarketing abusivo), falha na prestação, cancelamento dificultado; água, luz e gás: corte indevido, faturas irregulares, religação.

Agente 17 — Aéreo e Turismo - Atraso/cancelamento de voo, overbooking, extravio de bagagem, downgrading; pacotes turísticos, hospedagem, cancelamento de viagens; jurisprudência consolidada de dano moral.

Agente 18 — Planos de Saúde - Negativa de cobertura/procedimento (rol da ANS — taxatividade mitigada: EREsp 1.886.929/STJ e Lei 14.454/2022; reajuste por faixa etária — Tema 952/STJ), reajuste abusivo, rescisão unilateral, cobertura de medicamentos de alto custo, períodos de carência. Sensível: quase sempre gera escalonamento humano.

Agente 19 — E-commerce e Compras Online - Não recebimento de produto, arrependimento em 7 dias, lojas fraudulentas/golpes online, marketplaces (responsabilidade das plataformas — CDC art. 34 e jurisprudência consolidada; marco legal específico em verificação na auditoria da base validada — vedado citar lei não confirmada), estornos (chargeback).

Agente 20 — Imobiliário do Consumidor - Atraso de entrega de obra, distrato de imóvel na planta e devolução de valores, defeitos construtivos (garantia quinquenal), financiamento imobiliário, taxas de corretagem (Tema 938/STJ — corretagem transferível se destacada; taxa SATI abusiva). Devolução de valores: correção e juros pelo regime da Lei 14.905/2024.

Agente 21 — Veículos - Vício oculto em veículo novo/usado, recall, leilão, documentação/transferência (DETRAN), despachante, multas indevidas em decorrência de venda não transferida.

Agente 22 — Educação - Cobranças indevidas de mensalidades, cancelamento de matrícula/trancamento, propaganda enganosa de cursos, negativa de certificado, rematrícula e multas.

Agente 23 — Dano Moral Consumerista (cálculo) - Serviço especializado de quantificação: parâmetros jurisprudenciais por tribunal e tipo de dano (negativação, atraso de voo, corte de serviço essencial), critério de razoabilidade, precedentes do STJ. Apoia os demais especialistas de consumidor — não roteia casos. Toda quantificação com juros/correção aplica o regime da Lei 14.905/2024 (IPCA + Selic deduzido o IPCA).

### 4.2 Núcleo Contratual — criação de minutas e análise de contratos enviados

Cada agente contratual tem dupla função: (a) criar a minuta contratual sob medida a partir do intake (interagindo ao máximo com o usuário para extrair todas as informações — regra-mãe); e (b) analisar contrato enviado pelo usuário (assinado ou em negociação), apontando cláusulas, riscos, omissões e pontos a renegociar, sempre em linguagem simples. Todas as minutas e análises passam pelo Controlador de Narrativa (44) e pela Adversidade/Blindagem (34) antes da entrega.

Agente 45 — Contratos Imobiliários - Locação residencial e comercial, compra e venda, promessa de compra e venda, comodato, cessão de direitos, permuta. - Peculiaridades: garantias locatícias (caução, fiador, seguro-fiança — vedação de cumulação, art. 37, parágrafo único, Lei 8.245/91); vistoria e estado de conservação; benfeitorias; prazo e desocupação; na compra e venda: matrícula, certidões, ônus, escritura e registro, cláusula de arrependimento; condições de pagamento e correção.

Agente 46 — Contratos de Prestação de Serviços - Serviços em geral (obra, reforma, consultoria, freelancer, agenciamento), escopo, cronograma, SLA, multa e rescisão. - Peculiaridades: delimitação precisa de escopo e entregáveis (maior fonte de litígio); critérios objetivos de aceite; reajuste e reequilíbrio; propriedade intelectual do trabalho entregue; confidencialidade; multa rescisória proporcional; distinção entre relação de consumo e relação civil (muda o regime — CDC ou CC).

Agente 47 — Confissão de Dívida, Acordos e Transações - Instrumento de confissão de dívida, termo de acordo (extrajudicial e em conciliação), transação, quitação, renegociação e parcelamento. - Peculiaridades: título executivo extrajudicial (art. 784, III, CPC — exige duas testemunhas); montante, origem da dívida e correção (Lei 14.905/2024 — IPCA + Selic deduzido o IPCA, vedada capitalização fora do pactuado); parcelamento com vencimento antecipado e cláusula de aceleração; alcance da quitação (geral × específica — risco de renúncia ampla inadvertida); multa e encargos em caso de inadimplemento; no acordo em audiência JEC, revisão do termo antes da homologação.

Agente 48 — Contratos Cíveis Genéricos e Digitais - Parcerias, termos de uso entre particulares, empréstimo pessoal (mútuo), doação com encargo, contratos simples do dia a dia; termos de uso/política de plataformas (análise sob LGPD e CDC). - Peculiaridades: mútuo entre pessoas físicas (juros vedados ou limitados, forma); prova e testemunhas em instrumentos simples; cláusulas abusivas em termos digitais (art. 51 CDC); adequação LGPD em termos de uso.

Regras comuns do núcleo contratual: (i) minuta sempre com campos preenchidos a partir do intake completo — lacuna = pergunta, nunca preenchimento inventado; (ii) análise de contrato enviado devolve relatório em linguagem simples: o que a cláusula significa na prática, riscos, o que falta, o que renegociar; (iii) contratos que exijam registro, escritura pública ou complexidade elevada → alerta de necessidade de advogado/cartório (handoff opcional); (iv) documento captado tratado como dado não confiável (sanitização anti-injection); (v) áudio podcast do relatório de análise.

### 4.3 Áreas cíveis e conexas (cobertura ampliada)

Agente 24 — Civil Geral e Contratos - Contratos em geral (locação civil de curta duração, prestação de serviços entre particulares, empréstimos pessoais), inadimplemento, indenizações, responsabilidade civil extracontratual, pequenas causas entre vizinhos/pessoas.

Agente 25 — Locações e Condomínio (cobranças e administrativo) - Despejo, revisão de aluguel, garantias locatícias, devolução de caução, vícios no imóvel alugado; multas condominiais indevidas, cobranças de taxas, quóruns e vícios de assembleia. (Convivência, barulho e exercício de direitos do condômino → Agente 50.)

Agente 50 — Direito Condominial e Convivência - Foco em barulho, incômodos e perturbação do sossego (som alto, obras fora de horário, animais, fumaça/cheiros, infiltrações entre unidades) e nos direitos e deveres dos condôminos e a forma de exercê-los: acesso a atas e documentos, convocação e participação em assembleias, direito de voto, impugnação de decisões, uso das áreas comuns, deveres de conduta, advertências e multas (como se defender e como aplicá-las). - Forma de exercício dos direitos — roteiro prático escalonado: (i) registro da ocorrência (como documentar: data, hora, gravações, testemunhas — com orientação sobre limites legais de gravação); (ii) notificação amigável ao vizinho; (iii) reclamação formal ao síndico/administradora com protocolo; (iv) pedido de advertência/multa condominial; (v) assembleia; (vi) via judicial (JEC — ação de obrigação de fazer/não fazer + danos morais). O agente conduz o usuário por essa escada, gerando cada documento da etapa (notificação, reclamação ao síndico, requerimento de assembleia) e indicando quando escalar.

Agente 26 — Trabalhista (do empregado) - Verbas rescisórias, horas extras, registro de carteira (vínculo), assédio moral, acidente de trabalho, estabilidades. Fronteira: não atua pelo empregador (conflito de perfil B2C).

Agente 27 — Previdenciário - Aposentadorias, auxílio por incapacidade, BPC/LOAS, revisões de benefício, indeferimentos do INSS, prova de tempo de contribuição.

Agente 28 — Tributário do Cidadão - IPVA/IPTU indevidos, restituição de IR, débitos fiscais de pessoa física, isenções (isenção IPTU aposentado, IPVA PCD), execução fiscal defensiva. Complexidade alta → quase sempre escalonamento humano.

Agente 29 — Seguros - Negativa de sinistro (auto, vida, residencial), carências, coberturas, cancelamento unilateral de apólice, dívida do seguro DPVAT-like.

Agente 30 — Responsabilidade Civil e Acidentes - Acidentes de trânsito (indenizações fora do âmbito seguradora), quedas em estabelecimentos, danos causados por terceiros, responsabilidade de escolas/estabelecimentos.

Agente 31 — Proteção de Dados e Digital (LGPD) - Vazamento de dados (dano moral presumido em discussão), uso indevido de imagem, golpes digitais, exclusão de contas/perfil, golpe do falso emprego/golpes em apps, direitos do titular.

Agente 32 — Copiloto JEC (Juizado Especial — ação pela própria parte, com suporte integral da ferramenta) - Modelo de atuação: a ação é protocolada e conduzida pela própria parte (art. 9º, Lei 9.099/95 — até 20 SM sem advogado); a ferramenta dá suporte completo: gera todas as peças do processo (inicial, réplicas a decisões, manifestações, cumprimento de sentença) e acompanha o andamento processual de ponta a ponta, sem jamais figurar como representante. - Competências: (i) verificação de elegibilidade JEC (matéria, valor ≤ 20 SM, pessoa física); (ii) geração assistida do pedido inicial simplificado — peça que o usuário revisa, aprova e protocola em nome próprio; (iii) checklist documental personalizado com validação de cada documento enviado; (iv) geração de peças processuais subsequentes (manifestações, respostas a decisões saneadoras, pedidos de cumprimento de sentença) sempre mediante aprovação do usuário; (v) preparação para audiências de conciliação (roteiro de fala, simulação de perguntas, piso/teto de acordo pré-aprovados) e de instrução; (vi) acompanhamento processual integrado ao Agente 33 — leitura de intimações/publicações, tradução para linguagem simples e instrução do próximo passo; (vii) gestão de prazos do usuário. - Fronteiras rígidas: não protocola, não assina, não comparece. Causas acima de 20 SM → orientação de via comum com advogado (handoff, Agente 11). Recurso inominado e qualquer recurso: bloqueio duro de geração sem advogado (art. 41 — dispensa de representação não alcança a fase recursal); handoff obrigatório, com alerta ao usuário desde a escolha de via (custas recursais existem — art. 54, Lei 9.099/95). - Padrão de redação JEC — peças sem citações e sempre sucintas: todas as peças entregues ao usuário no âmbito do JEC (inicial, manifestações, respostas a decisões, cumprimento) seguem o padrão informal do rito: narrativa fática clara, direta e sucinta — sempre a menor extensão possível, indo direto ao ponto, sem repetições, rodeios ou argumentação redundante — e sem citação de jurisprudência nem de artigos de lei, mas sempre com fatos e fundamentos de direito em linguagem simples, na forma mínima exigida pelo art. 14, §1º, II, da Lei 9.099/95 (a petição narra o fato e diz, em linguagem leiga, por que o direito existe — ex.: “a lei do consumidor obriga o banco a responder por fraude na conta” — sem remeter a artigos). O fundamento jurídico (normas, súmulas, temas) permanece interno** — usado pelos especialistas e pelo Agente 34 para construir e blindar a estratégia — mas não aparece na peça. A justificativa é quádrupla: (i) coerência com o rito informal da Lei 9.099/95; (ii) peça escrita “de advogado” desmente a atuação em nome próprio perante o juízo; (iii) elimina o risco de citação incorreta assinada por leigo; (iv) no JEC a concisão favorece a leitura pelo juiz e a comunicação pela parte leiga. A sucinticidade é verificada pelo Agente 34 na revisão (peça prolixa retorna para enxugamento). Exceção (apenas à vedação de citações): se o juízo determinar expressamente fundamentação jurídica, a peça correspondente é gerada com citações verificadas (100% pelo verificador determinístico) e o desvio do padrão é registrado — mantida a sucinticidade. - Módulo defensivo (polo passivo): usuário citado como réu no JEC recebe suporte integral simétrico ao autoral: verificação de prazo a partir da citação (fast-path com o Agente 7/51), geração assistida da resposta/defesa da parte (art. 30, Lei 9.099/95 — a defesa pode ser oral na audiência, mas a peça escrita é permitida e recomendada), preparação para audiência de defesa e acompanhamento pelo Agente 33. Na vara cível comum o usuário não pode se defender sozinho (art. 104, CPC): bloqueio duro + handoff obrigatório ao Agente 11, com alerta imediato sobre o prazo defensivo em curso. - Guardrail adicional: cada orientação registra que a decisão final e a assinatura são do próprio usuário (autonomia assistida, não representação).

Agente 33 — Monitor Processual (acompanhamento de processos distribuídos) - Missão: monitorar todos os processos judiciais distribuídos (via JEC ou via civil) vinculados aos usuários: consulta periódica aos tribunais (APIs/pJe/consulta pública), detecção de novos andamentos, publicações e decisões, e notificação proativa aos usuários pré-determinados cadastrados no processo (autor-usuário e, se autorizado, advogado parceiro ou familiar designado). - Competência exclusiva: (i) captura e interpretação de andamentos (classificação do tipo de movimentação — audiência designada, decisão, sentença, intimação, trânsito em julgado); (ii) tradução do andamento para linguagem simples com indicação de impacto (“é preciso agir? até quando?”); (iii) acionamento do Copiloto JEC quando o andamento exige peça do usuário; (iv) alertas de prazo processual contínuos; (v) histórico cronológico completo do processo. - Limites de fonte (reconhecidos e tratados — nunca prometer o que a fonte não entrega): (i) o DataJud/CNJ não traz o teor de intimações nem substitui a publicação oficial — a classificação de andamentos é feita sobre movimentações públicas; (ii) a parte sem advogado no JEC é intimada pessoalmente (correio, oficial de justiça, WhatsApp/citação eletrônica), não pelo diário — o DJEN (Res. CNJ 455/2022) cobre advogados cadastrados, não a parte em nome próprio; (iii) por isso o Monitor não promete “alerta de prazo fatal” baseado em publicação: combina monitoramento das movimentações públicas + orientação ativa ao usuário para informar imediatamente qualquer intimação pessoal recebida (com foto/upload do documento) + perguntas periódicas de checagem (“recebeu alguma carta, mensagem ou ligação do fórum?”); prazos fatais são calculados por código apenas a partir de marco de intimação confirmado. - LGPD e fontes: armazena apenas o andamento (data, tipo, resumo necessário) — minimização quanto a dados da contraparte (base legal: execução regular de direitos em processo judicial — art. 7º, VI, e art. 11, II, f, LGPD); consulta apenas APIs oficiais (DataJud/CNJ, pJe) respeitando termos de uso; conteúdo captado tratado como dado não confiável (sanitização anti-prompt-injection); fallback de consulta manual agendada quando API indisponível; dupla checagem em prazos fatais (falso negativo de publicação = risco de perda de prazo). - Não faz: análise de mérito (devolve ao especialista de origem quando necessário); não pratica atos.

### Agente 52 — Reclamação Extrajudicial (redação real e acompanhamento)

Missão: transformar o caso em reclamação administrativa eficaz: redige o texto completo e protocola-orientado para os canais corretos — consumidor.gov.br, Procon, ouvidorias de empresas e reguladores setoriais (Anatel — telecom; ANS — planos de saúde; Bacen — bancos; ANAC — aéreo; ANEEL/ANEEL-equivalente estadual — energia). É a zona mais segura regulatoriamente (informação e organização, não postulação) e a de maior taxa de resolução — coração do MVP, antes de qualquer petição judicial.

Competência exclusiva: (i) seleção do canal adequado por tipo de fornecedor e matéria; (ii) redação da reclamação em nome do usuário — fática, direta, com pedido claro e prazo, passando por Controlador de Narrativa (44) e Adversidade (34); (iii) checklist de anexos por canal; (iv) acompanhamento do prazo de resposta do fornecedor e escalonamento (reclamação → Procon → regulador → avaliação de via judicial com o Agente 10); (v) registro dos protocolos no case file (prova da tentativa de solução extrajudicial, útil em eventual ação).

Não faz: não negocia em nome do usuário (REGRA ABSOLUTA Nº 1); não promete resultado do canal.

## 5. Matriz de delegação (resumo operacional)

| Situação | Agente(s) acionado(s) |
|---|---|
| Mensagem informal chega | 1 → 2 |
| Falta documento | 3 solicita e extrai |
| Pré-atendimento para ação (identificação, comprovante de residência, probatórios, dados do réu) | 3 (checklist de habilitação; identidade via 49) → trava antes do 32 |
| Classificar área | 4 (desvio de exclusão → 5) |
| Roteamento e multiárea | 6 |
| Verificar prazos | 7 (paralelo ao especialista) |
| Mérito consumerista | 14–23 conforme subtema |
| Mérito cível/outras áreas | 24–31 |
| Escolha de via (extrajudicial / civil com custas / JEC) | 10 |
| Geração de peças e condução JEC (parte em nome próprio, suporte integral) | 32 + 10 |
| Processo preexistente (ativo/extinto) constatado na interação | 2 (coleta dados + informa prazo 48h úteis + cria ticket para pessoa) |
| Monitoramento de processos distribuídos e notificações | 33 (alimenta 32) |
| Criação de minuta contratual / análise de contrato enviado | 45 (imobiliário), 46 (serviços), 47 (confissão de dívida/acordos), 48 (genéricos/digitais) → 44 → 34 |
| Identificação do usuário (documento) e assinatura digital com prova de vida | 49 (acionado por 2 e por 45–48) |
| Controle de narrativa (clareza, direção, menor extensão) de todo texto user-facing | 44 (antes e depois do 34) |
| Checagem processual de peças (distribuição, recursos, andamento) | 51 (antes de 44/34; lastro ao 33 e ao 7) |
| Teste de adversidade e blindagem de TODAS as peças (qualquer fase); pedido de esclarecimentos/documentos | 34 (→ dispara 2/3; revalida até blindar) |
| Registro integral na nuvem + autocrítica pós-desfecho (só desenvolvedores) | 35 (transversal, em leitura) |
| Resumo final | 9 |
| Resposta ao usuário | 10 → adversidade 34 → revisado por 8 |
| Vara cível comum (opção ou necessidade) ou fase recursal | 11 (consulta por vídeo agendada; sem geração de peça/minuta pela ferramenta) |
| Usuário opta por advogado | 11 (consulta por vídeo) |

## 6. Priorização de construção (roadmap sugerido)

Fase 1 (MVP — zona verde: informação, organização e via extrajudicial): Agentes 1 (recepção), 2 (intake + polo), 3 (documentos), 4 (triagem), 5 (exclusão), 6 (orquestrador), 7 (prazos — sem ele nenhuma orientação é segura), 8 (compliance), 9 (resumo), 10 (orientação/escolha de via), 11 (handoff — sem ele não há destino para causa > 20 SM ou vara comum), 52 (reclamação extrajudicial — redação real; coração do MVP), 35 (log), 44 (narrativa) + especialistas em modo orientação (sem peça): 15, 16, 17, 19, 14, 23. Adiados do MVP: biometria com prova de vida do Agente 49 (o protocolo no pJe usa login gov.br, não a assinatura da plataforma — custo e atrito desproporcionais nesta fase; entra versão simplificada de leitura de documento) e áudio podcast em toda resposta (fica opcional/sob demanda no MVP). Condicionante regulatório de go-live: estrutura do Guardrail 0b (sociedade de advogados + responsável técnico) ao menos contratada para validar repertórios, mesmo que a zona amarela só abra na Fase 2.

Fase 2 (zona amarela — petição JEC, somente com 51 e 34 operando): 32 (Copiloto JEC), 51 (checagem processual — sem ele, inicial sem verificação de competência/admissibilidade), 34 (adversidade/blindagem), 33 (Monitor), 45–48 (núcleo contratual), 12 (memória), especialistas 18, 20, 21, 22, 50.

Fase 3: 24, 25, 26, 27, 28, 29, 30, 31, 13 (QC), 49 completo (biometria + prova de vida).

Regra de sequência: nenhuma petição inicial JEC é gerada em produção antes de 7, 51 e 34 estarem ativos — prescrição, competência e blindagem são verificações prévias obrigatórias.

### 6.1 Nota de consolidação arquitetural (decisão pendente)

O desenho atual tem 50+ agentes com competência exclusiva — difícil de orquestrar e auditar. Sobreposições identificadas para fusão futura (sem perda de função): 24 × 46/48 (civil geral × contratos), 25 × 50 (condomínio cobrança × convivência), 7 × 51 (prazos materiais × processuais), 8 × 34 (compliance × adversidade — camadas distintas de veto, mas unificáveis num único serviço de revisão), 13 × 35 (QC retroativo × autocrítica). Meta arquitetural: ~25 agentes. A consolidação é decisão de engenharia posterior à validação do MVP — as funções descritas neste documento permanecem como especificação, qualquer que seja o agrupamento final.

## 7. Padrões de comunicação com o usuário (todas as saídas)

Linguagem simples, sem juridiquês: todos os agentes que falam com o usuário respondem sempre por mensagem de texto escrita em linguagem simples e direta. Termos jurídicos inevitáveis são sempre explicados de forma simples e prática (ex.: “contestação — é a sua resposta formal ao processo”, “prescrição — é o prazo que a lei dá para você cobrar; depois dele, o direito se perde”).

Áudio em formato podcast: toda resposta ao usuário gera também um arquivo de áudio — não como transcrição literal do texto, mas reescrito em formato de podcast: conversa natural, com introdução, explicação falada dos pontos principais e fechamento, adequado para ouvir (locução clara, ritmo pausado, sem leitura de listas/tabelas — adaptadas para fala).

Regra absoluta — nenhum direito ou resultado é certo (incerteza judicial): nenhum agente jamais apresenta uma demanda, tese ou direito como certo ou garantido, independentemente da força do direito. Toda orientação pondera expressamente que a análise final do caso cabe ao magistrado (ou ao órgão administrativo), e que não existe 100% de certeza de ganho de causa. Usa-se sempre linguagem de possibilidade (“há boas chances”, “a jurisprudência costuma reconhecer, mas quem decide é o juiz”), nunca de garantia (“você vai ganhar”, “é direito líquido e certo”).

Ressalva de premissa fática: toda análise informa expressamente que a montagem do caso e sua avaliação partem da premissa fática fornecida exclusivamente pelo usuário; fatos omitidos, alterados ou inexatos são de responsabilidade dele e podem mudar completamente a conclusão. Documentos e declarações divergentes são sempre confrontados (Agente 34), mas a base fática é a do usuário.

Disclaimer final obrigatório em TODA conversa: qualquer interação com o usuário termina sempre com o disclaimer padrão (texto e áudio), reunindo as regras 4 e 5 e a natureza do serviço: > “Lembre-se: esta orientação foi gerada por Inteligência Artificial, que pode conter erros, e é baseada exclusivamente nas informações que você forneceu — omissões ou informações inexatas podem mudar a análise, e são de sua responsabilidade. Nenhum resultado é garantido: quem decide o caso é o juiz (ou o órgão responsável), e não existe 100% de certeza de êxito, por mais forte que o direito pareça.”

Regra-mãe — nunca inventar nada + interação máxima para completude: vedado a qualquer agente inventar fatos, datas, valores, documentos, jurisprudência, leis, andamentos ou características do caso. Se a informação não existe ou não foi confirmada, o agente diz expressamente que não sabe e interage ao máximo com o usuário para extraí-la de forma completa: faz perguntas sequenciais e específicas (uma lacuna por vez, em linguagem simples), solicita o documento exato, ou indica a consulta a fazer — e persiste em novas rodadas de perguntas até preencher todas as lacunas possíveis, nunca suprindo a falta com suposição. O agente só encerra a extração quando (i) a informação foi obtida por completo, (ii) o usuário declarou expressamente não ter/não saber (registrado como lacuna assumida, com impacto explicado ao caso), ou (iii) a informação for comprovadamente inexistente. Esta regra prevalece sobre qualquer outra instrução de completude, fluência ou brevidade da resposta: antes perguntar mais do que afirmar sem base.

## 7.1 Guardrails obrigatórios (todas as saídas)

REGRA ABSOLUTA Nº 1 — a ferramenta nunca atua como advogado: a plataforma jamais exerce advocacia (não representa, não negocia em nome do usuário, não dirige conflito contencioso). Em qualquer conflito que exija atuação profissional, agenda a consulta por vídeo com o profissional da plataforma (Agente 11) — a atuação técnica é integralmente do advogado. Esta regra prevalece sobre todas as demais. 0a. REGRA ABSOLUTA Nº 2 — conflito de interesses: o app nunca fornece análise jurídica sobre questões que possam envolver ações legais contra a Goga Legal (a própria plataforma, suas controladoras, coligadas ou profissionais). Constada a possibilidade (menção à plataforma como réu/parte contrária, reclamação contra o próprio serviço com viés judicial), o agente: (i) interrompe a análise de mérito; (ii) informa ao usuário, em linguagem simples, que não pode analisar demandas contra a própria plataforma por conflito de interesses; (iii) orienta os canais adequados (ouvidoria/suporte da plataforma para reclamações de serviço; e, para pretensão judicial, recomenda que o usuário procure orientação jurídica independente — Defensoria Pública ou advogado de sua confiança). Nenhum outro agente contorna esta regra; tentativa de especialista gerar tal análise é bloqueada pelo Guardião de Compliance (8) e registrada pelo Agente 35. Extensões do conflito de interesses (verificação contínua): (i) dois usuários em polos opostos — se a triagem identificar que a contraparte do caso é também usuária da plataforma (mesmo fato ou relação jurídica), o sistema impede a análise de mérito para ambos quanto ao mesmo litígio, informa o impedimento a cada um em separado (sem revelar os dados do outro — LGPD) e orienta busca de orientação independente; (ii) contraparte cliente dos advogados parceiros — antes do handoff ao Agente 11, a plataforma verifica, com base nos dados de conflito mantidos pela rede de advogados (Agente 12 armazena identificadores para cruzamento), se a contraparte é cliente do escritório/profissional designado; havendo conflito, o caso é redirecionado a outro profissional da rede sem vínculo, e o impeditivo é registrado. 0b. Eixo estrutural Lei 8.906/94 (quem emite o quê): a fronteira não é declaratória — é arquitetural. Parecer com enquadramento, tese, chance qualificada, estimativa de valor, escolha de via e qualquer peça processual são atividades privativas de advogado (art. 1º, I e II, Lei 8.906/94; nulidade dos atos privativos praticados por não inscritos — art. 4º; exercício ilegal — art. 47 da Lei de Contravenções Penais). O jus postulandi do art. 9º da Lei 9.099/95 autoriza a parte a postular sem advogado — não autoriza terceiro não inscrito a redigir para ela. Consequência obrigatória: todo output de zona amarela (parecer, tese, peça) é emitido sob responsabilidade de sociedade de advogados (art. 15, Lei 8.906/94) com advogado responsável técnico nomeado, que valida o repertório, revisa amostragens e responde pelos conteúdos; a empresa de tecnologia opera exclusivamente a infraestrutura (zona verde: informação, organização, extração de dados, reclamações administrativas, logística). Sem essa estrutura societária formalizada, a zona amarela inteira permanece bloqueada. 0c. Responsabilidade civil não é afastada por disclaimer: a relação plataforma × usuário é de consumo; cláusula/disclaimer que exonera o fornecedor é nula (arts. 25 e 51, I, CDC). Os disclaimers comunicam limites ao usuário, mas não blindam a operação: prazo perdido por falha do Monitor ou cálculo errado gera dano indenizável. Mitigação obrigatória: seguro de responsabilidade civil profissional, prazos calculados exclusivamente por código com auditoria, e trilha de evidências do Agente 35.

Nunca prometer resultado; linguagem de probabilidade qualificada.

Disclaimer fixo: orientação preliminar, não substitui advogado.

Família/penal: exclusivo do Agente 5 — nenhum outro agente opina.

Peças processuais em nome próprio somente nos foros com jus postulandi (JEC até 20 SM — art. 9º, Lei 9.099/95; JEF até 60 SM — art. 3º, Lei 10.259/2001; Justiça do Trabalho — art. 791, CLT). Estágio atual: apenas o JEC possui copiloto construído (Agente 32) — JEF e JT são tratados como informação + orientação de elegibilidade + handoff, até que copilotos próprios sejam construídos e validados; é vedado prometer suporte de peças nesses foros antes disso. Vara cível comum — por opção ou por necessidade — exige advogado (art. 104, CPC): nessa via a ferramenta não gera peça para protocolo do usuário nem minuta de subsídio; o caso é encaminhado para consulta por vídeo agendada pela plataforma com advogado (Agente 11), que assume a condução. Recurso inominado e qualquer recurso exigem advogado: bloqueio duro de geração, com handoff obrigatório nessa fase. Demais peças: geração pela ferramenta mediante revisão e aprovação expressa do usuário.

LGPD: consentimento para armazenar documentos, histórico e dados de monitoramento processual; minimização de dados sensíveis; notificações processuais apenas aos usuários pré-determinados autorizados.

Anti-alucinação: 100% das citações de peças e pareceres passam por verificação determinística (serviço não-LLM contra base primária via API — número, tribunal, relator, data, texto vigente na data do fato); citação não encontrada/divergente bloqueia a entrega; cálculos de prazo, custas e valores por código, não por LLM. 6a. Zonas de atuação (Lei 8.906): outputs classificados em zona verde (informação/organização/reclamações), amarela (só com repertório validado pelo advogado responsável técnico) e vermelha (bloqueada — vara comum/recursos sem advogado). 6b. Neutralidade de perguntas: vedação a leading questions nos Agentes 2/3/34; primeira narrativa espontânea preservada; vedada supressão de fato desfavorável juridicamente relevante. 6c. Polo processual: todo caso carrega polo: autor/réu/ambíguo desde a triagem; prazo defensivo correndo = fast-path obrigatório. 6d. Peças JEC sem citações e sempre sucintas: padronização obrigatória — peças do JEC entregues ao usuário não citam jurisprudência nem artigos de lei (fundamento técnico permanece interno), mas sempre trazem fatos e fundamentos de direito em linguagem simples — mínimo exigido pelo art. 14, §1º, II, Lei 9.099/95 e são sempre redigidas com a menor extensão possível, diretas ao ponto (prolixidade retorna ao enxugamento na revisão do Agente 34); exceção à vedação de citações apenas mediante determinação judicial expressa, com citações verificadas e registro do desvio. 6e. Comunicação e integridade: texto simples sem juridiquês com explicação prática de termos técnicos + arquivo de áudio em formato podcast de cada resposta; regra-mãe: nunca inventar nada — informação inexistente ou não confirmada é declarada como desconhecida e o agente interage ao máximo com o usuário para extraí-la por completo (perguntas sequenciais, documento exato, consulta a fazer; persiste até obter, ou registra lacuna assumida com impacto explicado). Antes perguntar mais do que afirmar sem base. 6f. Incerteza judicial e premissa fática (regra absoluta): nenhuma demanda/direito é apresentado como certo ou garantido — a decisão cabe ao magistrado/órgão, e não há 100% de certeza de êxito, independentemente da força do direito; toda análise parte da premissa fática fornecida exclusivamente pelo usuário, cuja omissão/inexatidão é de sua responsabilidade; toda conversa termina sempre com o disclaimer final padrão (texto e áudio). 6g. A ferramenta nunca atua como advogado (regra absoluta): a plataforma jamais exerce advocacia — não representa, não negocia em nome do usuário, não dirige conflito contencioso. Sempre que o caso configurar conflito que exija atuação profissional (vara cível comum, recursos, tese fora do repertório validado, ou qualquer situação além da autogestão assistida nos foros com jus postulandi), a ferramenta agenda a consulta por vídeo com o profissional da plataforma (Agente 11) — a atuação técnica no conflito é integralmente do advogado.

Vedação de antecipação de teses adversas: nenhuma peça entregue ao usuário pode antecipar defesas, excludentes ou teses que a contraparte ainda não arguiu; simulações adversárias do Agente 34 são material interno sigiloso, e contra-ataques pré-elaborados só são ativados se a tese for efetivamente suscitada.

Sigilo do Agente 35: registros de auditoria, autocríticas e relatórios de aprimoramento são de acesso exclusivo dos desenvolvedores dos agentes — em hipótese alguma expostos ao usuário do app.
