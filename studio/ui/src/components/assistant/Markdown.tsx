import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "@/components/transcript";

// Markdown das respostas do Assistente, com a escala ink-* do Studio (sem o
// plugin de tipografia: poucas regras, todas aqui).
const components: Components = {
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-4 mb-2 text-[0.95rem] font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-[0.92rem] font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-medium first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-text-dim">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-text-dim">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target={href?.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="text-blue-300 underline decoration-blue-300/40 underline-offset-2 hover:decoration-blue-300">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-ink-500 pl-3 text-text-muted">{children}</blockquote>,
  hr: () => <hr className="my-3 border-line" />,
  img: ({ src, alt }) => <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-2 max-h-96 max-w-full rounded-md border border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-line">
      <table className="w-full text-[0.8rem]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-ink-850 text-left text-text-muted">{children}</thead>,
  th: ({ children }) => <th className="px-2.5 py-1.5 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-t border-line px-2.5 py-1.5 align-top">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "").replace(/\n$/, "");
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if (!lang && !text.includes("\n")) return <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[0.8em]">{children}</code>;
    return (
      <div className="group relative my-2">
        <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={text} title="Copiar código" />
        </div>
        {lang && <div className="rounded-t-md border border-b-0 border-line bg-ink-850 px-3 py-1 font-mono text-[0.66rem] text-text-dim">{lang}</div>}
        <pre className={`overflow-x-auto border border-line bg-ink-950 p-3 font-mono text-[0.76rem] leading-relaxed ${lang ? "rounded-b-md" : "rounded-md"}`}>
          <code>{text}</code>
        </pre>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[0.86rem] break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
