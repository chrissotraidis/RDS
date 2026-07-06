// RDS prescaffold: drizzle-introspect-skill schema entry point.
// Builders: define all tables here using drizzle-orm/pg-core. Other files
// should import types from this module rather than re-declaring tables.
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Placeholder table. Replace with real tables once the product schema is known.
export const _rdsHealth = pgTable("_rds_health", {
  id: serial("id").primaryKey(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
