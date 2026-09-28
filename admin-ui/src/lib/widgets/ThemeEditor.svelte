<!--
  Edits ThemeSettings. With `inherit` (guest overrides) every field can also
  be left to the dashboard.
-->
<script lang="ts">
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import type { ThemeSettings } from "$lib/api";
  import { t } from "$lib/i18n";

  let {
    value,
    themes = [],
    inherit = false,
    onchange,
  }: { value: ThemeSettings; themes?: string[]; inherit?: boolean; onchange: (value: ThemeSettings) => void } = $props();

  const INHERIT = "__inherit";
  const DEFAULT = "__default";
  const uid = Math.random().toString(36).slice(2, 8);

  function set(patch: Partial<Record<keyof ThemeSettings, unknown>>) {
    const next: Record<string, unknown> = { ...value, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    onchange(next as ThemeSettings);
  }

  const nameValue = $derived(value.name ?? (inherit ? INHERIT : DEFAULT));
  const modeValue = $derived(value.mode ?? (inherit ? INHERIT : "auto"));
  const switchValue = $derived(value.guest_can_change_mode === undefined ? (inherit ? INHERIT : "no") : value.guest_can_change_mode ? "yes" : "no");
  const themeNames = $derived(value.name && !themes.includes(value.name) ? [...themes, value.name] : themes);

  const modeLabel = (m: string) => (m === INHERIT ? t("theme.inherit") : t(`theme.mode.${m as "auto"}`));
  const switchLabel = (s: string) => (s === INHERIT ? t("theme.inherit") : s === "yes" ? t("theme.switch.yes") : t("theme.switch.no"));
</script>

<div class="grid gap-4 sm:grid-cols-3">
  <div class="grid gap-2">
    <Label for="theme-name-{uid}">{t("theme.name")}</Label>
    <Select.Root
      type="single"
      value={nameValue}
      onValueChange={(v) => set({ name: v === INHERIT || v === DEFAULT ? undefined : v })}
    >
      <Select.Trigger id="theme-name-{uid}" class="w-full">
        {nameValue === INHERIT ? t("theme.inherit") : nameValue === DEFAULT ? t("theme.default") : nameValue}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={inherit ? INHERIT : DEFAULT} label={inherit ? t("theme.inherit") : t("theme.default")} />
        {#each themeNames as name (name)}
          <Select.Item value={name} label={name} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="grid gap-2">
    <Label for="theme-mode-{uid}">{t("theme.mode")}</Label>
    <Select.Root type="single" value={modeValue} onValueChange={(v) => set({ mode: v === INHERIT ? undefined : v })}>
      <Select.Trigger id="theme-mode-{uid}" class="w-full">{modeLabel(modeValue)}</Select.Trigger>
      <Select.Content>
        {#if inherit}<Select.Item value={INHERIT} label={t("theme.inherit")} />{/if}
        {#each ["auto", "light", "dark"] as m (m)}
          <Select.Item value={m} label={modeLabel(m)} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="grid gap-2">
    <Label for="theme-switch-{uid}">{t("theme.switch")}</Label>
    <Select.Root
      type="single"
      value={switchValue}
      onValueChange={(v) => set({ guest_can_change_mode: v === INHERIT ? undefined : v === "yes" })}
    >
      <Select.Trigger id="theme-switch-{uid}" class="w-full">{switchLabel(switchValue)}</Select.Trigger>
      <Select.Content>
        {#if inherit}<Select.Item value={INHERIT} label={t("theme.inherit")} />{/if}
        <Select.Item value="yes" label={t("theme.switch.yes")} />
        <Select.Item value="no" label={t("theme.switch.no")} />
      </Select.Content>
    </Select.Root>
  </div>
</div>
