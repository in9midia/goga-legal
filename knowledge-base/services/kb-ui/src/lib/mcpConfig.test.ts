import { describe, expect, it } from 'vitest';
import {
  HARNESS_TARGETS,
  base64,
  canonicalEntry,
  cursorDeeplink,
  installCommand,
  renderConfig,
  selfConfigurePrompt,
} from './mcpConfig';

// O que estes testes cobrem é o que erra em SILÊNCIO: uma configuração no
// formato errado não dá erro aqui, dá um MCP que simplesmente não aparece no
// editor da pessoa — e o diagnóstico disso custa meia hora.

// O caso NORMAL é sem token: o editor faz o login sozinho pelo OAuth.
const oauth = { origin: 'http://localhost:8890/' };
// Com token é a exceção — editor que não implementa o fluxo.
const cfg = { origin: 'http://localhost:8890/', token: 'kbp_abc123' };

describe('entrada canônica', () => {
  it('sem token não escreve header nenhum — quem autentica é o OAuth', () => {
    expect(canonicalEntry(oauth)).toEqual({
      type: 'http',
      url: 'http://localhost:8890/mcp',
    });
    expect(canonicalEntry(oauth)).not.toHaveProperty('headers');
  });

  it('com token usa Authorization: Bearer e a URL sem barra dupla', () => {
    expect(canonicalEntry(cfg)).toEqual({
      type: 'http',
      url: 'http://localhost:8890/mcp',
      headers: { Authorization: 'Bearer kbp_abc123' },
    });
  });
});

describe('formato por harness', () => {
  it('Claude Desktop, Claude Code e Cursor usam mcpServers', () => {
    for (const id of ['claude-desktop', 'claude-code', 'cursor'] as const) {
      const alvo = HARNESS_TARGETS.find((t) => t.id === id)!;
      const json = JSON.parse(renderConfig(alvo, cfg));
      expect(json.mcpServers['knowledge-base'].type).toBe('http');
      expect(json.mcpServers['knowledge-base'].headers.Authorization).toBe('Bearer kbp_abc123');
    }
  });

  it('opencode usa a chave mcp e type remote', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'opencode')!;
    const json = JSON.parse(renderConfig(alvo, cfg));
    expect(json.mcp['knowledge-base']).toMatchObject({ type: 'remote', enabled: true });
  });

  it('Codex sai em TOML, com o nome sem hífen', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'codex')!;
    const toml = renderConfig(alvo, cfg);
    expect(toml).toContain('[mcp_servers.knowledge_base]');
    expect(toml).toContain('url = "http://localhost:8890/mcp"');
    expect(toml).toContain('Authorization = "Bearer kbp_abc123"');
  });

  it('sem token o TOML não abre seção de headers vazia', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'codex')!;
    expect(renderConfig(alvo, oauth)).not.toContain('http_headers');
  });
});

describe('comando de instalação', () => {
  it('existe só para o Claude Code', () => {
    const claude = HARNESS_TARGETS.find((t) => t.id === 'claude-code')!;
    const cursor = HARNESS_TARGETS.find((t) => t.id === 'cursor')!;
    expect(installCommand(claude, cfg)).toContain('claude mcp add --transport http knowledge-base');
    expect(installCommand(cursor, cfg)).toBeNull();
  });

  it('sem token o comando não carrega header — o login abre sozinho', () => {
    const claude = HARNESS_TARGETS.find((t) => t.id === 'claude-code')!;
    const comando = installCommand(claude, oauth)!;
    expect(comando).not.toContain('--header');
    expect(comando).toContain('--scope user');
  });

  it('escapa aspa simples no token em vez de quebrar o comando', () => {
    const claude = HARNESS_TARGETS.find((t) => t.id === 'claude-code')!;
    const comando = installCommand(claude, { ...cfg, token: "kbp_a'b" })!;
    expect(comando).toContain(`'Authorization: Bearer kbp_a'\\''b'`);
  });
});

describe('deeplink do Cursor', () => {
  it('carrega a entrada canônica em base64', () => {
    const link = cursorDeeplink(cfg);
    const config = new URL(link.replace('cursor://', 'https://')).searchParams.get('config')!;
    expect(JSON.parse(atob(config))).toEqual(canonicalEntry(cfg));
  });

  it('base64 sobrevive a acento (btoa sozinho quebraria)', () => {
    expect(() => base64('configuração')).not.toThrow();
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(base64('ação')), (c) => c.charCodeAt(0))),
    ).toBe('ação');
  });
});

describe('prompt de auto-configuração', () => {
  it('para o Claude Code manda rodar o comando, não editar arquivo', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'claude-code')!;
    const prompt = selfConfigurePrompt(alvo, cfg);
    expect(prompt).toContain('claude mcp add --transport http knowledge-base');
    expect(prompt).not.toContain('ACRESCENTE');
  });

  it('para JSON exige MESCLAR — sobrescrever apagaria os outros MCPs', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'claude-desktop')!;
    const prompt = selfConfigurePrompt(alvo, cfg);
    expect(prompt).toContain('~/.config/Claude/claude_desktop_config.json');
    expect(prompt).toContain('MESCLE');
    expect(prompt).toContain('Não apague os outros servidores MCP');
    // A entrada a mesclar vai SEM o invólucro: quem mescla precisa do ITEM, não
    // do arquivo inteiro. O invólucro só aparece depois, na instrução de "se o
    // arquivo não existir" — que é outro caso.
    expect(prompt).toContain('{\n  "knowledge-base": {');
    expect(prompt).toContain('crie com { "mcpServers"');
    expect(prompt).toContain('Bearer kbp_abc123');
  });

  it('para o opencode usa a chave mcp, não mcpServers', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'opencode')!;
    const prompt = selfConfigurePrompt(alvo, cfg);
    expect(prompt).toContain('dentro de "mcp"');
    expect(prompt).toContain('"type": "remote"');
  });

  it('para o Codex manda acrescentar o TOML ao final', () => {
    const alvo = HARNESS_TARGETS.find((t) => t.id === 'codex')!;
    const prompt = selfConfigurePrompt(alvo, cfg);
    expect(prompt).toContain('[mcp_servers.knowledge_base]');
    expect(prompt).toContain('ACRESCENTE');
  });

  it('todo prompt lembra de reiniciar ou confirmar', () => {
    for (const alvo of HARNESS_TARGETS) {
      const prompt = selfConfigurePrompt(alvo, cfg);
      expect(prompt.toLowerCase()).toMatch(/reiniciar|confirme/);
    }
  });
});
