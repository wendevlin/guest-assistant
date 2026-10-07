/**
 * What guests learn about allowed entities beyond their states, and the
 * features the guest UI offers for them: registry identifiers, image
 * sources, playable media, release notes, media browsing and map tiles.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import { sanitize } from "../src/dashboard/validate";
import { COMMANDS, evaluate, type CommandContext } from "../src/proxy/ws-commands";
import * as F from "../src/proxy/ws-filters";
import { GuestWs, rawGet, startTestEnv, type TestEnv } from "./helpers";

type Obj = Record<string, unknown>;

/** MediaPlayerEntityFeature.BROWSE_MEDIA */
const BROWSE_MEDIA = 131072;

function dashboard(config: Obj): Dashboard {
  const d = new Dashboard("test");
  d.applyConfig(config);
  return d;
}

function ctx(d: Dashboard): CommandContext {
  return { dashboard: d, subscriptions: new Map() };
}

const cards = (...list: Obj[]): Obj => ({ views: [{ cards: list }] });

describe("entity registry identifiers", () => {
  const d = dashboard(cards({ type: "tile", entity: "light.kitchen" }));
  const entry = (entity_id: string) => ({
    entity_id,
    unique_id: "00:17:88:01:02:03:04:05-0b",
    platform: "hue",
    options: { light: { favorite_colors: [{ hs_color: [30, 80] }] } },
  });
  const scrubbed = { entity_id: "light.kitchen", platform: "hue", options: { light: { favorite_colors: [{ hs_color: [30, 80] }] } } };

  test("unique_id (often a MAC or serial number) is left out of list, get and get_entries", () => {
    const list = [entry("light.kitchen"), entry("light.bedroom")];
    expect(COMMANDS["config/entity_registry/list"]!.filterResult!(list, ctx(d), {})).toEqual([scrubbed]);

    const get = { type: "config/entity_registry/get", entity_id: "light.kitchen" };
    expect(COMMANDS["config/entity_registry/get"]!.filterResult!(entry("light.kitchen"), ctx(d), get)).toEqual(scrubbed);

    const getEntries = { type: "config/entity_registry/get_entries", entity_ids: ["light.kitchen"] };
    const entries = { "light.kitchen": entry("light.kitchen"), "light.bedroom": entry("light.bedroom"), "light.gone": null };
    expect(COMMANDS["config/entity_registry/get_entries"]!.filterResult!(entries, ctx(d), getEntries)).toEqual({ "light.kitchen": scrubbed });

    // HA's answer itself is not changed.
    expect(list[0]!.unique_id).toBe("00:17:88:01:02:03:04:05-0b");
  });

  test("an old unique_id in entity_registry_updated is left out as well", () => {
    const original = { type: "subscribe_events", event_type: "entity_registry_updated" };
    const event = {
      event_type: "entity_registry_updated",
      data: { action: "update", entity_id: "light.kitchen", changes: { unique_id: "00:17:88:01:02:03:04:05-0b", name: "Old" } },
    };
    const out = COMMANDS.subscribe_events!.filterEvent!(event, ctx(d), original) as { data: Obj };
    expect(out.data).toEqual({ action: "update", entity_id: "light.kitchen", changes: { name: "Old" } });
  });
});

