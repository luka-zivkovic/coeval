import { useEffect, useState } from "react";
import { createBrowserRouter, Navigate, RouterProvider, Outlet } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { RootLayout } from "@/components/layout/root-layout";
import { BlindReviewLayout } from "@/layouts/blind-review-layout";
import { LoginScreen } from "@/screens/login";
import { SetupScreen } from "@/screens/setup";
import { DashboardScreen } from "@/screens/dashboard";
import { ExceptionsScreen } from "@/screens/exceptions";
import { ReliabilityScreen } from "@/screens/reliability";
import { CaseScreen } from "@/screens/trace";
import { TraceTestBuilderScreen } from "@/screens/trace-test-builder";
import { TraceTestEvidenceScreen } from "@/screens/trace-test-evidence";
import { ReviewScreen } from "@/screens/review";
import { TracesScreen } from "@/screens/traces";
import { ReviewQueuesScreen } from "@/screens/review-queues";
import { QueueDetailScreen } from "@/screens/queue-detail";
import { SkillScreen } from "@/screens/skill";
import { SkillEditScreen } from "@/screens/skill-edit";
import { SkillVersionsScreen, SkillVersionDetailScreen } from "@/screens/skill-versions";
import { CompareVersionsScreen } from "@/screens/compare-versions";
import { CompareRunsScreen } from "@/screens/compare-runs";
import { GoldenScreen } from "@/screens/golden";
import { DatasetsScreen } from "@/screens/datasets";
import { IntegrationsScreen } from "@/screens/integrations";
import { SettingsScreen } from "@/screens/settings";
import { CriteriaScreen } from "@/screens/criteria";
import { HumanTruthScreen } from "@/screens/human-truth";
import { HumanTruthCreateScreen } from "@/screens/human-truth-create";
import { HumanTruthResolutionScreen } from "@/screens/human-truth-resolution";
import { AnalyzeScreen } from "@/screens/analyze";
import { GovernedReviewTasksScreen } from "@/screens/governed-review-tasks";
import { GovernedReviewTaskScreen } from "@/screens/governed-review-task";
import { ApiUnavailableScreen, NotFoundScreen } from "@/screens/system";
import { fetchSetupState } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { AppModeProvider } from "@/lib/app-mode";

const router = createBrowserRouter([
  {
    // Deliberately outside RootLayout and its dashboard/criterion providers:
    // blind reviewer routes may consume only governed-review projections.
    path: "governed-review",
    element: <BlindReviewLayout />,
    children: [
      { index: true, element: <Navigate to="tasks" replace /> },
      { path: "tasks", element: <GovernedReviewTasksScreen /> },
      { path: "tasks/:taskId", element: <GovernedReviewTaskScreen /> }
    ]
  },
  {
    element: <RootLayout />,
    children: [
      { index: true, element: <DashboardScreen /> },
      { path: "traces", element: <TracesScreen /> },
      { path: "exceptions", element: <ExceptionsScreen /> },
      { path: "reliability", element: <ReliabilityScreen /> },
      { path: "cases/:id", element: <CaseScreen /> },
      { path: "cases/:id/make-test", element: <TraceTestBuilderScreen /> },
      { path: "tests/:id/evidence", element: <TraceTestEvidenceScreen /> },
      { path: "review", element: <ReviewScreen /> },
      { path: "review-queues", element: <ReviewQueuesScreen /> },
      { path: "review-queues/:id", element: <QueueDetailScreen /> },
      { path: "criteria", element: <CriteriaScreen /> },
      { path: "human-truth", element: <HumanTruthScreen /> },
      { path: "analyze", element: <AnalyzeScreen /> },
      { path: "human-truth/new/:kind", element: <HumanTruthCreateScreen /> },
      { path: "human-truth/batches/:batchId/items/:itemId/resolve", element: <HumanTruthResolutionScreen /> },
      { path: "skill", element: <SkillScreen /> },
      { path: "skill/edit", element: <SkillEditScreen /> },
      { path: "skill/versions", element: <SkillVersionsScreen /> },
      { path: "skill/versions/:id", element: <SkillVersionDetailScreen /> },
      { path: "skill/compare", element: <CompareVersionsScreen /> },
      { path: "golden", element: <GoldenScreen /> },
      { path: "datasets", element: <DatasetsScreen /> },
      { path: "compare-runs", element: <CompareRunsScreen /> },
      { path: "integrations", element: <IntegrationsScreen /> },
      { path: "settings", element: <SettingsScreen /> },
      { path: "*", element: <NotFoundScreen /> }
    ]
  }
]);

export function App() {
  const [setupState, setSetupState] = useState<{ setupRequired: boolean; authEnabled: boolean } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    fetchSetupState()
      .then(setSetupState)
      .catch((err) => setSetupError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (setupError) {
    return (
      <ThemeProvider>
        <div className="min-h-screen grid place-items-center px-6">
          <ApiUnavailableScreen
            retry={() => {
              setSetupError(null);
              fetchSetupState()
                .then(setSetupState)
                .catch((err) => setSetupError(err instanceof Error ? err.message : String(err)));
            }}
          />
        </div>
      </ThemeProvider>
    );
  }

  if (!setupState) {
    return (
      <ThemeProvider>
        <FullScreen title="Loading Coeval" description="Checking setup state." />
      </ThemeProvider>
    );
  }

  if (setupState.setupRequired) {
    return (
      <ThemeProvider>
        <SetupScreen onDone={() => setSetupState({ setupRequired: false, authEnabled: true })} />
      </ThemeProvider>
    );
  }

  // Demo mode: the API runs on in-memory fixtures with Better Auth unmounted
  // (`authEnabled: false`). There's no session endpoint to gate on, so skip
  // AuthGate and render the seeded DemoRepository dashboard directly.
  return (
    <ThemeProvider>
      <AppModeProvider authEnabled={setupState.authEnabled}>
        {setupState.authEnabled ? (
          <AuthGate>
            <RouterProvider router={router} />
          </AuthGate>
        ) : (
          <RouterProvider router={router} />
        )}
      </AppModeProvider>
    </ThemeProvider>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.isPending) {
    return <FullScreen title="Loading session" description="Checking your Coeval session." />;
  }
  if (!session.data) {
    return <LoginScreen />;
  }
  return <>{children}</>;
}

function FullScreen({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="text-center">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-3">Coeval</div>
        <div className="mt-2 font-serif text-[24px] font-medium tracking-[-0.02em]">{title}</div>
        <div className="mt-2 text-[13px] text-ink-3 max-w-md">{description}</div>
      </div>
    </div>
  );
}

export { Outlet };
