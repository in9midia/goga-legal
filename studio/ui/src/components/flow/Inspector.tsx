import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Trash2 } from "lucide-react";
import { DETERMINISTIC_CHECKS, NODE_TYPE_LABEL, type FlowNode, type FlowSettings, type NodeData } from "@shared/graph";
import { api } from "@/lib/api";
import type { KbSpace, McpServer, Model, Skill, Specialty } from "@/lib/types";
import { Field, LinesInput, MultiSelect, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { NODE_META } from "./FlowCanvas";

const DEFAULT = "__default__";
const NONE = "__none__";

export function useCatalogs() {
  const models = useQuery({ queryKey: ["models"], queryFn: () => api.get<{ models: Model[] }>("/models").then((r) => r.models) });
  const specialties = useQuery({ queryKey: ["specialties"], queryFn: () => api.get<{ specialties: Specialty[] }>("/catalog/specialties").then((r) => r.specialties) });
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api.get<{ skills: Skill[] }>("/catalog/skills").then((r) => r.skills) });
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers: McpServer[] }>("/catalog/mcp").then((r) => r.servers), staleTime: 60_000 });
  const kb = useQuery({ queryKey: ["kb-spaces"], queryFn: () => api.get<{ available: boolean; spaces: KbSpace[]; error?: string }>("/kb/spaces"), staleTime: 60_000 });
  return { models, specialties, skills, mcp, kb };
}

type Cats = ReturnType<typeof useCatalogs>;