describe("image sources", () => {
  const bad = "/api/camera_proxy/camera.bedroom";

  test("every image source of cards, rows, badges and picture elements is checked", () => {
    const { config, issues } = sanitize(
      {
        views: [
          {
            badges: [{ type: "entity", entity: "light.kitchen", image: bad }, { type: "entity", entity: "lock.front" }],
            cards: [
              {
                type: "picture-elements",
                image: "/local/plan.png",
                elements: [
                  { type: "image", entity: "light.kitchen", image: bad },
                  { type: "image", entity: "light.kitchen", state_image: { on: "/local/on.png", off: bad } },
                  { type: "image", entity: "light.kitchen", dark_mode_image: bad },
                  { type: "image", entity: "light.kitchen", image: { media_content_id: bad } },
                  { type: "image", entity: "light.kitchen", image: "/local/lamp.png", state_image: { on: { media_content_id: "media-source://media_source/local/on.png" } } },
                ],
              },
              { type: "picture-entity", entity: "camera.garden", state_image: { idle: bad } },
              { type: "picture-elements", image: "/local/plan.png", dark_mode_image: bad, elements: [] },
              { type: "entities", entities: [{ entity: "light.kitchen", image: bad }, "lock.front"] },
            ],
          },
        ],
      },
      { keepPositions: true },
    );
    expect(issues.map((i) => [i.rule, i.path, i.hidden])).toEqual([
      ["image-source", "$.views[0].badges[0].image", "$.views[0].badges[0]"],
      ["image-source", "$.views[0].cards[0].elements[0].image", "$.views[0].cards[0].elements[0]"],
      ["image-source", "$.views[0].cards[0].elements[1].state_image.off", "$.views[0].cards[0].elements[1]"],
      ["image-source", "$.views[0].cards[0].elements[2].dark_mode_image", "$.views[0].cards[0].elements[2]"],
      ["image-source", "$.views[0].cards[0].elements[3].image", "$.views[0].cards[0].elements[3]"],
      ["image-source", "$.views[0].cards[1].state_image.idle", "$.views[0].cards[1]"],
      ["image-source", "$.views[0].cards[2].dark_mode_image", "$.views[0].cards[2]"],
      ["image-source", "$.views[0].cards[3].entities[0].image", "$.views[0].cards[3].entities[0]"],
    ]);
    // Only the element with the source is left out, not the card around it.
    const view = (config.views as Obj[])[0]!;
    expect(((view.cards as Obj[])[0]!.elements as unknown[]).map((e) => e !== null)).toEqual([false, false, false, false, true]);
    expect((view.cards as Obj[])[3]!.entities).toEqual([null, "lock.front"]);
  });

  test("keys of the same name outside elements are not image sources", () => {
    const { issues } = sanitize({
      views: [
        {
          background: { image: "/some/background.png" },
          cards: [
            {
              type: "button",
              entity: "light.kitchen",
              tap_action: { action: "perform-action", perform_action: "light.turn_on", target: { entity_id: "light.kitchen" }, data: { image: "x" } },
            },
          ],
        },
      ],
    });
    expect(issues).toEqual([]);
  });

  test("media-source images in state_image and dark_mode_image can be resolved", () => {
    const d = dashboard(
      cards({
        type: "picture-elements",
        image: "/local/plan.png",
        dark_mode_image: "media-source://media_source/local/dark.png",
        elements: [
          {
            type: "image",
            entity: "light.kitchen",
            state_image: { on: "media-source://media_source/local/on.png", off: { media_content_id: "media-source://media_source/local/off.png" } },
          },
        ],
      }),
    );
    const resolve = (id: string) => evaluate({ id: 1, type: "media_source/resolve_media", media_content_id: id }, ctx(d)).kind;
    expect(resolve("media-source://media_source/local/dark.png")).toBe("forward");
    expect(resolve("media-source://media_source/local/on.png")).toBe("forward");
    expect(resolve("media-source://media_source/local/off.png")).toBe("forward");
    expect(resolve("media-source://media_source/local/other.png")).toBe("reject");
  });
});

describe("play_media", () => {
  const radio = "http://radio.example/stream.mp3";
  const song = "media-source://media_source/local/song.mp3";
  const photo = "media-source://media_source/local/photo.jpg";
  const config = (station: string) =>
    cards(
      { type: "media-control", entity: "media_player.living" },
      { type: "picture", image: photo },
      {
        type: "button",
        tap_action: {
          action: "perform-action",
          perform_action: "media_player.play_media",
          target: { entity_id: "media_player.living" },
          data: { media_content_id: station, media_content_type: "music" },
        },
      },
      {
        type: "button",
        tap_action: {
          action: "call-service",
          service: "media_player.play_media",
          service_data: { entity_id: "media_player.living", media: { media_content_id: song, media_content_type: "audio/mpeg" } },
        },
      },
    );
  const d = dashboard(config(radio));
  const play = (service_data: Obj) =>
    evaluate(
      { id: 1, type: "call_service", domain: "media_player", service: "play_media", target: { entity_id: "media_player.living" }, service_data },
      ctx(d),
    ).kind;

  test("only content ids written into the dashboard's actions can be played", () => {
    expect(play({ media_content_id: radio, media_content_type: "music" })).toBe("forward");
    expect(play({ media: { media_content_id: radio, media_content_type: "music" } })).toBe("forward");
    expect(play({ media_content_id: song, media_content_type: "music" })).toBe("forward");

    expect(play({ media_content_id: "https://evil.example/a.mp3", media_content_type: "music" })).toBe("reject");
    expect(play({ media_content_id: radio, media: { media_content_id: "https://evil.example/a.mp3" } })).toBe("reject");
    expect(play({ media: "https://evil.example/a.mp3" })).toBe("reject");
    expect(play({ media_content_type: "music" })).toBe("reject");
    // An image on the dashboard can be resolved, not played.
    expect(play({ media_content_id: photo, media_content_type: "image/jpeg" })).toBe("reject");
  });

  test("a changed content id makes guests reconnect", () => {
    const changing = new Dashboard("changing");
    changing.applyConfig(config(radio));
    changing.applyConfig(config(radio));
    expect(changing.accessChanged).toBe(false);
    changing.applyConfig(config("http://other.example/stream.mp3"));
    expect(changing.accessChanged).toBe(true);
  });
});

