import { expect, test } from "bun:test";

/**
 * The Supervisor shows guest_assistant/CHANGELOG.md before an update, so a
 * version that reaches main without its entry ships without release notes.
 */
const versions = (changelog: string) => [...changelog.matchAll(/^## (\S+)/gm)].map((m) => m[1]);

test("the changelog starts with the version in config.yaml", async () => {
  const config = await Bun.file("guest_assistant/config.yaml").text();
  const version = /^version:\s*"?([^"\s]+)"?\s*$/m.exec(config)?.[1];
  expect(version).toBeDefined();
  expect(versions(await Bun.file("guest_assistant/CHANGELOG.md").text())[0]).toBe(version);
});

test("the changelog has one entry per version", async () => {
  const all = versions(await Bun.file("guest_assistant/CHANGELOG.md").text());
  expect(new Set(all).size).toBe(all.length);
});
