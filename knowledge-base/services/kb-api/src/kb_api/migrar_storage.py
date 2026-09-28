"""Copia o acervo do object storage atual para outro bucket S3 (ex.: MinIO → AWS S3).

    python -m kb_api.migrar_storage [--dry-run] [--verificar] [--paralelo 8]

ORIGEM  e a loja que este processo usaria hoje: `KB_STORAGE_BACKEND` + `S3_*`
        (ou `KB_STORAGE_DIR`). Rodando com o ambiente do kb-api, e o MinIO.
DESTINO e lido de `DEST_S3_*`, pela MESMA regra de padroes da origem
        (`config.s3_config`), com `DEST_S3_PROVIDER=aws` como padrao.

O que torna seguro rodar mais de uma vez:

- **idempotente.** Objeto que ja esta no destino com o mesmo tamanho e pulado.
  O bruto e imutavel (ADR-0008: a chave carrega o sha256), entao mesmo tamanho
  na mesma chave e o mesmo conteudo -- nao ha por que baixar para comparar;
- **nunca apaga.** Nem na origem, nem no destino. O que existir so no destino
  aparece no relatorio do `--verificar`, e a decisao fica com quem opera;
- **retomavel.** Caiu no meio, roda de novo: o que ja foi, e pulado.

A virada recomendada e: rodar com o sistema no ar (copia o grosso), pausar a
ingestao, rodar de novo (copia a diferenca), trocar a configuracao para o
destino, e so entao aposentar a origem. Ver `docs/operacao.md`.

Codigo de saida: 0 tudo certo; 1 houve falha de copia ou divergencia no
`--verificar`; 2 configuracao invalida.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

from . import storage
from .config import s3_config


@dataclass
class Placar:
    copiados: int = 0
    pulados: int = 0
    falhas: list[tuple[str, str]] = field(default_factory=list)
    bytes_copiados: int = 0
    trava: threading.Lock = field(default_factory=threading.Lock)


def _humano(n: float) -> str:
    for unidade in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unidade}" if unidade == "B" else f"{n:.1f} {unidade}"
        n /= 1024
    return f"{n:.1f} TB"


def _copiar_um(
    origem: storage.Store,
    destino: storage.Store,
    chave: str,
    tamanho: int,
    sobrescrever: bool,
    dry_run: bool,
) -> str:
    """Devolve 'pulado' ou 'copiado'; levanta StorageError na falha."""
    if not sobrescrever and destino.tamanho(chave) == tamanho:
        return "pulado"
    if dry_run:
        return "copiado"
    dados, tipo = origem.get_com_tipo(chave)
    destino.put(chave, dados, tipo)
    # Confere pelo destino, e nao pelo sucesso do PUT: proxy ou gateway no
    # meio do caminho ja devolveu 200 para corpo truncado.
    gravado = destino.tamanho(chave)
    if gravado != len(dados):
        raise storage.StorageError(f"destino tem {gravado} bytes, origem {len(dados)}")
    return "copiado"


def migrar(
    origem: storage.Store,
    destino: storage.Store,
    *,
    prefixo: str = "",
    paralelo: int = 8,
    sobrescrever: bool = False,
    dry_run: bool = False,
    saida=print,
) -> Placar:
    placar = Placar()
    inicio = time.monotonic()
    itens = list(origem.listar(prefixo))
    total_bytes = sum(t for _, t in itens)
    saida(f"origem: {len(itens)} objeto(s), {_humano(total_bytes)}")

    feitos = 0
    with ThreadPoolExecutor(max_workers=max(1, paralelo)) as pool:
        futuros = {
            pool.submit(_copiar_um, origem, destino, chave, tamanho, sobrescrever, dry_run): (
                chave,
                tamanho,
            )
            for chave, tamanho in itens
        }
        for futuro in as_completed(futuros):
            chave, tamanho = futuros[futuro]
            try:
                resultado = futuro.result()
            except Exception as exc:  # noqa: BLE001 - uma falha nao para as outras
                with placar.trava:
                    placar.falhas.append((chave, str(exc)[:300]))
                saida(f"  ✗ {chave}: {exc}")
            else:
                with placar.trava:
                    if resultado == "pulado":
                        placar.pulados += 1
                    else:
                        placar.copiados += 1
                        placar.bytes_copiados += tamanho
            feitos += 1
            if feitos % 100 == 0 or feitos == len(itens):
                saida(
                    f"  {feitos}/{len(itens)} — copiados {placar.copiados}, "
                    f"pulados {placar.pulados}, falhas {len(placar.falhas)}"
                )

    verbo = "copiaria" if dry_run else "copiou"
    saida(
        f"{verbo} {placar.copiados} ({_humano(placar.bytes_copiados)}), "
        f"pulou {placar.pulados} ja presentes, {len(placar.falhas)} falha(s) "
        f"em {time.monotonic() - inicio:.0f}s"
    )
    return placar


def verificar(
    origem: storage.Store, destino: storage.Store, *, prefixo: str = "", saida=print
) -> bool:
    """Compara as duas listagens inteiras. True se todo objeto da origem esta no destino."""
    na_origem = dict(origem.listar(prefixo))
    no_destino = dict(destino.listar(prefixo))
    faltando = sorted(k for k in na_origem if k not in no_destino)
    diferentes = sorted(k for k in na_origem if k in no_destino and no_destino[k] != na_origem[k])
    sobrando = sorted(k for k in no_destino if k not in na_origem)

    saida(
        f"verificacao: origem {len(na_origem)}, destino {len(no_destino)}; "
        f"faltando {len(faltando)}, tamanho diferente {len(diferentes)}, "
        f"so no destino {len(sobrando)}"
    )
    for rotulo, chaves in (("faltando", faltando), ("diferente", diferentes)):
        for chave in chaves[:20]:
            saida(f"  {rotulo}: {chave}")
    if sobrando:
        # Nao e erro: objeto removido da origem depois da primeira passada, ou
        # escrito ja no destino depois da virada. Nao apagamos -- so avisamos.
        saida(f"  ({len(sobrando)} objeto(s) so no destino; nada foi apagado)")
    return not faltando and not diferentes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m kb_api.migrar_storage",
        description="Copia o acervo do storage atual (S3_*) para o bucket DEST_S3_*.",
    )
    parser.add_argument("--dry-run", action="store_true", help="so diz o que copiaria")
    parser.add_argument(
        "--verificar", action="store_true", help="ao final, compara origem e destino inteiros"
    )
    parser.add_argument("--so-verificar", action="store_true", help="nao copia nada; so compara")
    parser.add_argument(
        "--sobrescrever", action="store_true", help="copia mesmo o que ja esta no destino"
    )
    parser.add_argument(
        "--prefixo", default="", help="so as chaves com este prefixo (ex.: um Espaco)"
    )
    parser.add_argument("--paralelo", type=int, default=8, help="copias simultaneas (padrao 8)")
    args = parser.parse_args(argv)

    try:
        origem = storage.loja()
        destino = storage.S3Store(s3_config("DEST_S3_", provider_padrao="aws"))
    except storage.StorageError as exc:
        print(f"configuracao invalida: {exc}", file=sys.stderr)
        return 2

    print(f"origem:  {origem.descricao()}")
    print(f"destino: {destino.descricao()}")
    if isinstance(origem, storage.S3Store) and (origem.cfg.endpoint, origem.cfg.bucket) == (
        destino.cfg.endpoint,
        destino.cfg.bucket,
    ):
        print("origem e destino sao o mesmo bucket; nada a fazer.", file=sys.stderr)
        return 2
    if not destino.cfg.access_key or not destino.cfg.secret_key:
        print("DEST_S3_ACCESS_KEY / DEST_S3_SECRET_KEY vazios.", file=sys.stderr)
        return 2

    try:
        # No dry-run nao: com S3_CREATE_BUCKET ligado o ensure CRIA o bucket, e
        # "so dizer o que faria" nao pode deixar rastro no destino.
        if not args.dry_run:
            destino.ensure_bucket()
    except storage.StorageError as exc:
        print(f"destino inutilizavel: {exc}", file=sys.stderr)
        return 2

    ok = True
    if not args.so_verificar:
        placar = migrar(
            origem,
            destino,
            prefixo=args.prefixo,
            paralelo=args.paralelo,
            sobrescrever=args.sobrescrever,
            dry_run=args.dry_run,
        )
        ok = not placar.falhas
    if (args.verificar or args.so_verificar) and not args.dry_run:
        ok = verificar(origem, destino, prefixo=args.prefixo) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