describe("features the guest UI would offer but the proxy denies", () => {
  test("release notes of update entities on the dashboard", () => {
    const d = dashboard(cards({ type: "tile", entity: "update.core" }, { type: "tile", entity: "light.kitchen" }));
    const notes = (msg: Obj) => evaluate({ id: 1, type: "update/release_notes", ...msg }, ctx(d)).kind;
    expect(notes({ entity_id: "update.core" })).toBe("forward");
    expect(notes({ entity_id: "update.supervisor" })).toBe("reject");
    expect(notes({ entity_id: "light.kitchen" })).toBe("reject");
    expect(notes({ entity_id: "update.core", extra: 1 })).toBe("reject");
  });

  test("media players do not announce browse media, in every state format", () => {
    const A = new Set(["media_player.tv", "light.kitchen"]);
    const tv = { entity_id: "media_player.tv", state: "on", attributes: { supported_features: 1 | BROWSE_MEDIA } };
    // The bit means something else in other domains.
    const light = { entity_id: "light.kitchen", state: "on", attributes: { supported_features: BROWSE_MEDIA } };

    const states = F.filterStates([tv, light], A) as Array<{ attributes: Obj }>;
    expect(states.map((s) => s.attributes.supported_features)).toEqual([1, BROWSE_MEDIA]);
    expect(F.guestState(tv)).toEqual({ ...tv, attributes: { supported_features: 1 } });
    // HA's object is copied, not changed.
    expect(tv.attributes.supported_features).toBe(1 | BROWSE_MEDIA);

    const compressed = F.filterSubscribeEntitiesEvent(
      {
        a: { "media_player.tv": { s: "on", a: { supported_features: 1 | BROWSE_MEDIA, volume_level: 0.5 } } },
        c: { "media_player.tv": { "+": { s: "playing", a: { supported_features: 4 | BROWSE_MEDIA } }, "-": { a: ["volume_level"] } } },
      },
      A,
    );
    expect(compressed).toEqual({
      a: { "media_player.tv": { s: "on", a: { supported_features: 1, volume_level: 0.5 } } },
      c: { "media_player.tv": { "+": { s: "playing", a: { supported_features: 4 } }, "-": { a: ["volume_level"] } } },
    });

    const d = dashboard(cards({ type: "media-control", entity: "media_player.tv" }));
    const original = { type: "subscribe_events", event_type: "state_changed" };
    const event = { event_type: "state_changed", data: { entity_id: "media_player.tv", new_state: tv, old_state: tv } };
    const out = COMMANDS.subscribe_events!.filterEvent!(event, ctx(d), original) as { data: { new_state: { attributes: Obj }; old_state: { attributes: Obj } } };
    expect(out.data.new_state.attributes.supported_features).toBe(1);
    expect(out.data.old_state.attributes.supported_features).toBe(1);
    const created = { event_type: "state_changed", data: { entity_id: "media_player.tv", new_state: tv, old_state: null } };
    expect((COMMANDS.subscribe_events!.filterEvent!(created, ctx(d), original) as { data: Obj }).data.old_state).toBeNull();
  });

  test("the map tile token can be fetched, with exactly the frontend's fields", () => {
    const d = dashboard(cards({ type: "map", entities: ["person.owner"] }));
    expect(evaluate({ id: 1, type: "map_tiles/access_token" }, ctx(d))).toEqual({ kind: "forward", msg: { id: 1, type: "map_tiles/access_token" } });
    expect(evaluate({ id: 1, type: "map_tiles/access_token", user_id: "x" }, ctx(d)).kind).toBe("reject");
  });
});

describe("running a script from its more-info dialog", () => {
  // more-info calls the script's own service, script.<object_id>, without a target.
  const d = dashboard(cards({ type: "entities", entities: ["script.wake_up"] }));
  const run = (msg: Obj) => evaluate({ id: 1, type: "call_service", domain: "script", ...msg }, ctx(d));

  test("is forwarded as script.turn_on on the script entity", () => {
    for (const service_data of [undefined, {}]) {
      expect(run({ service: "wake_up", service_data })).toEqual({
        kind: "forward",
        msg: { id: 1, type: "call_service", domain: "script", service: "turn_on", target: { entity_id: ["script.wake_up"] } },
      });
    }
  });

  test("only for scripts on the dashboard and without variables", () => {
    expect(run({ service: "disarm_and_unlock_front_door" }).kind).toBe("reject");
    expect(run({ service: "wake_up", service_data: { minutes: 5 } }).kind).toBe("reject");
    expect(run({ service: "wake_up", target: { entity_id: "script.wake_up" } }).kind).toBe("reject");
    expect(run({ service: "reload" }).kind).toBe("reject");
  });
});

