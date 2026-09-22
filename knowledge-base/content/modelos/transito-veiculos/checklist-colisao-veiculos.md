---
type: Modelo
title: "Checklist de documentos: colisão de veículos"
description: "Checklist obrigatório do Agente 54 antes de qualquer parecer, notificação ou petição."
tags: [modelo, checklist, colisao, agente-54]

auditoria:
  status: modelo-sem-revisao
  fonte: "planning/00-MVP-PLANO.md — §5.4, item 6"
  conferido_por: "curadoria"

modelo:
  slug: checklist-colisao-veiculos
  campos:
    - {nome: nome_usuario, rotulo: "Nome do usuário", obrigatorio: true}
    - {nome: data, rotulo: "Data (preenchida automaticamente)", obrigatorio: false}
---

# Checklist de documentos: colisão de veículos

Checklist obrigatório do Agente 54 antes de qualquer parecer, notificação ou petição.

## Como conduzir

Tirado da especificação do Agente 54 (`research/Agentes_53_54_Via_Publica_Colisao_Veiculos.md`). O agente pede um item por vez, confere cada um (legível, com data, pertinente) e mantém o status visível ao usuário, por exemplo: "faltam 2 itens: os orçamentos e o boletim de ocorrência".

## Modelo

**Checklist de documentos: colisão de veículos**

Usuário: {{nome_usuario}}. Conferido em {{data}}.

Marque cada item conforme for entregue. Nenhuma reclamação, notificação ou petição é gerada com a lista incompleta, salvo lacuna assumida e registrada pelo usuário.

- [ ] Boletim de ocorrência, registrado o quanto antes (presencial ou pela delegacia eletrônica)
- [ ] Fotos do local (posição final dos veículos, marcas de frenagem, sinalização, semáforo) e dos danos nos dois veículos
- [ ] No mínimo três orçamentos de oficinas diferentes para o reparo
- [ ] Dados do outro condutor e veículo: nome, CPF, CNH, placa, RENAVAM, seguradora e telefone
- [ ] CNH do usuário e CRLV do veículo dele
- [ ] Testemunhas (nome e contato)
- [ ] Filmagens, se houver (próprias, de terceiros, câmeras do local) e prints de conversa com o outro condutor
- [ ] Documentos médicos ou laudo do IML, se houve lesão corporal
- [ ] Comprovante de renda, se o pedido incluir lucro cessante por uso profissional do veículo
- [ ] Apólice de seguro do usuário ou do outro condutor, se houver
