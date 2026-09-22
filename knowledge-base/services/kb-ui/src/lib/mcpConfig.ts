/**
 * Como cada harness quer a configuração de um servidor MCP **remoto**.
 *
 * Remoto é o ponto: não há arquivo para a pessoa ter em mãos, não há Node na
 * máquina dela, e atualizar a ponte é publicar a API. A configuração de todo
 * harness se reduz a uma URL e um header.
 *
 * Este módulo é PURO de propósito — a tela só mostra o que ele calcula, e o que
 * erra em silêncio (o base64 do deeplink do Cursor, a tradução de formato de
 * cada harness) fica testável sem renderizar nada.
 */

/** Nome do servidor nas configurações no padrão `mcpServers`. */
export const MCP_SERVER_NAME = 'knowledge-base';

/** Chave TOML do Codex: hífen exigiria citação, então o nome muda de forma. */
export const MCP_SERVER_NAME_TOML = 'knowledge_base';

export type McpConfig = {
  /** Base da API, sem barra no fim (ex.: http://localhost:8890). */
  origin: string;
  /**
   * Token pessoal, no caminho de exceção.
   *
   * Vazio é o caso NORMAL: o servidor fala OAuth, o editor descobre isso pelo
   * `WWW-Authenticate`, se registra sozinho e abre o login. Configuração com
   * header só existe para editor que não implementa esse fluxo.
   */
  token?: string;
};

export type CanonicalEntry = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type HarnessId = 'claude-desktop' | 'claude-code' | 'cursor' | 'opencode' | 'codex';

type HarnessTargetBase = {
  id: HarnessId;
  label: string;
  /** Onde o arquivo fica, com `~` para o diretório do usuário. */
  path: string;
  language: 'json' | 'toml';
  /** Ressalva honesta quando o suporte remoto do harness não é o caminho consolidado dele. */
  caveat?: string;
};

export type HarnessTarget = HarnessTargetBase & {
  /** Onde, na interface do editor, se cola a URL do conector. */
  connectorPath?: string;
  /**
   * Adicionar aqui exige permissão de administrador da organização.
   */
  orgOnly?: boolean;
  /**
   * O cliente MCP roda na MÁQUINA da pessoa, e por isso alcança `localhost`.
   *
   * Conector personalizado do Claude é do tipo **Web**: quem chama o MCP são os
   * servidores da Anthropic, não o aplicativo. `localhost` ali é o localhost
   * DELES — a conexão simplesmente não encontra nada. Só a URL pública serve.
   */
  local?: boolean;
};

export const HARNESS_TARGETS: HarnessTarget[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    path: '~/.config/Claude/claude_desktop_config.json',
    language: 'json',
    // Em conta de ORGANIZAÇÃO, adicionar conector personalizado é permissão de
    // admin — o membro comum não tem o botão em lugar nenhum. Os conectores
    // "Personalizado" que aparecem na lista (Asana, Atlassian, Notion) foram
    // cadastrados no nível da organização, não por quem os vê.
    //
    // Mandar a pessoa procurar um botão que a conta dela não tem é o pior tipo
    // de instrução: ela conclui que errou o caminho.
    connectorPath: 'depende de permissão de administrador da organização — veja abaixo',
    orgOnly: true,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: '~/.claude.json',
    language: 'json',
    connectorPath: 'um comando no terminal (abaixo)',
    local: true,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    path: '~/.cursor/mcp.json',
    language: 'json',
    connectorPath: 'Settings → MCP → Add new MCP server, ou o botão abaixo',
    /** Roda na máquina, então alcança `localhost`. */
    local: true,
  },
  {
    id: 'opencode',
    label: 'opencode',
    path: '~/.config/opencode/opencode.json',
    language: 'json',
    local: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    path: '~/.codex/config.toml',
    language: 'toml',
    local: true,
    caveat:
      'O suporte a MCP remoto no Codex é recente e pode exigir `experimental_use_rmcp_client = true` no mesmo arquivo, conforme a versão.',
  },
];

export function serverUrl(cfg: McpConfig): string {
  return `${cfg.origin.replace(/\/+$/, '')}/mcp`;
}

export function canonicalEntry(cfg: McpConfig): CanonicalEntry {
  const entry: CanonicalEntry = { type: 'http', url: serverUrl(cfg) };
  // Sem token, sem header: o editor faz o login sozinho pelo OAuth. É o
  // caminho padrão, e é o que evita segredo em arquivo de configuração.
  //
  // Com token, `Authorization: Bearer` e não um header próprio: o kb-api tem
  // UMA porta de entrada de credencial, atravessada pelo JWT do navegador, pelo
  // token de serviço, pelo do conector e pelo pessoal. Um header alternativo
  // seria um segundo caminho de autenticação para manter em pé.
  if (cfg.token) entry.headers = { Authorization: `Bearer ${cfg.token}` };
  return entry;
}

/** opencode usa a chave `mcp` e `type: "remote"`. */
export function opencodeEntry(entry: CanonicalEntry) {
  const saida: Record<string, unknown> = { type: 'remote', url: entry.url, enabled: true };
  if (entry.headers) saida.headers = entry.headers;
  return saida;
}

