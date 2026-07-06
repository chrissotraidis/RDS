// RDS prescaffold: drizzle-introspect-skill database client.
// Builders: import the `db` export from "@/lib/db" for all SQL access.
// Do not create a parallel postgres / prisma / raw-SQL client.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const queryClient = postgres(connectionString);
export const db = drizzle(queryClient, { schema });
export { schema };
