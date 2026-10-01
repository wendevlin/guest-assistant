/**
 * Things on a dashboard the proxy cannot decide on its own. Instead of
 * rejecting the dashboard, each one becomes a question for the admin. Until
 * it is answered the restrictive option applies, so a dashboard edit never
 * widens what guests can do without the admin knowing.
 *
 * - `navigate_view`: a navigate action to a view of the same dashboard.
 *   All views are part of the analysed config, so this is safe; the admin
 *   is only informed.
 * - `navigate_outside`: a navigate action to another dashboard or panel.
 *   Guests can never open those, so the action is removed; informational.
 * - `url`: an action that opens a web page. Blocked unless allowed.
 * - `media_group`: a media player that supports grouping. Guests may only
 *   group it with players on the same dashboard, and only if allowed.
 */
import { isObj, type Obj } from "./extract";

export type QuestionKind = "navigate_view" | "navigate_outside" | "url" | "media_group";

const QUESTION_OPTIONS: Record<QuestionKind, { options: readonly string[]; restrictive: string; informational: boolean }> = {
  navigate_view: { options: ["ok"], restrictive: "ok", informational: true },
  navigate_outside: { options: ["ok"], restrictive: "ok", informational: true },
  url: { options: ["allow", "block"], restrictive: "block", informational: false },
  media_group: { options: ["dashboard", "none"], restrictive: "none", informational: false },
};

export interface Question {
  /** Stable across edits: answers are stored under this key. */
  key: string;
  kind: QuestionKind;
  /** The navigation path, URL or entity id the question is about. */
  subject: string;
  /** Where in the dashboard config it appears. */
  paths: string[];
  options: readonly string[];
  restrictive: string;
  informational: boolean;
}

export const ACTION_KEYS = new Set([
  "tap_action",
  "hold_action",
  "double_tap_action",
  "icon_tap_action",
  "icon_hold_action",
  "icon_double_tap_action",
]);

/** Media players with MediaPlayerEntityFeature.GROUPING. */
export const MEDIA_PLAYER_GROUPING = 524288;

function dashboardPrefix(urlPath: string | null): string {
  return `/${urlPath ?? "lovelace"}`;
}

/** Whether a navigation path stays inside the dashboard with the given prefix. */
export function isInsideDashboard(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const next = path.charAt(prefix.length);
  return path.startsWith(prefix) && (next === "/" || next === "?" || next === "#");
}

export function findQuestions(config: Obj, urlPath: string | null, groupablePlayers: Iterable<string>): Question[] {
  const prefix = dashboardPrefix(urlPath);
  const questions = new Map<string, Question>();
  const add = (kind: QuestionKind, subject: string, path: string) => {
    const key = `${kind === "navigate_view" || kind === "navigate_outside" ? "navigate" : kind}:${subject}`;
    const existing = questions.get(key);
    if (existing) {
      existing.paths.push(path);
      return;
    }
    questions.set(key, { key, kind, subject, paths: [path], ...QUESTION_OPTIONS[kind] });
  };

  walkActions(config, "$", (action, path) => {
    if (action.action === "navigate" && typeof action.navigation_path === "string") {
      add(isInsideDashboard(action.navigation_path, prefix) ? "navigate_view" : "navigate_outside", action.navigation_path, path);
    } else if (action.action === "url" && typeof action.url_path === "string") {
      add("url", action.url_path, path);
    }
  });

  for (const entityId of [...groupablePlayers].sort()) add("media_group", entityId, "$");
  return [...questions.values()];
}

/** The decisions that follow from the answers, applying the restrictive option where unanswered. */
export interface Decisions {
  allowedUrls: ReadonlySet<string>;
  groupablePlayers: ReadonlySet<string>;
}

export function decide(questions: readonly Question[], answers: Readonly<Record<string, string>>): Decisions {
  const allowedUrls = new Set<string>();
  const groupablePlayers = new Set<string>();
  for (const q of questions) {
    const answer = effectiveAnswer(q, answers);
    if (q.kind === "url" && answer === "allow") allowedUrls.add(q.subject);
    if (q.kind === "media_group" && answer === "dashboard") groupablePlayers.add(q.subject);
  }
  return { allowedUrls, groupablePlayers };
}

export function effectiveAnswer(q: Question, answers: Readonly<Record<string, string>>): string {
  const answer = answers[q.key];
  return answer !== undefined && q.options.includes(answer) ? answer : q.restrictive;
}

export function isAnswered(q: Question, answers: Readonly<Record<string, string>>): boolean {
  const answer = answers[q.key];
  return answer !== undefined && q.options.includes(answer);
}

/**
 * The dashboard config as guests get it: navigation outside the dashboard
 * and web links the admin has not allowed are replaced by `action: none`.
 * A button card without an entity whose only purpose was such a link is
 * removed entirely, so guests do not see a button that does nothing.
 * Works on any config, also one HA changed since the last analysis: unknown
 * links are blocked.
 */
export function rewriteForGuests(config: unknown, urlPath: string | null, decisions: Decisions): unknown {
  const prefix = dashboardPrefix(urlPath);

  const isBlocked = (action: Obj): boolean => {
    if (action.action === "navigate") {
      return typeof action.navigation_path !== "string" || !isInsideDashboard(action.navigation_path, prefix);
    }
    if (action.action === "url") {
      return typeof action.url_path !== "string" || !decisions.allowedUrls.has(action.url_path);
    }
    return false;
  };

  /** Returns the rewritten node, or null for a card that should disappear. */
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      // Only list entries can be dropped; a single `card:` keeps its dead button.
      return node.flatMap((item) => {
        const out = rewriteObject(item);
        return out.dead ? [] : [out.value];
      });
    }
    return rewriteObject(node).value;
  };

  const rewriteObject = (node: unknown): { value: unknown; dead: boolean } => {
    if (!isObj(node)) return { value: Array.isArray(node) ? rewrite(node) : node, dead: false };
    const out: Obj = {};
    let blocked = false;
    for (const [key, value] of Object.entries(node)) {
      if (ACTION_KEYS.has(key) && isObj(value) && isBlocked(value)) {
        out[key] = { action: "none" };
        blocked = true;
      } else {
        out[key] = rewrite(value);
      }
    }
    return { value: out, dead: blocked && isDeadButton(out) };
  };

  return rewrite(config);
}

/** A button card without entity whose actions all do nothing. */
function isDeadButton(card: Obj): boolean {
  if (card.type !== "button" || card.entity !== undefined) return false;
  return [...ACTION_KEYS].every((key) => {
    const action = card[key];
    return action === undefined || (isObj(action) && action.action === "none");
  });
}

function walkActions(node: unknown, path: string, visit: (action: Obj, path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkActions(item, `${path}[${i}]`, visit));
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;
    if (ACTION_KEYS.has(key) && isObj(value)) visit(value, childPath);
    walkActions(value, childPath, visit);
  }
}
