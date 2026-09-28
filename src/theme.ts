import z from "zod";

/**
 * How the guest UI looks. Set on a dashboard; a guest's own settings override
 * single fields of it.
 */
export const ThemeSettings = z.strictObject({
  /** Name of a theme defined in HA; omitted = HA's default theme. */
  name: z.string().min(1).max(200).optional(),
  /** auto follows the guest device's light/dark setting. */
  mode: z.enum(["auto", "light", "dark"]).optional(),
  /** Lets guests switch between auto, light and dark on their device. */
  guest_can_change_mode: z.boolean().optional(),
});

export type ThemeSettings = z.infer<typeof ThemeSettings>;

/** The effective theme handed to the guest frontend. */
export interface GuestTheme {
  name?: string;
  mode: "auto" | "light" | "dark";
  guest_can_change_mode: boolean;
}

/** Defaults, then the dashboard's settings, then the guest's own. */
export function resolveTheme(dashboard?: ThemeSettings, guest?: ThemeSettings): GuestTheme {
  return { mode: "auto", guest_can_change_mode: false, ...dropUndefined(dashboard), ...dropUndefined(guest) };
}

/** Parses a stored theme (JSON string or object); invalid data counts as "no settings". */
export function parseTheme(raw: unknown): ThemeSettings {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const result = ThemeSettings.safeParse(value ?? {});
  return result.success ? result.data : {};
}

function dropUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
