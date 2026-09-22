# kb-api — imagem do servico.
#
# Duas decisoes que moldam esta imagem:
#
# 1. **torch CPU-only.** O docling traz torch (modelos de layout e de tabela).
#    O wheel default arrasta as bibliotecas CUDA e o site-packages fica em
#    6,2 GB; com o indice cpu do PyTorch cai para 1,8 GB. Nao ha GPU no cluster
#    local nem no alvo, entao CUDA e peso morto.
# 2. **modelos do docling baixados no BUILD.** Sem isso o primeiro documento de
#    cada pod dispara o download dos modelos, e a primeira ingestao parece
#    travada. Assar na imagem troca minutos de espera em runtime por camada.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # O docling guarda os modelos aqui; fixamos para a camada do build valer em runtime.
    HF_HOME=/opt/models \
    DOCLING_ARTIFACTS_PATH=/opt/models/docling

# libgomp1: runtime do OpenMP, exigido pelo torch CPU.
# libxcb1/libgl1/libglib2.0-0: o docling arrasta opencv_python (variante com GUI),
# e sem essas libs o import falha com "libxcb.so.1: cannot open shared object
# file" -- o que quebrava o download dos modelos no build.
# tesseract e o motor de OCR, e ele entra como BINARIO de sistema, nao como
# pacote Python. A alternativa (easyocr) carregaria mais um modelo dentro do
# mesmo processo do uvicorn -- e este pod ja foi OOMKilled por carregar modelo
# duas vezes. O tesseract roda como subprocesso, devolve o texto e morre.
# O pacote `-por` e o que faz o OCR ler portugues; sem ele o acento vira ruido.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgomp1 libxcb1 libgl1 libglib2.0-0 curl \
        tesseract-ocr tesseract-ocr-por tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && tesseract --list-langs

WORKDIR /app

# torch E torchvision do MESMO indice CPU, na mesma chamada. Instalar so o
# torch aqui deixava o docling puxar torchvision do PyPI (build CUDA), e o par
# incompativel quebra o registro de operadores:
#   RuntimeError: operator torchvision::nms does not exist
# O sintoma final e enganoso: `AutoImageProcessor` do transformers falha com
# "Could not import module", o docling nao carrega o modelo de layout e TODO PDF
# cai no fallback pymupdf -- sem erro visivel na ingestao.
RUN pip install --no-cache-dir "torch>=2.4" "torchvision>=0.19" \
    --index-url https://download.pytorch.org/whl/cpu

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Modelos do docling na imagem (ver decisao 2). `|| true`: sem rede no build, a
# imagem ainda serve — o docling baixa em runtime e os extratores leves cobrem.
# `output_dir` exige Path, nao str — passar string levanta
# AttributeError: 'str' object has no attribute 'mkdir'.
RUN mkdir -p "$DOCLING_ARTIFACTS_PATH" \
    && python -c "\
from pathlib import Path; \
from docling.utils.model_downloader import download_models; \
download_models(output_dir=Path('$DOCLING_ARTIFACTS_PATH'))" \
    || echo "AVISO: modelos do docling nao foram baixados no build"

EXPOSE 8080

# UM worker, nao dois. Cada worker uvicorn e um processo separado e carrega a
# PROPRIA copia dos modelos de layout do docling (~700 MB cada): com dois, o pod
# foi OOMKilled no meio da ingestao de PDF. A ingestao e sincrona e sequencial
# nesta v0, entao o segundo worker so somava memoria.
CMD ["uvicorn", "kb_api.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
