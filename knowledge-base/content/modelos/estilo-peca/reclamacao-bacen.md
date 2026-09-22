---
type: Modelo
title: "Reclamação — Banco Central (Bacen)"
description: "Modelo de reclamação para o Banco Central."
tags: [modelo, reclamacao, bacen, bancario]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: reclamacao-bacen
  campos:
    - {nome: nome_consumidor, rotulo: "Nome completo do consumidor", obrigatorio: true}
    - {nome: cpf_consumidor, rotulo: "CPF do consumidor", obrigatorio: true}
    - {nome: contato_consumidor, rotulo: "Telefone ou e-mail para resposta", obrigatorio: true}
    - {nome: empresa, rotulo: "Nome da empresa reclamada", obrigatorio: true}
    - {nome: fatos, rotulo: "O que aconteceu, em ordem, com datas", obrigatorio: true}
    - {nome: agencia_conta, rotulo: "Agência e conta, ou número do contrato", obrigatorio: false}
    - {nome: protocolo_anterior, rotulo: "Número do protocolo do atendimento anterior na empresa", obrigatorio: true}
    - {nome: pedido, rotulo: "O que o consumidor quer que a empresa faça", obrigatorio: true}
    - {nome: documentos_anexos, rotulo: "Documentos que vão anexados (nota fiscal, prints, contrato, faturas)", obrigatorio: true}
    - {nome: cidade, rotulo: "Cidade", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Reclamação — Banco Central (Bacen)

Modelo de reclamação para o Banco Central. O Banco Central recebe reclamações contra bancos e instituições financeiras.

## Quando usar

Depois de reclamar no SAC e na ouvidoria do banco. O Banco Central registra a reclamação e a encaminha à instituição.

## Antes de enviar

As orientações de canal acima descrevem o procedimento como ele é divulgado pelo próprio órgão e podem mudar. Antes de enviar, confira no site oficial do canal. O modelo não cita artigo de lei de propósito: reclamação administrativa se resolve pelos fatos e pelo pedido, e citação errada só enfraquece o texto.

- escreva os fatos em ordem cronológica, com data de cada contato;
- diga um pedido concreto (cancelar, estornar, consertar, trocar, devolver valor);
- guarde o número do protocolo que o canal gerar.

## Modelo

**Reclamação — Banco Central (Bacen)**

**Consumidor:** {{nome_consumidor}}, CPF {{cpf_consumidor}}

**Empresa reclamada:** {{empresa}}

**Agência e conta, ou contrato:** {{agencia_conta}}

**Protocolo do atendimento anterior na empresa:** {{protocolo_anterior}}

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
