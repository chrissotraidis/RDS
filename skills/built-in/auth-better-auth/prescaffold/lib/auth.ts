// RDS prescaffold: auth-better-auth server initialization.
// Builders: import { auth } from "@/lib/auth" anywhere you need server-side
// session handling. Do not roll a custom auth flow alongside this.
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
});

export type Auth = typeof auth;
