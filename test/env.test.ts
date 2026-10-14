import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppOptions } from "../src/env";

// With host networking the guest port is an app option: a wrong reading
// would open the default port instead of the one the admin chose.

let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test("the guest port comes from the app's options", () => {
  dir = mkdtempSync(join(tmpdir(), "ga-options-"));
  expect(readAppOptions(dir)).toEqual({});
  writeFileSync(join(dir, "options.json"), JSON.stringify({ port: 3124 }));
  expect(readAppOptions(dir)).toEqual({ port: 3124 });
  for (const port of [0, 70000, "3124", 31.5]) {
    writeFileSync(join(dir, "options.json"), JSON.stringify({ port }));
    expect(readAppOptions(dir)).toEqual({});
  }
  writeFileSync(join(dir, "options.json"), "{not json");
  expect(readAppOptions(dir)).toEqual({});
});
