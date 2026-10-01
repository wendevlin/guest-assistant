<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Plus from "@lucide/svelte/icons/plus";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import { Switch } from "$lib/components/ui/switch";
  import { api, type DashboardsView, type DashboardView, type QuestionView } from "$lib/api";
  import { message } from "$lib/errors";
  import ConfirmDialog from "$lib/widgets/ConfirmDialog.svelte";
  import Spinner from "$lib/widgets/Spinner.svelte";
  import AddDashboard from "./AddDashboard.svelte";
  import Analysis from "./Analysis.svelte";
  import StatusBadges from "./StatusBadges.svelte";

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
  async function save(id: string, changes: { answers?: Record<string, string>; enabled?: boolean }) {
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
      <p class="max-w-2xl text-sm text-muted-foreground">
        A guest dashboard is a permission: guests see and control exactly the entities on it. Dashboards with cards that cannot be analysed
        are rejected.
      </p>
      <Button onclick={() => (adding = true)}><Plus class="size-4" />Add dashboard</Button>
    </div>

    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}

    {#if data.configured.length === 0}
      <p class="text-sm text-muted-foreground">No guest dashboards yet.</p>
    {/if}

    {#each data.configured as d (d.id)}
      {@const isOpen = open === d.id}
      <Card.Root class="gap-0 py-0">
        <div class="flex items-center gap-3 pe-5">
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-wrap items-center gap-3 py-4 ps-5 text-left sm:flex-nowrap"
            aria-expanded={isOpen}
            onclick={() => (open = isOpen ? null : d.id)}
          >
            <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform {isOpen ? 'rotate-90' : ''}" />
            <span class="grid min-w-0 flex-1">
              <span class="truncate font-medium">{d.title}</span>
              <span class="truncate text-sm text-muted-foreground">/{d.id}</span>
            </span>
            {#if saved === d.id}
              <span class="flex items-center gap-1 text-sm text-success" role="status"><Check class="size-4" />Saved</span>
            {/if}
            <span class="w-full ps-7 sm:w-auto sm:ps-0"><StatusBadges dashboard={d} /></span>
          </button>
          <Switch
            checked={d.enabled}
            onCheckedChange={(enabled) => save(d.id, { enabled })}
            aria-label="Active"
            title={d.enabled ? "Active: guests can use it" : "Inactive: guests cannot use it"}
          />
        </div>
        {#if isOpen}
          <Separator />
          <div class="grid gap-6 px-5 py-5">
            <Analysis dashboard={d} onanswer={(q, value) => answer(d, q, value)} />
            <Separator />
            <div>
              <Button variant="ghost" class="text-destructive hover:text-destructive" onclick={() => ((removing = d), (confirmOpen = true))}
                >Remove dashboard</Button
              >
            </div>
          </div>
        {/if}
      </Card.Root>
    {/each}
  </div>

  <AddDashboard
    bind:open={adding}
    available={data.available}
    onadded={(result, id) => {
      data = result;
      open = id;
    }}
  />
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title={removing ? `Remove ${removing.title}? Its ${removing.guests} guest accounts are deleted as well.` : ""}
  action="Remove dashboard"
  onconfirm={() => {
    const d = removing;
    removing = null;
    if (d) void run(() => api.removeDashboard(d.id));
  }}
/>