/** Conteúdo a escrever no arquivo de cada harness. */
export function renderConfig(target: HarnessTarget, cfg: McpConfig): string {
  const entry = canonicalEntry(cfg);
  switch (target.id) {
    case 'opencode':
      return JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: { [MCP_SERVER_NAME]: opencodeEntry(entry) },
        },
        null,
        2,
      );
    case 'codex':
      return renderToml(entry);
    default:
      return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2);
  }
}

function renderToml(entry: CanonicalEntry): string {
  const linhas = [`[mcp_servers.${MCP_SERVER_NAME_TOML}]`, `url = ${JSON.stringify(entry.url)}`];
  // A seção de headers só existe quando há token. Um `[http_headers]` vazio no
  // TOML é sintaxe válida e sinal errado — sugere que falta preencher algo.
  if (entry.headers) {
    linhas.push('', `[mcp_servers.${MCP_SERVER_NAME_TOML}.http_headers]`);
    for (const [chave, valor] of Object.entries(entry.headers)) {
      linhas.push(`${chave} = ${JSON.stringify(valor)}`);
    }
  }
  return linhas.join('\n');
}

/** Comando de uma linha, quando o harness tem CLI para isso. */
export function installCommand(target: HarnessTarget, cfg: McpConfig): string | null {
  if (target.id !== 'claude-code') return null;
  const entry = canonicalEntry(cfg);
  const partes = [
    `claude mcp add --transport http ${MCP_SERVER_NAME}`,
    shellQuote(entry.url),
    '--scope user',
  ];
  // Sem token o comando é só a URL: o Claude Code abre o navegador para o login
  // na primeira chamada.
  if (cfg.token) {
    partes.splice(2, 0, `--header ${shellQuote(`Authorization: Bearer ${cfg.token}`)}`);
  }
  return partes.join(' ');
}

/**
 * Aspas simples para o shell. Uma aspa simples dentro do valor precisa sair e
 * voltar (`'\''`) — sem isto um token com aspa quebraria o comando colado.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Deeplink "Adicionar ao Cursor": o Cursor registra o handler `cursor://` e
 * aplica a configuração sem abrir arquivo nenhum.
 *
 * É conveniência, não a única via — a tela sempre mostra o JSON equivalente,
 * porque o handler depende da versão do Cursor e de o sistema ter registrado o
 * esquema.
 */
export function cursorDeeplink(cfg: McpConfig): string {
  const codificado = base64(JSON.stringify(canonicalEntry(cfg)));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(
    MCP_SERVER_NAME,
  )}&config=${encodeURIComponent(codificado)}`;
}

/**
 * Prompt para colar NA CONVERSA do próprio harness: o agente se configura.
 *
 * É o caminho para quem não vai editar JSON à mão — e é a maioria. O agente do
 * editor já sabe ler e escrever arquivo e rodar comando; falta só dizer o quê,
 * e dizer com precisão suficiente para ele não improvisar.
 *
 * Três instruções não são detalhe, são o que separa "funcionou" de "quebrou a
 * configuração da pessoa":
 *
 * 1. **mesclar, nunca sobrescrever.** O arquivo costuma já ter outros MCPs, e
 *    reescrevê-lo inteiro apagaria todos eles em silêncio;
 * 2. **criar o arquivo se não existir**, com JSON válido — meio caminho é um
 *    arquivo corrompido que o editor recusa a carregar inteiro;
 * 3. **avisar que precisa reiniciar** — sem isso a pessoa conclui que não
 *    funcionou e desfaz tudo.
 */
export function selfConfigurePrompt(target: HarnessTarget, cfg: McpConfig): string {
  const entry = canonicalEntry(cfg);
  const comando = installCommand(target, cfg);

  const linhas = [
    `Configure o servidor MCP "${MCP_SERVER_NAME}" (a base de conhecimento do Goga Legal) neste editor, para mim.`,
    '',
  ];

  if (comando) {
    linhas.push(
      'Rode exatamente este comando no terminal:',
      '',
      comando,
      '',
      'Depois confirme que apareceu na lista (`claude mcp list`) e me diga o resultado.',
    );
    return linhas.join('\n');
  }

  if (target.language === 'toml') {
    linhas.push(
      `Edite o arquivo ${target.path} e ACRESCENTE este bloco ao final,`,
      'sem remover nem alterar nada do que já estiver lá:',
      '',
      renderConfig(target, cfg),
      '',
      'Se o arquivo não existir, crie com esse conteúdo.',
      'Depois me diga que preciso reiniciar o editor para valer.',
    );
    return linhas.join('\n');
  }

  const chave = target.id === 'opencode' ? 'mcp' : 'mcpServers';
  linhas.push(
    `Edite o arquivo ${target.path} e ACRESCENTE esta entrada dentro de "${chave}":`,
    '',
    JSON.stringify(
      target.id === 'opencode'
        ? { [MCP_SERVER_NAME]: opencodeEntry(entry) }
        : { [MCP_SERVER_NAME]: entry },
      null,
      2,
    ),
    '',
    'Regras importantes:',
    `- MESCLE com o que já existe. Não apague os outros servidores MCP do arquivo.`,
    `- Se o arquivo não existir, crie com { "${chave}": { ... } } contendo só esta entrada.`,
    '- Mantenha o JSON válido.',
    '',
    'Ao terminar, me avise que preciso REINICIAR o editor para a conexão valer.',
  );
  return linhas.join('\n');
}

/** base64 de texto UTF-8 — `btoa` sozinho quebra em acento. */
export function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario);
}
