<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Plus from "@lucide/svelte/icons/plus";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import { api, type DashboardsView, type DashboardView, type QuestionView, type ThemeSettings } from "$lib/api";
  import { message } from "$lib/errors";
  import { t } from "$lib/i18n";
  import ConfirmDialog from "$lib/widgets/ConfirmDialog.svelte";
  import Spinner from "$lib/widgets/Spinner.svelte";
  import ThemeEditor from "$lib/widgets/ThemeEditor.svelte";
  import AddDashboard from "./AddDashboard.svelte";
  import Analysis from "./Analysis.svelte";
  import StatusBadges from "./StatusBadges.svelte";

  let { themes }: { themes: string[] } = $props();

  let data = $state<DashboardsView | null>(null);
  let error = $state<string | null>(null);
  let open = $state<string | null>(null);
  let adding = $state(false);
  /** Dashboard id that was just saved, for a short confirmation. */
  let saved = $state<string | null>(null);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let removing = $state<DashboardView | null>(null);
  let confirmOpen = $state(false);

  async function load() {
    try {
      data = await api.dashboards();
      if (open === null && data.configured.length === 1) open = data.configured[0]!.id;
    } catch (err) {
      error = message(err);
    }
  }

  async function run(action: () => Promise<DashboardsView>): Promise<boolean> {
    error = null;
    try {
      data = await action();
      return true;
    } catch (err) {
      error = message(err);
      return false;
    }
  }

  /** Changes take effect immediately; a short "Saved" confirms it. */
  async function save(id: string, changes: { theme?: ThemeSettings; answers?: Record<string, string> }) {
    if (!(await run(() => api.updateDashboard(id, changes)))) return;
    saved = id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved = null), 2500);
  }

  /** Stored answers plus the new one; the server replaces the whole set. */
  function answer(d: DashboardView, q: QuestionView, value: string) {
    const answers: Record<string, string> = {};
    for (const other of d.questions) if (other.answered) answers[other.key] = other.answer;
    answers[q.key] = value;
    void save(d.id, { answers });
  }

  $effect(() => {
    void load();
  });
</script>

{#if !data}
  {#if error}
    <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
  {:else}
    <Spinner />
  {/if}
{:else}
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <p class="max-w-2xl text-sm text-muted-foreground">{t("dash.intro")}</p>
      {#if !adding}
        <Button onclick={() => (adding = true)}><Plus class="size-4" />{t("dash.add")}</Button>
      {/if}
    </div>

    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}

    {#if adding}
      <AddDashboard
        available={data.available}
        {themes}
        onadded={(result, id) => {
          data = result;
          adding = false;
          open = id;
        }}
        oncancel={() => (adding = false)}
        onerror={(m) => (error = m)}
      />
    {/if}

    {#if data.configured.length === 0 && !adding}
      <p class="text-sm text-muted-foreground">{t("dash.empty")}</p>
    {/if}

    {#each data.configured as d (d.id)}
      {@const isOpen = open === d.id}
      <Card.Root class="gap-0 py-0">
        <button
          type="button"
          class="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left sm:flex-nowrap"
          aria-expanded={isOpen}
          onclick={() => (open = isOpen ? null : d.id)}
        >
          <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform {isOpen ? 'rotate-90' : ''}" />
          <span class="grid min-w-0 flex-1">
            <span class="truncate font-medium">{d.title}</span>
            <span class="truncate text-sm text-muted-foreground">/{d.id}</span>
          </span>
          {#if saved === d.id}
            <span class="flex items-center gap-1 text-sm text-success" role="status"><Check class="size-4" />{t("saved")}</span>
          {/if}
          <span class="w-full ps-7 sm:w-auto sm:ps-0"><StatusBadges dashboard={d} /></span>
        </button>
        {#if isOpen}
          <Separator />
          <div class="grid gap-6 px-5 py-5">
            <Analysis dashboard={d} onanswer={(q, value) => answer(d, q, value)} />
            <Separator />
            <section class="grid gap-3">
              <h3 class="font-medium">{t("dash.theme")}</h3>
              <ThemeEditor value={d.theme} {themes} onchange={(theme) => save(d.id, { theme })} />
            </section>
            <Separator />
            <div>
              <Button variant="ghost" class="text-destructive hover:text-destructive" onclick={() => ((removing = d), (confirmOpen = true))}>{t("dash.remove")}</Button>
            </div>
          </div>
        {/if}
      </Card.Root>
    {/each}
  </div>
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title={removing ? t("dash.remove_confirm", { name: removing.title, count: removing.guests }) : ""}
  action={t("dash.remove")}
  onconfirm={() => {
    const d = removing;
    removing = null;
    if (d) void run(() => api.removeDashboard(d.id));
  }}
/>
