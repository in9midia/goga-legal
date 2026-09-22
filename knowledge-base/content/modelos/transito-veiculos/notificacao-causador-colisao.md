---
type: Modelo
title: "Notificação amigável ao causador (colisão de veículos)"
description: "Notificação amigável ao condutor ou proprietário do veículo que causou a colisão (Agente 54)."
tags: [modelo, notificacao, colisao, agente-54]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: notificacao-causador-colisao
  campos:
    - {nome: nome_notificante, rotulo: "Nome completo de quem notifica", obrigatorio: true}
    - {nome: cpf_notificante, rotulo: "CPF de quem notifica", obrigatorio: true}
    - {nome: contato_notificante, rotulo: "Telefone ou e-mail para resposta", obrigatorio: true}
    - {nome: nome_causador, rotulo: "Nome do outro condutor ou do proprietário do veículo", obrigatorio: true}
    - {nome: endereco_causador, rotulo: "Endereço do outro condutor ou proprietário", obrigatorio: true}
    - {nome: placa_causador, rotulo: "Placa do veículo do outro condutor", obrigatorio: true}
    - {nome: seguradora_causador, rotulo: "Seguradora do outro veículo, se houver", obrigatorio: false}
    - {nome: data_acidente, rotulo: "Data e hora do acidente", obrigatorio: true}
    - {nome: local_acidente, rotulo: "Local exato do acidente", obrigatorio: true}
    - {nome: fatos, rotulo: "Como o acidente aconteceu", obrigatorio: true}
    - {nome: numero_bo, rotulo: "Número do boletim de ocorrência", obrigatorio: false}
    - {nome: valor_menor_orcamento, rotulo: "Valor do menor dos três orçamentos (R$)", obrigatorio: true}
    - {nome: prazo_dias, rotulo: "Prazo, em dias, para resposta", obrigatorio: true}
    - {nome: cidade, rotulo: "Cidade", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Notificação amigável ao causador (colisão de veículos)

Modelo de notificação amigável ao causador de colisão entre veículos de particulares, na ordem de via da pesquisa dos Agentes 53 e 54 (seguro do causador, notificação amigável, depois Juizado). É zona verde: organiza o pedido, não afirma culpa em tese jurídica.

## Antes de enviar

- conclua o checklist de documentos da colisão (modelo `checklist-colisao-veiculos`);
- use o menor dos três orçamentos, que é o critério que menos se discute;
- se houve lesão corporal, não use este modelo: o caso vai para atendimento com advogado.

## Modelo

**NOTIFICAÇÃO AMIGÁVEL — ACIDENTE DE TRÂNSITO**

**De:** {{nome_notificante}}, CPF {{cpf_notificante}}

**Para:** {{nome_causador}}, com endereço em {{endereco_causador}}, condutor ou proprietário do veículo de placa {{placa_causador}}

**Do acidente**

Em {{data_acidente}}, no local {{local_acidente}}, houve colisão entre o meu veículo e o veículo de placa {{placa_causador}}. {{fatos}}

Boletim de ocorrência: {{numero_bo}}.

**Dos danos**

Obtive três orçamentos de oficinas diferentes para o reparo do meu veículo. O menor deles é de R$ {{valor_menor_orcamento}}, e as cópias dos três seguem anexas, junto com as fotos do local e dos danos.

**Do pedido**

Proponho resolver de forma amigável: peço o pagamento do valor do reparo, ou o acionamento do seu seguro ({{seguradora_causador}}), com resposta em até {{prazo_dias}} dias a partir do recebimento desta notificação, pelo contato {{contato_notificante}}.

{{cidade}}, {{data}}.

{{nome_notificante}}
CPF {{cpf_notificante}}
