---
type: Modelo
title: "Notificação extrajudicial"
description: "Notificação formal a uma empresa ou pessoa, com prazo para cumprir o pedido."
tags: [modelo, notificacao]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: notificacao-extrajudicial
  campos:
    - {nome: nome_notificante, rotulo: "Nome completo de quem notifica", obrigatorio: true}
    - {nome: cpf_notificante, rotulo: "CPF de quem notifica", obrigatorio: true}
    - {nome: endereco_notificante, rotulo: "Endereço de quem notifica", obrigatorio: true}
    - {nome: empresa, rotulo: "Nome da empresa ou pessoa notificada", obrigatorio: true}
    - {nome: endereco_notificado, rotulo: "Endereço da notificada", obrigatorio: true}
    - {nome: fatos, rotulo: "O que aconteceu, em ordem, com datas", obrigatorio: true}
    - {nome: pedido, rotulo: "O que a notificada deve fazer", obrigatorio: true}
    - {nome: prazo_dias, rotulo: "Prazo, em dias, para cumprir o pedido", obrigatorio: true}
    - {nome: cidade, rotulo: "Cidade", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Notificação extrajudicial

Modelo de notificação extrajudicial para pedir, por escrito e com prazo, que a outra parte cumpra algo antes de qualquer medida judicial.

## Quando usar

Quando a reclamação nos canais não resolveu, ou quando a outra parte não tem canal (pessoa física, pequena empresa). Serve como prova de que a outra parte foi avisada.

## Antes de enviar

- envie por um meio que gere comprovante de entrega (carta com aviso de recebimento, e-mail com confirmação de leitura ou cartório de títulos e documentos);
- guarde uma cópia assinada e o comprovante;
- o tom é firme e sem ameaça: não prometa ação judicial nem resultado.

## Modelo

**NOTIFICAÇÃO EXTRAJUDICIAL**

**Notificante:** {{nome_notificante}}, CPF {{cpf_notificante}}, residente em {{endereco_notificante}}.

**Notificada:** {{empresa}}, com endereço em {{endereco_notificado}}.

Pela presente, venho NOTIFICAR Vossa Senhoria sobre os fatos a seguir.

**Dos fatos**

{{fatos}}

**Do pedido**

{{pedido}}

Solicito que o pedido seja atendido no prazo de {{prazo_dias}} dias, contados do recebimento desta notificação, e que a resposta seja enviada por escrito ao endereço acima. Esta notificação fica registrada como prova de que Vossa Senhoria foi informada dos fatos e do pedido.

{{cidade}}, {{data}}.

{{nome_notificante}}
CPF {{cpf_notificante}}
