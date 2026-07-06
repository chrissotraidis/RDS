// RDS prescaffold: auth-better-auth catch-all route handler.
// Mounts better-auth's HTTP endpoints at /api/auth/*. Do not delete or rename.
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { POST, GET } = toNextJsHandler(auth);
