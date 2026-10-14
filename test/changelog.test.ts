import { expect, test } from "bun:test";

/**
 * The Supervisor shows guest_assistant/CHANGELOG.md before an update, so a
 * version that reaches main without its entry ships without release notes.
 */
const changelog = () => Bun.file("guest_assistant/CHANGELOG.md").text();
const headings = (text: string) => [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]);

test("the changelog starts with the version in config.yaml", async () => {
  const config = await Bun.file("guest_assistant/config.yaml").text();
  const version = /^version:\s*"?([^"\s]+)"?\s*$/m.exec(config)?.[1];
  expect(version).toBeDefined();
  expect(headings(await changelog())[0]).toBe(version);
});

test("the changelog has one entry per version", async () => {
  const all = headings(await changelog());
  expect(new Set(all).size).toBe(all.length);
});

// Home Assistant cuts the changelog for the update dialog from the heading
// "## <new version>" to "## <installed version>" (async_release_notes in
// homeassistant/components/hassio/update.py). Anything after the version in
// a heading, such as a date, makes it show the whole file instead.
test("changelog headings are bare versions", async () => {
  for (const heading of headings(await changelog())) {
    expect(heading).toMatch(/^\d+\.\d+\.\d+$/);
  }
});
