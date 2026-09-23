import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AssistantProvider } from "@/lib/assistant";
import { Loading } from "@/components/common";
import { Layout } from "./Layout";
import { LoginPage } from "./pages/Login";
import { FlowsPage } from "./pages/Flows";
import { FlowEditorPage } from "./pages/FlowEditor";
import { SimulatorPage } from "./pages/Simulator";
import { HistoryPage, RunPage } from "./pages/History";
import { CostsPage } from "./pages/Costs";
import { AuditPage } from "./pages/Audit";
import { ProvidersPage } from "./pages/admin/Providers";
import { UsersPage } from "./pages/admin/Users";
import { CatalogsPage } from "./pages/admin/Catalogs";
import { EvalPage } from "./pages/Eval";
import { SkillsPage } from "./pages/Skills";
import { McpPage } from "./pages/Mcp";
import { AssistantPage } from "./pages/Assistant";

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <LoginPage />;
  // Acima das telas: o turno do assistente continua ao trocar de rota.
  return (
    <AssistantProvider>
      <Outlet />
    </AssistantProvider>
  );
}

// Data router (e nao <BrowserRouter>) porque o editor usa `useBlocker` para
// avisar de alteracao nao salva, e ele so existe no data router.
const router = createBrowserRouter([
  {
    element: <Gate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Navigate to="/simulator" replace /> },
          { path: "flows", element: <FlowsPage /> },
          { path: "flows/:id", element: <FlowEditorPage /> },
          { path: "simulator", element: <SimulatorPage /> },
          { path: "simulator/:sessionId", element: <SimulatorPage /> },
          { path: "history", element: <HistoryPage /> },
          { path: "history/:runId", element: <RunPage /> },
          { path: "eval", element: <EvalPage /> },
          { path: "costs", element: <CostsPage /> },
          { path: "audit", element: <AuditPage /> },
          { path: "admin/providers", element: <ProvidersPage /> },
          { path: "admin/users", element: <UsersPage /> },
          { path: "admin/catalogs", element: <CatalogsPage /> },
          { path: "skills", element: <SkillsPage /> },
          { path: "mcp", element: <McpPage /> },
          { path: "assistant", element: <AssistantPage /> },
          { path: "assistant/:sessionId", element: <AssistantPage /> },
          { path: "*", element: <Navigate to="/simulator" replace /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
