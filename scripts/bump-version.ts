/**
 * Raises an app's version and writes its changelog entry for a newly pinned
 * guest frontend. Used by .github/workflows/frontend-update.yaml after
 * scripts/pin-frontend.sh.
 *
 *   bun scripts/bump-version.ts [--beta] --core <Home Assistant release>
 *
 * - Stable (guest_assistant): 0.8.0 → 0.8.1.
 * - Beta (guest_assistant_beta): 0.9.0-beta.2 → 0.9.0-beta.3; once 0.9.0 is
 *   released as the stable app, 0.9.1-beta.1.
 * - A version on main that has no release tag yet is kept: the line goes into
 *   its entry instead, replacing an earlier line about the frontend, so a
 *   week of betas does not stack up versions nobody installed.
 *
 * Release tags are read with `git ls-remote --tags origin`. Prints the
 * version the app has afterwards.
 */
import { $ } from "bun";

export type Channel = "stable" | "beta";

export const APPS: Record<Channel, { folder: string; tagPrefix: string }> = {
  stable: { folder: "guest_assistant", tagPrefix: "v" },
  beta: { folder: "guest_assistant_beta", tagPrefix: "beta-v" },
};

/** Changelog bullets this script writes start with this. */
const FRONTEND_LINE = "- The guest page is built on the Home Assistant ";

const VERSION = /^version:\s*"?([^"\s]+)"?\s*$/m;

export function readVersion(config: string): string {
  const version = VERSION.exec(config)?.[1];
  if (!version) throw new Error("config.yaml has no version");
  return version;
}

export function writeVersion(config: string, version: string): string {
  return config.replace(VERSION, `version: "${version}"`);
}

/**
 * The version after `current`. `released(tag)` tells whether a release tag
 * exists; `null` means `current` is not released yet and stays.
 */
export function nextVersion(channel: Channel, current: string, released: (tag: string) => boolean): string | null {
  if (!released(APPS[channel].tagPrefix + current)) return null;
  if (channel === "stable") {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
    if (!m) throw new Error(`Not a stable version: ${current}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(current);
  if (!m) throw new Error(`Not a beta version: ${current}`);
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  // The beta's version went stable: the next beta tests what comes after it.
  if (released(APPS.stable.tagPrefix + base)) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-beta.1`;
  return `${base}-beta.${Number(m[4]) + 1}`;
}

export function frontendLine(core: string): string {
  // Only a beta of Home Assistant is ahead of what most installations run.
  return /b\d+$/.test(core)
    ? `${FRONTEND_LINE}${core} frontend, meant for that Home Assistant beta; on an older Home Assistant some cards may not work.`
    : `${FRONTEND_LINE}${core} frontend.`;
}

/**
 * Puts `line` into the changelog: a new entry for `version`, or, when the
 * first entry already is `version`, into that entry in place of an earlier
 * frontend line.
 */
export function updateChangelog(changelog: string, version: string, line: string): string {
  const lines = changelog.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  if (first === -1) throw new Error("CHANGELOG.md has no entry");

  if (lines[first] !== `## ${version}`) {
    lines.splice(first, 0, `## ${version}`, "", line, "");
    return lines.join("\n");
  }

  const nextHeading = lines.findIndex((l, i) => i > first && l.startsWith("## "));
  const end = nextHeading === -1 ? lines.length : nextHeading;
  // The entry's own lines, without the frontend bullet written before.
  const entry = lines.slice(first + 1, end).filter((l) => !l.startsWith(FRONTEND_LINE));
  while (entry.length > 0 && entry[entry.length - 1] === "") entry.pop();
  const body = entry.length > 0 ? [...entry, line, ""] : ["", line, ""];
  return [...lines.slice(0, first + 1), ...body, ...lines.slice(end)].join("\n");
}

async function releasedTags(): Promise<Set<string>> {
  const out = await $`git ls-remote --tags --refs origin`.text();
  return new Set(out.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => !!t));
}

async function main(args: string[]): Promise<void> {
  const channel: Channel = args.includes("--beta") ? "beta" : "stable";
  const core = args[args.indexOf("--core") + 1];
  if (!args.includes("--core") || !core) throw new Error("usage: bun scripts/bump-version.ts [--beta] --core <release>");

  const { folder } = APPS[channel];
  const configFile = Bun.file(`${folder}/config.yaml`);
  const changelogFile = Bun.file(`${folder}/CHANGELOG.md`);
  const config = await configFile.text();
  const current = readVersion(config);

  const tags = await releasedTags();
  const version = nextVersion(channel, current, (tag) => tags.has(tag)) ?? current;

  if (version !== current) await Bun.write(configFile, writeVersion(config, version));
  await Bun.write(changelogFile, updateChangelog(await changelogFile.text(), version, frontendLine(core)));
  console.log(version);
}

if (import.meta.main) await main(process.argv.slice(2));
