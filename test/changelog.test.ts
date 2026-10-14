import { describe, expect, test } from "bun:test";

/**
 * The Supervisor shows CHANGELOG.md before an update, so a version that
 * reaches main without its entry ships without release notes. Checked for
 * the stable app and for the beta app.
 */
const APPS = [
  { folder: "guest_assistant", heading: /^\d+\.\d+\.\d+$/ },
  { folder: "guest_assistant_beta", heading: /^\d+\.\d+\.\d+-beta\.\d+$/ },
];

const headings = (text: string) => [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]);

for (const app of APPS) {
  describe(app.folder, () => {
    const changelog = () => Bun.file(`${app.folder}/CHANGELOG.md`).text();

    test("the changelog starts with the version in config.yaml", async () => {
      const config = await Bun.file(`${app.folder}/config.yaml`).text();
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
        expect(heading).toMatch(app.heading);
      }
    });
  });
}

test("the beta app can run beside the stable one", async () => {
  const stable = await Bun.file("guest_assistant/config.yaml").text();
  const beta = await Bun.file("guest_assistant_beta/config.yaml").text();
  const field = (text: string, key: string) => new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m").exec(text)?.[1];
  expect(field(beta, "slug")).toBe("guest_assistant_beta");
  expect(field(beta, "slug")).not.toBe(field(stable, "slug"));
  expect(field(beta, "image")).not.toBe(field(stable, "image"));
  // The guest port must differ from the stable app's, the ingress port is picked by the Supervisor.
  expect(field(beta, "ingress_port")).toBe("0");
  expect(/^options:\n\s+port:\s*3124$/m.test(beta)).toBe(true);
});
