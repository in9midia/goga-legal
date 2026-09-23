import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { AccessPage } from './pages/Access';
import { AiProvidersPage } from './pages/AiProviders';
import { AiUsagePage } from './pages/AiUsage';
import { BenchmarkPage } from './pages/Benchmark';
import { ConnectPage } from './pages/Connect';
import { DocumentsPage } from './pages/Documents';
import { WikiPage } from './pages/Wiki';
import { GraphPage } from './pages/Graph';
import { HistoryPage } from './pages/History';
import { QueuePage } from './pages/Queue';
import { Home } from './pages/Home';
import { SearchPage } from './pages/Search';
import { SpacesPage } from './pages/Spaces';
import { StackPage } from './pages/Stack';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/bases" element={<SpacesPage />} />
        <Route path="/documentos" element={<DocumentsPage />} />
        <Route path="/wiki" element={<WikiPage />} />
        <Route path="/grafo" element={<GraphPage />} />
        <Route path="/buscar" element={<SearchPage />} />
        <Route path="/historico" element={<HistoryPage />} />
        <Route path="/fila" element={<QueuePage />} />
        {/* `/conectar`, e nao `/mcp`: o nginx do kb-ui encaminha /mcp para a API
            (e o endpoint do servidor MCP), entao a rota da SPA com esse nome
            nunca chegava ao navegador -- a pagina vinha em branco com o JSON da
            API no lugar. */}
        <Route path="/conectar" element={<ConnectPage />} />
        <Route path="/acessos" element={<AccessPage />} />
        <Route path="/modelos-ia" element={<AiProvidersPage />} />
        <Route path="/uso-ia" element={<AiUsagePage />} />
        <Route path="/benchmark" element={<BenchmarkPage />} />
        <Route path="/stack" element={<StackPage />} />
        {/* A tela de Saúde foi dobrada na de Stack: ela mostrava um subconjunto
            do que a Stack mostra, e eram dois itens de menu para a mesma
            pergunta. A rota fica, redirecionando, porque links antigos e
            favoritos apontam para cá. */}
        <Route path="/saude" element={<Navigate to="/stack" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