function ModelSelect({ value, onChange, models, allowDefault, allowNone }: { value: string | null; onChange: (v: string | null) => void; models: Model[]; allowDefault?: boolean; allowNone?: boolean }) {
  const chat = models.filter((m) => m.purpose === "chat");
  return (
    <Select value={value ?? (allowDefault ? DEFAULT : NONE)} onValueChange={(v) => onChange(v === DEFAULT || v === NONE ? null : v)}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {allowDefault && <SelectItem value={DEFAULT}>Padrão do fluxo</SelectItem>}
        {allowNone && <SelectItem value={NONE}>Nenhum</SelectItem>}
        {chat.map((m) => (
          <SelectItem key={m.id} value={m.id} disabled={!m.usable}>
            {m.providerName} · {m.label}{!m.usable ? " (inativo)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Num({ value, onChange, step = 1, min, max }: { value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  return <Input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />;
}

export function NodeInspector({ node, cats, onChange, onDelete, readOnly, errors }: { node: FlowNode; cats: Cats; onChange: (d: NodeData) => void; onDelete: () => void; readOnly: boolean; errors: string[] }) {
  const d = node.data;
  const set = <K extends keyof NodeData>(k: K, v: NodeData[K]) => onChange({ ...d, [k]: v });
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const models = cats.models.data ?? [];
  const specs = cats.specialties.data ?? [];
  const spaces = cats.kb.data?.spaces ?? [];
  const isAgent = ["classifier", "specialist", "consolidator", "compliance"].includes(node.type);
  const mcpOptions = (cats.mcp.data ?? []).flatMap((s) =>
    s.enabled ? (s.toolsCache ?? []).map((t) => ({ value: `${s.id}:${t.name}`, label: `${s.name} · ${t.name}`, hint: t.description?.slice(0, 90) })) : [{ value: `${s.id}:*`, label: `${s.name} (desabilitado)`, hint: s.description, disabled: true }],
  );

  const applySpecialty = (num: number | null) => {
    const s = specs.find((x) => x.number === num);
    if (!s) return onChange({ ...d, specialtyNumber: null });
    // Escolher a especialidade PRE-PREENCHE (plano §4.3): depois disso o no e
    // dono da propria configuracao, e editar o catalogo nao muda o no.
    onChange({
      ...d,
      specialtyNumber: s.number,
      name: `${s.number} · ${s.name}`,
      description: s.scope,
      prompt: { ...d.prompt, system: s.defaultPrompt },
      knowledge: { ...d.knowledge, spaces: s.defaultSpaces },
      tools: { ...d.tools, skills: [...new Set(["buscar_kb", "verificar_citacao", ...s.defaultSkills])] },
      rules: { ...d.rules, escalation: s.escalationRules, zone: s.zone === "amarela" ? "amarela" : "verde" },
    });
  };

  const tabs = [
    ["geral", "Geral"],
    ...(isAgent ? [["modelo", "Modelo"], ["prompt", "Prompt"]] : []),
    ...(node.type === "specialist" ? [["kb", "Conhecimento"]] : []),
    ...(isAgent ? [["tools", "Ferramentas"], ["regras", "Regras"]] : []),
    ...(node.type === "classifier" ? [["routing", "Roteamento"]] : []),
    ...(node.type === "compliance" ? [["ciclo", "Ciclo"]] : []),
  ];

  return (
    <fieldset disabled={readOnly} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded" style={{ background: `${meta.color}22`, color: meta.color }}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{d.name}</div>
          <div className="text-[0.68rem] text-text-dim">{NODE_TYPE_LABEL[node.type]} · id {node.id}</div>
        </div>
        {!readOnly && !["entry", "classifier", "consolidator", "output"].includes(node.type) && (
          <Button variant="ghost" size="icon" title="Remover nó" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>
        )}
      </div>
      {errors.length > 0 && (
        <div className="space-y-1 border-b border-line bg-rose-500/5 px-4 py-2">
          {errors.map((e, i) => <div key={i} className="flex gap-1.5 text-[0.72rem] text-rose-300"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{e}</div>)}
        </div>
      )}
      <Tabs defaultValue="geral" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-3 mt-3 h-auto flex-wrap justify-start">
          {tabs.map(([v, l]) => <TabsTrigger key={v} value={v} className="flex-none px-2 text-[0.72rem]">{l}</TabsTrigger>)}
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <TabsContent value="geral" className="space-y-4">
            <Field label="Nome"><Input value={d.name} onChange={(e) => set("name", e.target.value)} /></Field>
            {node.type === "specialist" && (
              <Field label="Especialidade" hint="Ao escolher, pré-preenche prompt, bases, skills e gatilhos de escalonamento do catálogo.">
                <Select value={d.specialtyNumber != null ? String(d.specialtyNumber) : NONE} onValueChange={(v) => applySpecialty(v === NONE ? null : Number(v))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-80">
                    <SelectItem value={NONE}>Sem especialidade (livre)</SelectItem>
                    {specs.filter((s) => s.role === "specialist" || s.routable).map((s) => (
                      <SelectItem key={s.number} value={String(s.number)}>{s.number} · {s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Descrição"><Textarea rows={4} value={d.description} onChange={(e) => set("description", e.target.value)} /></Field>
            {!isAgent && <p className="text-[0.75rem] text-text-dim">{node.type === "entry" ? "A Entrada normaliza a mensagem, extrai o texto dos anexos, junta o histórico da conversa e aplica as regras globais do fluxo. Não chama modelo." : "A Saída entrega a resposta e os documentos gerados ao simulador."}</p>}
          </TabsContent>

          <TabsContent value="modelo" className="space-y-4">
            <Field label="Modelo" hint="“Padrão do fluxo” segue o modelo definido nas configurações do fluxo (clique no canvas vazio).">
              <ModelSelect value={d.model.modelId} onChange={(v) => set("model", { ...d.model, modelId: v })} models={models} allowDefault />
            </Field>
            <Field label={`Temperatura: ${d.model.temperature.toFixed(2)}`}>
              <Slider value={[d.model.temperature]} min={0} max={1.5} step={0.05} onValueChange={([v]) => set("model", { ...d.model, temperature: v })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Máx. tokens de saída"><Num value={d.model.maxTokens} onChange={(v) => set("model", { ...d.model, maxTokens: v })} /></Field>
              <Field label="Timeout (s)"><Num value={d.model.timeoutMs / 1000} onChange={(v) => set("model", { ...d.model, timeoutMs: Math.round(v * 1000) })} /></Field>
            </div>
            <Field label="Custo máximo por chamada (US$)" hint="Acima disso a chamada é marcada com alerta no trace. O teto por execução fica nas configurações do fluxo.">
              <Num value={d.model.maxCostUsd} step={0.01} onChange={(v) => set("model", { ...d.model, maxCostUsd: v })} />
            </Field>
            <Field label="Modelo de fallback" hint="Usado se o provedor principal falhar (erro de rede, 5xx). Erro de configuração não aciona o fallback.">
              <ModelSelect value={d.model.fallbackModelId} onChange={(v) => set("model", { ...d.model, fallbackModelId: v })} models={models} allowNone />
            </Field>
          </TabsContent>

          <TabsContent value="prompt" className="space-y-4">
            <div className="flex flex-wrap gap-1">
              {["{{mensagem}}", "{{ficha}}", "{{regras_globais}}", ...(node.type === "consolidator" ? ["{{pareceres}}"] : []), ...(node.type === "classifier" ? ["{{especialidades}}"] : [])].map((v) => (
                <code key={v} className="rounded border border-line bg-ink-800 px-1.5 py-0.5 text-[0.68rem] text-text-muted">{v}</code>
              ))}
            </div>
            <Field label="Prompt de sistema" hint="O motor acrescenta depois do prompt: regras globais, guardrails, evidências da KB e a instrução de formato de saída.">
              <Textarea className="min-h-[340px] font-mono text-[0.74rem] leading-relaxed" value={d.prompt.system} onChange={(e) => set("prompt", { ...d.prompt, system: e.target.value })} />
            </Field>
            {node.type === "specialist" && (
              <Field label="Formato de saída">
                <Select value={d.prompt.outputFormat} onValueChange={(v) => set("prompt", { ...d.prompt, outputFormat: v as "parecer" | "livre" })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parecer">Parecer padronizado (JSON)</SelectItem>
                    <SelectItem value="livre">Livre (texto)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Exemplos (few-shot)"><Textarea rows={5} className="font-mono text-[0.74rem]" value={d.prompt.examples} onChange={(e) => set("prompt", { ...d.prompt, examples: e.target.value })} /></Field>
          </TabsContent>

          <TabsContent value="kb" className="space-y-4">
            {!cats.kb.data?.available && <Pill tone="warn">KB fora do ar: a lista de bases não pôde ser carregada</Pill>}
            <Field label="Bases de conhecimento" hint="A busca do especialista (e a tool MCP da KB) fica restrita a estas bases.">
              <MultiSelect
                options={spaces.map((s) => ({ value: s.slug, label: String(s.label ?? s.name ?? s.slug), hint: s.slug }))}
                value={d.knowledge.spaces}
                onChange={(v) => set("knowledge", { ...d.knowledge, spaces: v })}
                disabled={readOnly}
              />
            </Field>
            {!cats.kb.data?.available && (
              <Field label="Bases (texto, uma por linha)"><LinesInput value={d.knowledge.spaces} onChange={(v) => set("knowledge", { ...d.knowledge, spaces: v })} /></Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="top_k"><Num value={d.knowledge.topK} min={1} max={50} onChange={(v) => set("knowledge", { ...d.knowledge, topK: v })} /></Field>
              <Field label="Vigência (as_of)"><Input type="date" value={d.knowledge.asOf} onChange={(e) => set("knowledge", { ...d.knowledge, asOf: e.target.value })} /></Field>
            </div>
            <Field label="Confiança mínima (min_trust)" hint="Resposta vazia com filtro ligado significa que a base não tem conteúdo conferido sobre o assunto.">
              <Select value={d.knowledge.minTrust || "any"} onValueChange={(v) => set("knowledge", { ...d.knowledge, minTrust: v === "any" ? "" : v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">sem filtro (unverified)</SelectItem>
                  <SelectItem value="machine-confirmed">machine-confirmed</SelectItem>
                  <SelectItem value="human-reviewed">human-reviewed</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm">
              <span>Descartar trechos marcados como armadilha<span className="block text-[0.7rem] text-text-dim">e citar só VERIFICADAS</span></span>
              <Switch checked={d.knowledge.verifiedOnly} onCheckedChange={(v) => set("knowledge", { ...d.knowledge, verifiedOnly: v })} />
            </label>
          </TabsContent>

          <TabsContent value="tools" className="space-y-4">
            <Field label="Skills" hint="Lista fixa do sistema. buscar_kb e verificar_citacao o motor executa sozinho; calcular_*, elegibilidade, anexos e checklist o modelo chama como ferramenta.">
              <MultiSelect options={(cats.skills.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.id }))} value={d.tools.skills} onChange={(v) => set("tools", { ...d.tools, skills: v })} disabled={readOnly} />
            </Field>
            <Field label="MCP" hint="Ferramentas dos servidores MCP (lista fixa). A busca do goga-kb é recortada às bases do nó.">
              <MultiSelect options={mcpOptions} value={d.tools.mcp} onChange={(v) => set("tools", { ...d.tools, mcp: v })} disabled={readOnly} />
            </Field>
          </TabsContent>

          <TabsContent value="regras" className="space-y-4">
            <Field label="Guardrails do agente (um por linha)"><LinesInput key={`g-${node.id}`} rows={5} value={d.rules.guardrails} onChange={(v) => set("rules", { ...d.rules, guardrails: v })} /></Field>
            <Field label="Checagens determinísticas">
              <div className="grid grid-cols-2 gap-2">
                {DETERMINISTIC_CHECKS.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-xs">
                    <Checkbox checked={d.rules.checks.includes(c)} onCheckedChange={(on) => set("rules", { ...d.rules, checks: on ? [...d.rules.checks, c] : d.rules.checks.filter((x) => x !== c) })} />
                    {c}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Gatilhos de escalonamento para humano (um por linha)" hint="Ex.: vara comum, recurso, valor acima de 20 SM, risco à saúde."><LinesInput key={`e-${node.id}`} rows={5} value={d.rules.escalation} onChange={(v) => set("rules", { ...d.rules, escalation: v })} /></Field>
            <Field label="Zona permitida">
              <Select value={d.rules.zone} onValueChange={(v) => set("rules", { ...d.rules, zone: v as "verde" | "amarela" })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="verde">Verde: orientação geral</SelectItem>
                  <SelectItem value="amarela">Amarela: orientação com ressalvas</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </TabsContent>

          {d.routing && (
            <TabsContent value="routing" className="space-y-4">
              <Field label={`Limiar de roteamento: ${d.routing.routingThreshold.toFixed(2)}`} hint="Especialistas com score igual ou acima entram no turno.">
                <Slider value={[d.routing.routingThreshold]} min={0} max={1} step={0.05} onValueChange={([v]) => set("routing", { ...d.routing!, routingThreshold: v })} />
              </Field>
              <Field label={`Limiar de esclarecimento: ${d.routing.clarifyThreshold.toFixed(2)}`} hint="Se o melhor score ficar abaixo, o turno termina com UMA pergunta de esclarecimento (regra-mãe).">
                <Slider value={[d.routing.clarifyThreshold]} min={0} max={1} step={0.05} onValueChange={([v]) => set("routing", { ...d.routing!, clarifyThreshold: v })} />
              </Field>
              <Field label="Máx. especialistas por turno"><Num value={d.routing.maxSpecialists} min={1} max={10} onChange={(v) => set("routing", { ...d.routing!, maxSpecialists: v })} /></Field>
              <Field label="Gatilhos de exclusão (fora de escopo → Encaminhamento)"><LinesInput key={`x-${node.id}`} value={d.routing.exclusionTriggers} onChange={(v) => set("routing", { ...d.routing!, exclusionTriggers: v })} /></Field>
              <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm">
                <span>Polo réu → fast-path<span className="block text-[0.7rem] text-text-dim">um só especialista e flag de urgência</span></span>
                <Switch checked={d.routing.defendantFastPath} onCheckedChange={(v) => set("routing", { ...d.routing!, defendantFastPath: v })} />
              </label>
            </TabsContent>
          )}

          {d.cycle && (
            <TabsContent value="ciclo" className="space-y-4">
              <Field label="Máx. ciclos de revisão" hint="Reprovou: volta ao Consolidador com os motivos. Esgotou: resposta segura padrão e flag no trace."><Num value={d.cycle.maxCycles} min={0} max={5} onChange={(v) => set("cycle", { ...d.cycle!, maxCycles: v })} /></Field>
              <Field label="Checagens obrigatórias">
                <div className="grid grid-cols-2 gap-2">
                  {DETERMINISTIC_CHECKS.map((c) => (
                    <label key={c} className="flex items-center gap-2 text-xs">
                      <Checkbox checked={d.cycle!.requiredChecks.includes(c)} onCheckedChange={(on) => set("cycle", { ...d.cycle!, requiredChecks: on ? [...d.cycle!.requiredChecks, c] : d.cycle!.requiredChecks.filter((x) => x !== c) })} />
                      {c}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Resposta segura padrão"><Textarea rows={8} value={d.cycle.safeResponse} onChange={(e) => set("cycle", { ...d.cycle!, safeResponse: e.target.value })} /></Field>
            </TabsContent>
          )}
        </div>
      </Tabs>
    </fieldset>
  );
}

export function FlowSettingsPanel({ name, description, settings, onChange, cats, readOnly }: { name: string; description: string; settings: FlowSettings; onChange: (p: { name?: string; description?: string; settings?: FlowSettings }) => void; cats: Cats; readOnly: boolean }) {
  const s = settings;
  const set = <K extends keyof FlowSettings>(k: K, v: FlowSettings[K]) => onChange({ settings: { ...s, [k]: v } });
  return (
    <fieldset disabled={readOnly} className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <div className="text-sm font-medium">Configurações do fluxo</div>
        <div className="text-[0.68rem] text-text-dim">clique num nó para editar as propriedades dele</div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <Field label="Nome"><Input value={name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
        <Field label="Descrição"><Textarea rows={3} value={description} onChange={(e) => onChange({ description: e.target.value })} /></Field>
        <Field label="Modelo padrão" hint="Todo nó sem modelo próprio usa este. Trocar aqui troca o fluxo inteiro.">
          <ModelSelect value={s.defaultModelId} onChange={(v) => set("defaultModelId", v)} models={cats.models.data ?? []} allowNone />
        </Field>
        <Field label="Teto de custo por execução (US$)"><Num value={s.maxRunCostUsd} step={0.05} onChange={(v) => set("maxRunCostUsd", v)} /></Field>
        <Field label="Regras globais" hint="Regras Absolutas 1 e 2, regra-mãe, neutralidade, sem promessa de resultado. Vão para todos os agentes.">
          <Textarea className="min-h-[260px] font-mono text-[0.72rem] leading-relaxed" value={s.globalRules} onChange={(e) => set("globalRules", e.target.value)} />
        </Field>
        <Field label="Disclaimer final obrigatório" hint="O motor anexa ao fim da resposta simples; o Compliance confere.">
          <Textarea rows={6} value={s.disclaimer} onChange={(e) => set("disclaimer", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Idioma"><Input value={s.language} onChange={(e) => set("language", e.target.value)} /></Field>
          <Field label="Tom"><Input value={s.tone} onChange={(e) => set("tone", e.target.value)} /></Field>
        </div>
      </div>
    </fieldset>
  );
}