describe("allowlist entries no guest UI uses", () => {
  const d = dashboard(cards({ type: "tile", entity: "light.kitchen" }));

  test("are rejected", () => {
    expect(evaluate({ id: 1, type: "lovelace/resources/list" }, ctx(d)).kind).toBe("reject");
    expect(evaluate({ id: 1, type: "sensor/numeric_device_classes" }, ctx(d)).kind).toBe("reject");
    expect(evaluate({ id: 1, type: "subscribe_events", event_type: "label_registry_updated" }, ctx(d)).kind).toBe("reject");
    expect(evaluate({ id: 1, type: "subscribe_events", event_type: "category_registry_updated" }, ctx(d)).kind).toBe("reject");
    // still used
    expect(evaluate({ id: 1, type: "lovelace/resources" }, ctx(d))).toEqual({ kind: "reply", result: [] });
    expect(evaluate({ id: 1, type: "subscribe_events", event_type: "entity_registry_updated" }, ctx(d)).kind).toBe("forward");
  });
});

describe("through the proxy", () => {
  let env: TestEnv;
  let cookie: string;
  let token: string;

  beforeAll(async () => {
    env = await startTestEnv();
    // links-dash has media_player.tv, which announces BROWSE_MEDIA in mock HA.
    await env.runtime.addDashboard("links-dash");
    await env.runtime.createGuest({ username: "media", password: "media-pass-123", dashboard: "links-dash" });
    // Signed in through the API: better-auth's sign-in rate limit is shared
    // by every test in this process.
    const signIn = await env.runtime.auth.api.signInUsername({ body: { username: "media", password: "media-pass-123" }, asResponse: true });
    cookie = signIn.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    token = (await env.hassToken(cookie)).body.access_token as string;
  });
  afterAll(() => env.stop());

  const tvFeatures = (states: unknown) => (states as Array<{ entity_id: string; attributes: Obj }>).find((s) => s.entity_id === "media_player.tv")!.attributes.supported_features;

  test("states reach guests without the browse media feature", async () => {
    expect(tvFeatures(await (await fetch(`${env.url}/api/states`, { headers: { cookie } })).json())).toBe(1);
    const one = (await (await fetch(`${env.url}/api/states/media_player.tv`, { headers: { cookie } })).json()) as { attributes: Obj };
    expect(one.attributes.supported_features).toBe(1);

    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(token)).type).toBe("auth_ok");
    expect(tvFeatures((await ws.send({ type: "get_states" })).result)).toBe(1);

    const entities = await ws.send({ type: "subscribe_entities" });
    const [initial] = await ws.events(entities.id as number);
    const a = (initial!.event as { a: Record<string, { a: Obj }> }).a;
    expect(a["media_player.tv"]!.a.supported_features).toBe(1);

    const changes = await ws.send({ type: "subscribe_events", event_type: "state_changed" });
    const tv = { entity_id: "media_player.tv", state: "on", attributes: { supported_features: 1 | BROWSE_MEDIA } };
    env.ha.emitEvent("state_changed", { entity_id: "media_player.tv", new_state: tv, old_state: tv });
    const [changed] = await ws.events(changes.id as number);
    const data = (changed!.event as { data: { new_state: { attributes: Obj }; old_state: { attributes: Obj } } }).data;
    expect(data.new_state.attributes.supported_features).toBe(1);
    expect(data.old_state.attributes.supported_features).toBe(1);
    ws.close();
  });

  test("map tiles pass through for guests, with their token, and nowhere else", async () => {
    const tile = await fetch(`${env.url}/api/map_tiles/raster/3/4/2.png?token=tile-token`, { headers: { cookie } });
    expect(tile.status).toBe(200);
    expect(await tile.text()).toBe("tile /api/map_tiles/raster/3/4/2.png?token=tile-token");
    expect((await fetch(`${env.url}/api/map_tiles/raster/3/4/2.png?token=tile-token`)).status).toBe(401);
    for (const target of ["/api/map_tiles/../states", "/api/map_tiles/%2e%2e/states"]) {
      const res = await rawGet(env.url, target, { cookie });
      expect({ target, status: res.status }).toEqual({ target, status: 404 });
      expect(res.body).not.toContain("entity_id");
    }
  });

  test("HACS files are not served", async () => {
    const before = env.ha.publicRequests.length;
    expect((await fetch(`${env.url}/hacsfiles/card.js`, { headers: { cookie } })).status).toBe(404);
    expect(env.ha.publicRequests.length).toBe(before);
  });
});
