import { describe, expect, test } from "bun:test";
import { frontendLine, nextVersion, readVersion, updateChangelog, writeVersion } from "../scripts/bump-version";

/**
 * frontend-update.yaml opens the pin pull requests with these versions and
 * changelog entries. A wrong version is offered by the Supervisor as an
 * update (or never), and a broken changelog fails changelog.test.ts on the
 * bot's pull request, so the rules are checked here.
 */
describe("nextVersion", () => {
  const tags = (...names: string[]) => (tag: string) => names.includes(tag);

  test("a released stable version gets the next patch", () => {
    expect(nextVersion("stable", "0.8.0", tags("v0.8.0"))).toBe("0.8.1");
  });

  test("a released beta gets the next beta number", () => {
    expect(nextVersion("beta", "0.9.0-beta.2", tags("beta-v0.9.0-beta.2"))).toBe("0.9.0-beta.3");
  });

  test("a beta whose version went stable moves past it", () => {
    expect(nextVersion("beta", "0.9.0-beta.5", tags("beta-v0.9.0-beta.5", "v0.9.0"))).toBe("0.9.1-beta.1");
  });

  test("a version without a release tag stays", () => {
    expect(nextVersion("stable", "0.8.1", tags("v0.8.0"))).toBeNull();
    // The stable app's tags do not count for the beta and the other way round.
    expect(nextVersion("beta", "0.9.0-beta.3", tags("v0.9.0-beta.3"))).toBeNull();
    expect(nextVersion("stable", "0.9.0", tags("beta-v0.9.0"))).toBeNull();
  });
});

test("the version in config.yaml is replaced in place", () => {
  const config = 'name: Guest Assistant\nversion: "0.8.0"\nslug: guest_assistant\n';
  expect(readVersion(config)).toBe("0.8.0");
  expect(writeVersion(config, "0.8.1")).toBe('name: Guest Assistant\nversion: "0.8.1"\nslug: guest_assistant\n');
});

describe("updateChangelog", () => {
  const changelog = "# Changelog\n\n## 0.8.0\n\n- Something new.\n  Wrapped.\n\n## 0.7.2\n\n- Older.\n";
  const line = frontendLine("2026.10.1");

  test("a new version gets its own entry on top", () => {
    expect(updateChangelog(changelog, "0.8.1", line)).toBe(
      `# Changelog\n\n## 0.8.1\n\n${line}\n\n## 0.8.0\n\n- Something new.\n  Wrapped.\n\n## 0.7.2\n\n- Older.\n`,
    );
  });

  test("an unreleased entry gets the line at its end", () => {
    expect(updateChangelog(changelog, "0.8.0", line)).toBe(
      `# Changelog\n\n## 0.8.0\n\n- Something new.\n  Wrapped.\n${line}\n\n## 0.7.2\n\n- Older.\n`,
    );
  });

  test("a later frontend replaces the line written before", () => {
    const once = updateChangelog(changelog, "0.8.1", frontendLine("2026.11.0b0"));
    const twice = updateChangelog(once, "0.8.1", frontendLine("2026.11.0b1"));
    expect(twice).toBe(updateChangelog(changelog, "0.8.1", frontendLine("2026.11.0b1")));
    expect(twice).not.toContain("2026.11.0b0");
  });

  test("the only entry can be updated too", () => {
    const only = "# Changelog\n\n## 0.9.0-beta.3\n\n" + frontendLine("2026.11.0b0") + "\n";
    expect(updateChangelog(only, "0.9.0-beta.3", frontendLine("2026.11.0b1"))).toBe(
      "# Changelog\n\n## 0.9.0-beta.3\n\n" + frontendLine("2026.11.0b1") + "\n",
    );
  });
});

test("only a Home Assistant beta gets the warning about older versions", () => {
  expect(frontendLine("2026.10.1")).toBe("- The guest page is built on the Home Assistant 2026.10.1 frontend.");
  expect(frontendLine("2026.11.0b2")).toContain("meant for that Home Assistant beta");
});
