import { describe, expect, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import { decide, findQuestions, isInsideDashboard, rewriteForGuests } from "../src/dashboard/interactions";
import { normalizeHaUrl } from "../src/ha/endpoint";
import { isLocalAddress } from "../src/ha/provision";
import { LINKS_DASHBOARD } from "./mock-ha";

describe("navigation", () => {
  test("paths inside the dashboard", () => {
    expect(isInsideDashboard("/guest", "/guest")).toBe(true);
    expect(isInsideDashboard("/guest/kitchen", "/guest")).toBe(true);
    expect(isInsideDashboard("/guest?edit=1", "/guest")).toBe(true);
    expect(isInsideDashboard("/guest#popup", "/guest")).toBe(true);
    expect(isInsideDashboard("/guest-other", "/guest")).toBe(false);
    expect(isInsideDashboard("/config", "/guest")).toBe(false);
    expect(isInsideDashboard("guest/kitchen", "/guest")).toBe(false);
  });

  test("the default dashboard is /lovelace", () => {
    const qs = findQuestions({ views: [{ cards: [{ type: "button", tap_action: { action: "navigate", navigation_path: "/lovelace/1" } }] }] }, null, []);
    expect(qs.map((q) => q.kind)).toEqual(["navigate_view"]);
  });
});

describe("questions and rewriting", () => {
  test("same link in several cards is one question", () => {
    const card = { type: "button", tap_action: { action: "url", url_path: "https://a.example" } };
    const qs = findQuestions({ views: [{ cards: [card, card] }] }, "d", []);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.paths).toHaveLength(2);
  });

  test("unknown or unapproved links are blocked, approved ones kept", () => {
    const config = {
      views: [
        {
          cards: [
            { type: "button", entity: "light.a", tap_action: { action: "url", url_path: "https://ok.example" } },
            { type: "button", entity: "light.a", double_tap_action: { action: "url", url_path: "https://new.example" } },
            { type: "button", entity: "light.a", tap_action: { action: "navigate", navigation_path: "/d/2" } },
            { type: "button", entity: "light.a", tap_action: { action: "navigate", navigation_path: "/other" } },
            { type: "button", entity: "light.a", tap_action: { action: "navigate" } },
            { type: "entities", entities: [{ entity: "light.a", tap_action: { action: "url", url_path: "https://new.example" } }] },
          ],
        },
      ],
    };
    const out = rewriteForGuests(config, "d", { allowedUrls: new Set(["https://ok.example"]), groupablePlayers: new Set() }) as any;
    const cards = out.views[0].cards;
    expect(cards[0].tap_action).toEqual({ action: "url", url_path: "https://ok.example" });
    expect(cards[1].double_tap_action).toEqual({ action: "none" });
    expect(cards[2].tap_action).toEqual({ action: "navigate", navigation_path: "/d/2" });
    expect(cards[3].tap_action).toEqual({ action: "none" });
    expect(cards[4].tap_action).toEqual({ action: "none" });
    expect(cards[5].entities[0].tap_action).toEqual({ action: "none" });
    // the input is not modified
    expect(config.views[0]!.cards[1]!.double_tap_action!.action).toBe("url");
  });

  test("a button that only held a blocked link disappears; others stay", () => {
    const deadButton = { type: "button", name: "Music", icon: "mdi:music", tap_action: { action: "navigate", navigation_path: "/music" } };
    const config = {
      views: [
        {
          sections: [
            {
              cards: [
                deadButton,
                { type: "button", entity: "light.a", tap_action: { action: "url", url_path: "https://x.example" } },
                { type: "button", name: "Sub", tap_action: { action: "navigate", navigation_path: "/d/sub" } },
                { type: "button", name: "Ok", tap_action: { action: "url", url_path: "https://ok.example" } },
                { type: "button", name: "Hold", tap_action: { action: "url", url_path: "https://x.example" }, hold_action: { action: "navigate", navigation_path: "/d/2" } },
                { type: "conditional", conditions: [], card: deadButton },
              ],
            },
          ],
        },
      ],
    };
    const out = rewriteForGuests(config, "d", { allowedUrls: new Set(["https://ok.example"]), groupablePlayers: new Set() }) as any;
    const cards = out.views[0].sections[0].cards;
    expect(cards.map((c: any) => c.name ?? c.entity ?? c.type)).toEqual(["light.a", "Sub", "Ok", "Hold", "conditional"]);
    expect(cards[0].tap_action).toEqual({ action: "none" });
    // a single card slot cannot be emptied, the button stays inert
    expect(cards[4].card.tap_action).toEqual({ action: "none" });
  });

  test("invalid answers count as unanswered", () => {
    const qs = findQuestions(LINKS_DASHBOARD, "links-dash", ["media_player.living"]);
    const decisions = decide(qs, { "url:https://example.com/wifi": "yes-please", "media_group:media_player.living": "everything" });
    expect(decisions.allowedUrls.size).toBe(0);
    expect(decisions.groupablePlayers.size).toBe(0);
  });

  test("only groupable players on the dashboard raise grouping questions", () => {
    const d = new Dashboard("links-dash");
    d.applyConfig(LINKS_DASHBOARD, ["media_player.living", "media_player.elsewhere"]);
    expect(d.questions.filter((q) => q.kind === "media_group").map((q) => q.subject)).toEqual(["media_player.living"]);
  });

  test("navigate and url actions no longer reject a dashboard", () => {
    const d = new Dashboard("links-dash");
    d.applyConfig(LINKS_DASHBOARD);
    expect(d.status).toBe("ok");
    expect(d.entities.has("light.bedroom")).toBe(true);
  });
});

describe("HA addresses", () => {
  test("normalizes what admins type", () => {
    expect(normalizeHaUrl("homeassistant.local")).toBe("http://homeassistant.local:8123");
    expect(normalizeHaUrl("192.168.0.2:8123")).toBe("http://192.168.0.2:8123");
    expect(normalizeHaUrl("https://ha.example.com/lovelace/0")).toBe("https://ha.example.com");
    expect(normalizeHaUrl(" http://ha:8123/ ")).toBe("http://ha:8123");
    expect(() => normalizeHaUrl("ftp://ha")).toThrow();
    expect(() => normalizeHaUrl("http://user:pw@ha")).toThrow();
  });

  test("local addresses get a local-only proxy user", () => {
    expect(isLocalAddress("http://192.168.0.2:8123")).toBe(true);
    expect(isLocalAddress("http://homeassistant.local:8123")).toBe(true);
    expect(isLocalAddress("http://homeassistant:8123")).toBe(true);
    expect(isLocalAddress("http://10.1.2.3")).toBe(true);
    expect(isLocalAddress("http://[fd00::1]:8123")).toBe(true);
    expect(isLocalAddress("https://green.example.com")).toBe(false);
    expect(isLocalAddress("http://8.8.8.8")).toBe(false);
  });
});
