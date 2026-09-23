import { useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Copy,
  FileDown,
  Loader2,
  ScrollText,
} from "lucide-react";
import { toast } from "sonner";
import { getText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Copia texto que ainda vai ser buscado. O Safari so aceita escrever no
// clipboard dentro do gesto do usuario, entao a Promise vai direto no
// ClipboardItem; onde isso nao existe, busca e usa writeText.
async function copyAsync(load: () => Promise<string>): Promise<string> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const text = load();
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })),
        }),
      ]);
      return text;
    } catch {
      await navigator.clipboard.writeText(await text);
      return text;
    }
  }
  const t = await load();
  await navigator.clipboard.writeText(t);
  return t;
}

// Copia sincrona dentro do gesto; funciona onde a Clipboard API e negada.
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface TranscriptSource {
  label: string;
  path: string;
  filename: string;
}

/** Menu "Transcrição": copia ou baixa em Markdown cada interação, execução e o que cada agente recebeu e respondeu. */
export function TranscriptMenu({
  sources,
  className,
  label = "Copiar transcrição",
}: {
  sources: TranscriptSource[];
  className?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  // Clipboard negado (permissao, iframe, http): mostra o texto para copiar a mao.
  const [manual, setManual] = useState<{
    text: string;
    filename: string;
  } | null>(null);
  const copy = async (s: TranscriptSource) => {
    setBusy(true);
    const load = getText(s.path);
    try {
      await copyAsync(() => load);
      toast.success("Transcrição copiada");
    } catch {
      try {
        setManual({ text: await load, filename: s.filename });
      } catch (e) {
        toast.error((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!sources.length) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn("h-7 gap-1.5 text-xs", className)}
            title="Copiar transcrição detalhada"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScrollText className="h-3.5 w-3.5" />
            )}{" "}
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {sources.map((s, i) => (
            <div key={s.path}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-xs text-text-muted">
                {s.label}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => copy(s)}>
                <ClipboardCopy className="h-3.5 w-3.5" /> Copiar (Markdown)
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  run(
                    async () => download(s.filename, await getText(s.path)),
                    "Transcrição baixada",
                  )
                }
              >
                <FileDown className="h-3.5 w-3.5" /> Baixar .md
              </DropdownMenuItem>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ManualCopyDialog state={manual} onClose={() => setManual(null)} />
    </>
  );
}

function ManualCopyDialog({
  state,
  onClose,
}: {
  state: { text: string; filename: string } | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (state) setTimeout(() => ref.current?.select(), 50);
  }, [state]);
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Transcrição</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-text-muted">
          O navegador bloqueou a cópia automática. O texto já está selecionado:
          use Ctrl/Cmd+C, ou baixe o arquivo.
        </p>
        <textarea
          ref={ref}
          readOnly
          value={state?.text ?? ""}
          className="h-[60vh] w-full resize-none rounded-md border border-line bg-ink-900 p-3 font-mono text-xs"
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              state &&
              (legacyCopy(state.text)
                ? toast.success("Transcrição copiada")
                : ref.current?.select())
            }
          >
            <ClipboardCopy className="h-3.5 w-3.5" /> Copiar
          </Button>
          <Button
            size="sm"
            onClick={() => state && download(state.filename, state.text)}
          >
            <FileDown className="h-3.5 w-3.5" /> Baixar .md
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Botao pequeno de copiar um texto ja conhecido (pergunta/resposta do chat). */
export function CopyButton({
  text,
  title = "Copiar",
  label,
  className,
}: {
  text: string;
  title?: string;
  /** Com rotulo vira botao com texto; sem, so o icone. */
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size={label ? "sm" : "icon"}
      className={cn(label ? "h-7 gap-1.5 px-2 text-xs" : "h-7 w-7", className)}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        const ok = () => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        };
        if (legacyCopy(text)) return ok();
        navigator.clipboard
          .writeText(text)
          .then(ok, (err) => toast.error((err as Error).message));
      }}
    >
      {done ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {label && (done ? "Copiado" : label)}
    </Button>
  );
}
