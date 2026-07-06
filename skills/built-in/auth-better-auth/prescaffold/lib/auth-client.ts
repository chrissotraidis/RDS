// RDS prescaffold: auth-better-auth client.
// Builders: use this client for sign-in / sign-up / session reads from React
// components. Don't fetch /api/auth/* directly.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
});

export const { signIn, signUp, signOut, useSession } = authClient;
