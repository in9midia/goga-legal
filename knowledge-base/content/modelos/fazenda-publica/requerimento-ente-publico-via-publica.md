---
type: Modelo
title: "Requerimento administrativo ao ente público (dano por defeito em via pública)"
description: "Reclamação administrativa prévia ao município, estado, DER ou concessionária por dano causado por buraco ou defeito na via (Agente 53)."
tags: [modelo, requerimento, via-publica, agente-53]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: requerimento-ente-publico-via-publica
  campos:
    - {nome: nome_requerente, rotulo: "Nome completo de quem requer", obrigatorio: true}
    - {nome: cpf_requerente, rotulo: "CPF de quem requer", obrigatorio: true}
    - {nome: endereco_requerente, rotulo: "Endereço de quem requer", obrigatorio: true}
    - {nome: contato_requerente, rotulo: "Telefone ou e-mail para resposta", obrigatorio: true}
    - {nome: ente_responsavel, rotulo: "Órgão ou concessionária responsável pela via", obrigatorio: true}
    - {nome: data_fato, rotulo: "Data e hora do fato", obrigatorio: true}
    - {nome: local_fato, rotulo: "Local exato (rua, número ou altura, sentido, referência)", obrigatorio: true}
    - {nome: fatos, rotulo: "Como o fato aconteceu e como estava a via (buraco, sinalização, iluminação)", obrigatorio: true}
    - {nome: placa_veiculo, rotulo: "Placa do veículo", obrigatorio: true}
    - {nome: valor_menor_orcamento, rotulo: "Valor do menor dos três orçamentos (R$)", obrigatorio: true}
    - {nome: protocolo_anterior, rotulo: "Protocolo de reclamação já feita (156, ouvidoria, SAC)", obrigatorio: false}
    - {nome: cidade, rotulo: "Cidade", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Requerimento administrativo ao ente público (dano por defeito em via pública)

Modelo de reclamação administrativa prévia ao ente responsável pela via (Agente 53, conduzido pelo Agente 52). A pesquisa registra que ela não é condição para ação judicial, mas fortalece a prova de que o responsável sabia do defeito.

## Antes de enviar

- identifique o responsável pela via e registre como identificou; não presuma (municipal, estadual, federal ou concedida);
- conclua o checklist de documentos (modelo `checklist-via-publica`);
- o prazo para agir contra o poder público é diferente do prazo contra concessionária privada: ele é calculado pelo agente de prazos, não por este modelo.

## Modelo

**REQUERIMENTO ADMINISTRATIVO**

**Ao órgão:** {{ente_responsavel}}

**Requerente:** {{nome_requerente}}, CPF {{cpf_requerente}}, residente em {{endereco_requerente}}, contato {{contato_requerente}}.

**Do fato**

Em {{data_fato}}, no local {{local_fato}}, o veículo de placa {{placa_veiculo}} sofreu danos em razão de defeito na via. {{fatos}}

Protocolo de reclamação anterior: {{protocolo_anterior}}.

**Dos danos**

Seguem anexos fotos do defeito da via e dos danos ao veículo, três orçamentos de oficinas diferentes (o menor é de R$ {{valor_menor_orcamento}}), CRLV e CNH.

**Do pedido**

Requeiro o ressarcimento do valor do reparo e o registro deste requerimento, com número de protocolo e resposta por escrito.

{{cidade}}, {{data}}.

{{nome_requerente}}
CPF {{cpf_requerente}}
