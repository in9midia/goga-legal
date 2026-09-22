---
type: Modelo
title: "Reclamação — consumidor.gov.br"
description: "Modelo de reclamação para consumidor.gov.br."
tags: [modelo, reclamacao, consumidor-gov]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: reclamacao-consumidor-gov
  campos:
    - {nome: nome_consumidor, rotulo: "Nome completo do consumidor", obrigatorio: true}
    - {nome: cpf_consumidor, rotulo: "CPF do consumidor", obrigatorio: true}
    - {nome: contato_consumidor, rotulo: "Telefone ou e-mail para resposta", obrigatorio: true}
    - {nome: empresa, rotulo: "Nome da empresa reclamada", obrigatorio: true}
    - {nome: fatos, rotulo: "O que aconteceu, em ordem, com datas", obrigatorio: true}
    - {nome: pedido, rotulo: "O que o consumidor quer que a empresa faça", obrigatorio: true}
    - {nome: documentos_anexos, rotulo: "Documentos que vão anexados (nota fiscal, prints, contrato, faturas)", obrigatorio: true}
    - {nome: cidade, rotulo: "Cidade", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Reclamação — consumidor.gov.br

Modelo de reclamação para consumidor.gov.br. É o canal público federal em que a empresa cadastrada responde diretamente ao consumidor.

## Quando usar

Quando a empresa reclamada é participante do consumidor.gov.br. A plataforma mostra, na busca, se a empresa está cadastrada. Se não estiver, use o modelo do Procon.

## Antes de enviar

As orientações de canal acima descrevem o procedimento como ele é divulgado pelo próprio órgão e podem mudar. Antes de enviar, confira no site oficial do canal. O modelo não cita artigo de lei de propósito: reclamação administrativa se resolve pelos fatos e pelo pedido, e citação errada só enfraquece o texto.

- escreva os fatos em ordem cronológica, com data de cada contato;
- diga um pedido concreto (cancelar, estornar, consertar, trocar, devolver valor);
- guarde o número do protocolo que o canal gerar.

## Modelo

**Reclamação — consumidor.gov.br**

**Consumidor:** {{nome_consumidor}}, CPF {{cpf_consumidor}}

**Empresa reclamada:** {{empresa}}

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
