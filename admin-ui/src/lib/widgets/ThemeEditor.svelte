<!-- Edits the ThemeSettings of a dashboard. -->
<script lang="ts">
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import type { ThemeSettings } from "$lib/api";
  import { t } from "$lib/i18n";

  let { value, themes = [], onchange }: { value: ThemeSettings; themes?: string[]; onchange: (value: ThemeSettings) => void } = $props();

  const DEFAULT = "__default";
  const uid = Math.random().toString(36).slice(2, 8);

  function set(patch: Partial<Record<keyof ThemeSettings, unknown>>) {
    const next: Record<string, unknown> = { ...value, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    onchange(next as ThemeSettings);
  }

  const nameValue = $derived(value.name ?? DEFAULT);
  const modeValue = $derived(value.mode ?? "auto");
  const switchValue = $derived(value.guest_can_change_mode ? "yes" : "no");
  const themeNames = $derived(value.name && !themes.includes(value.name) ? [...themes, value.name] : themes);

  const modeLabel = (m: string) => t(`theme.mode.${m as "auto"}`);
</script>

<div class="grid gap-4 sm:grid-cols-3">
  <div class="grid gap-2">
    <Label for="theme-name-{uid}">{t("theme.name")}</Label>
    <Select.Root type="single" value={nameValue} onValueChange={(v) => set({ name: v === DEFAULT ? undefined : v })}>
      <Select.Trigger id="theme-name-{uid}" class="w-full">{nameValue === DEFAULT ? t("theme.default") : nameValue}</Select.Trigger>
      <Select.Content>
        <Select.Item value={DEFAULT} label={t("theme.default")} />
        {#each themeNames as name (name)}
          <Select.Item value={name} label={name} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="grid gap-2">
    <Label for="theme-mode-{uid}">{t("theme.mode")}</Label>
    <Select.Root type="single" value={modeValue} onValueChange={(v) => set({ mode: v })}>
      <Select.Trigger id="theme-mode-{uid}" class="w-full">{modeLabel(modeValue)}</Select.Trigger>
      <Select.Content>
        {#each ["auto", "light", "dark"] as m (m)}
          <Select.Item value={m} label={modeLabel(m)} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="grid gap-2">
    <Label for="theme-switch-{uid}">{t("theme.switch")}</Label>
    <Select.Root type="single" value={switchValue} onValueChange={(v) => set({ guest_can_change_mode: v === "yes" })}>
      <Select.Trigger id="theme-switch-{uid}" class="w-full">{switchValue === "yes" ? t("theme.switch.yes") : t("theme.switch.no")}</Select.Trigger>
      <Select.Content>
        <Select.Item value="yes" label={t("theme.switch.yes")} />
        <Select.Item value="no" label={t("theme.switch.no")} />
      </Select.Content>
    </Select.Root>
  </div>
</div>
