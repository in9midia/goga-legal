import { fmtMs } from '../lib/format';
import { orderedStages } from '../lib/format';
import type { Stage } from '../lib/types';

/**
 * As etapas da busca, na ordem do pipeline.
 *
 * Existe porque a exigencia do sistema e devolver EVIDENCIA auditavel, nao
 * resposta pronta: quem opera precisa ver que a busca teve dois bracos
 * (vetorial e lexical), quantos candidatos cada um trouxe e onde o tempo foi.
 * Sem isso, "a busca nao achou" nao tem diagnostico.
 */
export function StageList({ stages }: { stages: Record<string, Stage> | null | undefined }) {
  const entries = orderedStages(stages);
  if (entries.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      {entries.map(([name, stage]) => (
        <div key={name} className="grid grid-cols-[7rem_1fr_auto] items-baseline gap-3 text-xs">
          <b className="font-semibold text-text-muted">{name}</b>
          <span className="text-text-dim">
            {stage.tecnica}
            {stage.espacos !== undefined
              ? ` · ${Array.isArray(stage.espacos) ? stage.espacos.join(', ') || 'nenhum' : stage.espacos}`
              : ''}
            {stage.resultado ? ` · ${stage.resultado}` : ''}
            {stage.candidatos !== undefined ? ` · ${stage.candidatos} candidatos` : ''}
            {stage.candidatos_unicos !== undefined ? ` · ${stage.candidatos_unicos} únicos` : ''}
            {stage.devolvidos !== undefined ? ` · ${stage.devolvidos} devolvidos` : ''}
            {stage.erro ? ` · ${stage.erro}` : ''}
          </span>
          <span className="mono text-text-dim">
            {stage.latencia_ms !== undefined ? fmtMs(stage.latencia_ms) : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
