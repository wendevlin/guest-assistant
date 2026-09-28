<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { api, type DashboardsView, type DashboardView } from "$lib/api";
  import { message } from "$lib/errors";
  import { t } from "$lib/i18n";
  import Spinner from "$lib/widgets/Spinner.svelte";
  import Analysis from "./Analysis.svelte";
  import StatusBadges from "./StatusBadges.svelte";

  let {
    available,
    onadded,
    oncancel,
    onerror,
  }: {
    available: DashboardsView["available"];
    onadded: (data: DashboardsView, id: string) => void;
    oncancel: () => void;
    onerror: (message: string) => void;
  } = $props();

  let id = $state("");
  let preview = $state<DashboardView | null>(null);
  let loading = $state(false);
  let answers = $state<Record<string, string>>({});
  let busy = $state(false);

  const candidates = $derived(available.filter((d) => !d.added));
  const label = (d: DashboardsView["available"][number]) => `${d.title} (/${d.id})${d.require_admin ? ` – ${t("dash.admin_only")}` : ""}`;
  const shown = $derived(
    preview
      ? { ...preview, questions: preview.questions.map((q) => (q.key in answers ? { ...q, answer: answers[q.key]!, answered: true } : q)) }
      : null,
  );

  async function pick(value: string) {
    id = value;
    preview = null;
    answers = {};
    loading = true;
    try {
      preview = await api.preview(value);
    } catch (err) {
      onerror(message(err));
    } finally {
      loading = false;
    }
  }

  async function add() {
    busy = true;
    try {
      onadded(await api.addDashboard(id, answers), id);
    } catch (err) {
      onerror(message(err));
    } finally {
      busy = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="text-lg">{t("dash.add_title")}</Card.Title>
  </Card.Header>
  <Card.Content class="grid gap-6">
    {#if candidates.length === 0}
      <p class="text-sm text-muted-foreground">{t("dash.none_available")}</p>
    {:else}
      <div class="grid gap-2">
        <Label for="add-dashboard">{t("dash.pick")}</Label>
        <Select.Root type="single" value={id} onValueChange={pick}>
          <Select.Trigger id="add-dashboard" class="w-full">
            {id ? label(candidates.find((d) => d.id === id)!) : t("dash.pick_placeholder")}
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
      <Spinner label={t("dash.analysing")} />
    {/if}
    {#if shown}
      <StatusBadges dashboard={shown} showGuests={false} />
      <Analysis dashboard={shown} onanswer={(q, value) => (answers = { ...answers, [q.key]: value })} />
    {/if}
  </Card.Content>
  <Card.Footer class="flex flex-wrap gap-2">
    <Button onclick={add} disabled={!preview || busy}>{t("add")}</Button>
    <Button variant="outline" onclick={oncancel}>{t("cancel")}</Button>
  </Card.Footer>
</Card.Root>
