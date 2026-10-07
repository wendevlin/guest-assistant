<script lang="ts">
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { api, type DashboardsView, type DashboardView } from "$lib/api";
  import { message } from "$lib/errors";
  import Spinner from "$lib/widgets/Spinner.svelte";
  import Analysis from "./Analysis.svelte";
  import StatusBadges from "./StatusBadges.svelte";

  let {
    open = $bindable(false),
    available,
    onadded,
  }: {
    open?: boolean;
    available: DashboardsView["available"];
    onadded: (data: DashboardsView, id: string) => void;
  } = $props();

  let id = $state("");
  let preview = $state<DashboardView | null>(null);
  let loading = $state(false);
  let answers = $state<Record<string, string>>({});
  let busy = $state(false);
  let error = $state<string | null>(null);

  const candidates = $derived(available.filter((d) => !d.added));
  // From `available`, not `candidates`: once added, the dashboard leaves `candidates`
  // while the dialog is still rendered.
  const selected = $derived(available.find((d) => d.id === id));
  const label = (d: DashboardsView["available"][number]) => `${d.title} (/${d.id})${d.require_admin ? " – admins only" : ""}`;
  const shown = $derived(
    preview
      ? { ...preview, questions: preview.questions.map((q) => (q.key in answers ? { ...q, answer: answers[q.key]!, answered: true } : q)) }
      : null,
  );

  // Every opening starts empty.
  $effect(() => {
    if (!open) return;
    id = "";
    preview = null;
    answers = {};
    error = null;
  });

  async function pick(value: string) {
    id = value;
    preview = null;
    answers = {};
    error = null;
    loading = true;
    try {
      preview = await api.preview(value);
    } catch (err) {
      error = message(err);
    } finally {
      loading = false;
    }
  }

  async function add() {
    busy = true;
    error = null;
    try {
      onadded(await api.addDashboard(id, answers), id);
      open = false;
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Add a guest dashboard</Dialog.Title>
    </Dialog.Header>
    <div class="grid gap-6">
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}
      {#if candidates.length === 0}
        <p class="text-sm text-muted-foreground">All dashboards are already added.</p>
      {:else}
        <div class="grid gap-2">
          <Label for="add-dashboard">Dashboard</Label>
          <Select.Root type="single" value={id} onValueChange={pick}>
            <Select.Trigger id="add-dashboard" class="w-full">
              {selected ? label(selected) : "Choose a dashboard"}
            </Select.Trigger>
            <Select.Content>
              {#each candidates as d (d.id)}
                <Select.Item value={d.id} label={label(d)} />
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}
      {#if loading}
        <Spinner label="Analysing…" />
      {/if}
      {#if shown}
        <StatusBadges dashboard={shown} showGuests={false} />
        {#if shown.status === "rejected"}
          <Alert.Root variant="destructive"><Alert.Description>This dashboard cannot be added as a guest dashboard.</Alert.Description></Alert.Root>
        {/if}
        <Analysis dashboard={shown} onanswer={(q, value) => (answers = { ...answers, [q.key]: value })} />
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={add} disabled={!preview || preview.status !== "ok" || busy}>Add</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
