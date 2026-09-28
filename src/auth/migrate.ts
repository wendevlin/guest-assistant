import { getMigrations } from "better-auth/db/migration";
import type { Auth } from "../auth";

export async function migrate(auth: Auth): Promise<void> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  if (toBeCreated.length > 0 || toBeAdded.length > 0) {
    console.log("Running database migrations...");
    await runMigrations();
  }
}
