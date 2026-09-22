"""Scripts de build do kb-api, chamados pelo pipeline.

Ficam FORA de `src/` de proposito: sao ferramenta de CI, nao codigo que sobe na
imagem. O pipeline compartilhado (`microservices-build-multicloud-pipeline-python`)
chama `python -m scripts.check` e `python -m scripts.test` -- os nomes sao
contrato do template, nao escolha nossa.
"""
