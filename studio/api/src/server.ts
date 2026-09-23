import { buildApp } from "./app.js";
import { config } from "./config.js";
import { runMigrations } from "./db/index.js";
import { pruneSessions } from "./lib/auth.js";
import { seed } from "./seed/index.js";
import { recoverInterruptedTurns } from "./assistant/agent.js";
import { getIndices } from "./skills/indices.js";

await runMigrations();
await seed((m) => console.log(`[seed] ${m}`));
const interrupted = await recoverInterruptedTurns();
if (interrupted) console.warn(`[assistente] ${interrupted} turno(s) interrompido(s) pelo reinício foram fechados`);
// Aquece a tabela do BCB sem bloquear o boot: sem rede, o Studio sobe e so o
// calculo de correcao recusa.
getIndices().catch((err) => console.warn(`[indices] ${err.message}`));
setInterval(() => pruneSessions().catch(() => undefined), 3600_000).unref();

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`studio-api ouvindo em :${config.port}`);
