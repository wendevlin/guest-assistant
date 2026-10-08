import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";

const FILES = ["guest-assistant.db", "guest-assistant.db-wal", "guest-assistant.db-shm"];

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

/**
 * The data directory holds the proxy's HA token, the guests' password hashes
 * and their sessions. The README promises 0600 files in a 0700 directory;
 * these tests catch a start-up that leaves them readable for other users.
 */
describe("data directory modes", () => {
  let root: string;
  let umask: number;

  beforeEach(() => {
    // The usual umask: new files would be 0644 and directories 0755.
    umask = process.umask(0o022);
    root = mkdtempSync(join(tmpdir(), "ga-deploy-"));
  });

  afterEach(() => {
    process.umask(umask);
    rmSync(root, { recursive: true, force: true });
  });

  test("a new database is private, also after writes", () => {
    const dataDir = join(root, "data");
    const store = Store.open(dataDir);
    store.set("public_url", "https://guests.example");
    expect(mode(dataDir)).toBe("700");
    for (const file of FILES) expect(mode(join(dataDir, file))).toBe("600");
    store.db.close();
  });

  test("an existing directory and database with looser modes are tightened on start", () => {
    // As left by an older version, or a directory the Supervisor mounted.
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o755);
    const old = new Database(join(dataDir, "guest-assistant.db"), { create: true });
    old.exec("PRAGMA journal_mode = WAL");
    old.exec("CREATE TABLE old (x)");
    for (const file of FILES) expect(mode(join(dataDir, file))).toBe("644");

    const store = Store.open(dataDir);
    expect(mode(dataDir)).toBe("700");
    for (const file of FILES) expect(mode(join(dataDir, file))).toBe("600");
    store.db.close();
    old.close();
  });
});
