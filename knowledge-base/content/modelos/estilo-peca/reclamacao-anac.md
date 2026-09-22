---
type: Modelo
title: "Reclamação — ANAC"
description: "Modelo de reclamação para a ANAC."
tags: [modelo, reclamacao, anac, aereo]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: reclamacao-anac
  campos:
    - {nome: nome_consumidor, rotulo: "Nome completo do consumidor", obrigatorio: true}
    - {nome: cpf_consumidor, rotulo: "CPF do consumidor", obrigatorio: true}
    - {nome: contato_consumidor, rotulo: "Telefone ou e-mail para resposta", obrigatorio: true}
    - {nome: empresa, rotulo: "Nome da empresa reclamada", obrigatorio: true}
    - {nome: fatos, rotulo: "O que aconteceu, em ordem, com datas", obrigatorio: true}
    - {nome: voo, rotulo: "Número do voo, data e trecho", obrigatorio: true}
    - {nome: localizador, rotulo: "Código da reserva (localizador)", obrigatorio: false}
    - {nome: pedido, rotulo: "O que o consumidor quer que a empresa faça", obrigatorio: true}
    - {nome: documentos_anexos, rotulo: "Documentos que vão anexados (nota fiscal, prints, contrato, faturas)", obrigatorio: true}
    - {nome: cidade, rotulo: "Cidade", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Reclamação — ANAC

Modelo de reclamação para a ANAC. A ANAC regula o transporte aéreo.

## Quando usar

Para atraso, cancelamento, overbooking, bagagem ou reembolso de passagem aérea. A ANAC orienta o passageiro a registrar a reclamação contra a companhia pelo consumidor.gov.br; confira o canal vigente no site da ANAC antes de enviar.

## Antes de enviar

As orientações de canal acima descrevem o procedimento como ele é divulgado pelo próprio órgão e podem mudar. Antes de enviar, confira no site oficial do canal. O modelo não cita artigo de lei de propósito: reclamação administrativa se resolve pelos fatos e pelo pedido, e citação errada só enfraquece o texto.

- escreva os fatos em ordem cronológica, com data de cada contato;
- diga um pedido concreto (cancelar, estornar, consertar, trocar, devolver valor);
- guarde o número do protocolo que o canal gerar.

## Modelo

**Reclamação — ANAC**

**Consumidor:** {{nome_consumidor}}, CPF {{cpf_consumidor}}

**Empresa reclamada:** {{empresa}}

**Voo, data e trecho:** {{voo}}

**Localizador:** {{localizador}}

**O que aconteceu**

{{fatos}}

**O que eu peço**

{{pedido}}

**Documentos anexados**

{{documentos_anexos}}

Peço que a empresa responda por este canal no prazo informado pelo próprio canal.

{{cidade}}, {{data}}.

{{nome_consumidor}}
CPF {{cpf_consumidor}}
Contato: {{contato_consumidor}}
