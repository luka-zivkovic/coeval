import { createContext, useContext } from "react";

export interface AppMode {
  /** True when the API has Better Auth mounted (Postgres configured). */
  authEnabled: boolean;
  /** True when the API is running on in-memory demo fixtures (no auth, no persistence). */
  demoMode: boolean;
}

const AppModeContext = createContext<AppMode>({ authEnabled: true, demoMode: false });

export function AppModeProvider({
  authEnabled,
  children
}: {
  authEnabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <AppModeContext.Provider value={{ authEnabled, demoMode: !authEnabled }}>
      {children}
    </AppModeContext.Provider>
  );
}

export function useAppMode(): AppMode {
  return useContext(AppModeContext);
}
