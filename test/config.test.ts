import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig, themeForUser } from "../src/config";

const base = {
  "home-assistant": { long_lived_access_token: "t" },
  dashboards: [{ id: "guest", users: [{ username: "guest", password: "long-enough-pw" }] }],
};

describe("parseConfig", () => {
  test("applies defaults", () => {
    const c = parseConfig(base);
    expect(c["home-assistant"].host).toBe("localhost");
    expect(c["home-assistant"].port).toBe(8123);
    expect(c.port).toBe(3001);
    expect(c.base_url).toBe("http://localhost:3001");
  });

  test("rejects usernames better-auth would refuse, with a readable message", () => {
    const bad = { ...base, dashboards: [{ id: "guest", users: [{ username: "probe-0", password: "long-enough-pw" }] }] };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
    expect(() => parseConfig(bad)).toThrow(/dashboards\.0\.users\.0\.username: username may only contain/);
  });

  test("rejects short passwords and missing token", () => {
    expect(() => parseConfig({ ...base, dashboards: [{ id: "g", users: [{ username: "guest", password: "short" }] }] })).toThrow(/password/);
    expect(() => parseConfig({ "home-assistant": {} })).toThrow(/long_lived_access_token/);
  });
});

describe("themeForUser", () => {
  const c = parseConfig({
    ...base,
    dashboards: [
      {
        id: "guest",
        theme: { name: "nord", mode: "dark" },
        users: [
          { username: "guest", password: "long-enough-pw" },
          { username: "Kids", password: "long-enough-pw", theme: { mode: "light", guest_can_change_mode: true } },
        ],
      },
    ],
  });

  test("user settings override single dashboard fields", () => {
    expect(themeForUser(c, "guest")).toEqual({ name: "nord", mode: "dark", guest_can_change_mode: false });
    expect(themeForUser(c, "kids")).toEqual({ name: "nord", mode: "light", guest_can_change_mode: true });
  });

  test("defaults to auto without a guest switch", () => {
    expect(themeForUser(parseConfig(base), "guest")).toEqual({ mode: "auto", guest_can_change_mode: false });
  });

  test("rejects unknown theme options", () => {
    expect(() => parseConfig({ ...base, dashboards: [{ id: "g", theme: { mode: "sepia" }, users: [] }] })).toThrow(/mode/);
    expect(() => parseConfig({ ...base, dashboards: [{ id: "g", theme: { colour: "red" }, users: [] }] })).toThrow(ConfigError);
  });
});
