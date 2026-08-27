import { createAuthClient } from "better-auth/react";

const client: any = createAuthClient({
  // Same-origin by default: dev goes through the vite proxy, prod through
  // the deployment origin. VITE_API_URL remains the explicit override.
  baseURL: import.meta.env.VITE_API_URL ?? window.location.origin
});

export const authClient = client;
export const signIn = client.signIn;
export const signOut = client.signOut;
export const useSession = client.useSession;
