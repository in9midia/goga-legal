---
type: Modelo
title: "Reclamação — Procon"
description: "Modelo de reclamação para o Procon."
tags: [modelo, reclamacao, procon]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: reclamacao-procon
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

# Reclamação — Procon

Modelo de reclamação para o Procon. O Procon é o órgão estadual ou municipal de defesa do consumidor.

## Quando usar

Quando a empresa não está no consumidor.gov.br, ou quando a tentativa por lá não resolveu. Cada Procon tem seu próprio canal (site, aplicativo ou atendimento presencial).

## Antes de enviar

As orientações de canal acima descrevem o procedimento como ele é divulgado pelo próprio órgão e podem mudar. Antes de enviar, confira no site oficial do canal. O modelo não cita artigo de lei de propósito: reclamação administrativa se resolve pelos fatos e pelo pedido, e citação errada só enfraquece o texto.

- escreva os fatos em ordem cronológica, com data de cada contato;
- diga um pedido concreto (cancelar, estornar, consertar, trocar, devolver valor);
- guarde o número do protocolo que o canal gerar.

## Modelo

**Reclamação — Procon**

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
