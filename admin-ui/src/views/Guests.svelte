<script lang="ts">
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import * as Table from "$lib/components/ui/table";
  import { api, generatePassword, type DashboardView, type Guest } from "$lib/api";
  import { message } from "$lib/errors";
  import { t } from "$lib/i18n";
  import ConfirmDialog from "$lib/widgets/ConfirmDialog.svelte";
  import Spinner from "$lib/widgets/Spinner.svelte";

  interface Draft {
    username: string;
    password: string;
    dashboard: string;
  }

  let guests = $state<Guest[] | null>(null);
  let dashboards = $state<DashboardView[]>([]);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** "new" or the id of the guest being edited */
  let editing = $state<string | null>(null);
  let draft = $state<Draft>({ username: "", password: "", dashboard: "" });
  let deleting = $state<Guest | null>(null);
  let confirmOpen = $state(false);

  const titles = $derived(new Map(dashboards.map((d) => [d.id, d.title])));

  async function load() {
    try {
      const [g, d] = await Promise.all([api.guests(), api.dashboards()]);
      guests = g;
      dashboards = d.configured;
    } catch (err) {
      error = message(err);
    }
  }

  function startNew() {
    notice = null;
    editing = "new";
    draft = { username: "", password: generatePassword(), dashboard: dashboards[0]?.id ?? "" };
  }

  function startEdit(g: Guest) {
    notice = null;
    editing = g.id;
    draft = { username: g.username, password: "", dashboard: g.dashboard };
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    try {
      if (editing === "new") {
        await api.createGuest({ ...draft });
        notice = t("guests.created", { name: draft.username, password: draft.password });
      } else if (editing) {
        await api.updateGuest(editing, { dashboard: draft.dashboard, ...(draft.password ? { password: draft.password } : {}) });
      }
      editing = null;
      await load();
    } catch (err) {
      error = message(err);
    }
  }

  async function remove(g: Guest) {
    try {
      await api.deleteGuest(g.id);
      await load();
    } catch (err) {
      error = message(err);
    }
  }

  $effect(() => {
    void load();
  });
</script>

{#if !guests}
  {#if error}
    <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
  {:else}
    <Spinner />
  {/if}
{:else}
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <p class="text-sm text-muted-foreground">{t("guests.intro")}</p>
      {#if !editing && dashboards.length > 0}
        <Button onclick={startNew}><Plus class="size-4" />{t("guests.add")}</Button>
      {/if}
    </div>
    {#if dashboards.length === 0}
      <Alert.Root variant="warning"><Alert.Description>{t("guests.no_dashboards")}</Alert.Description></Alert.Root>
    {/if}
    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}
    {#if notice}
      <Alert.Root variant="success"><Alert.Description>{notice}</Alert.Description></Alert.Root>
    {/if}

    {#if editing}
      {@const isNew = editing === "new"}
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-lg">{isNew ? t("guests.add") : draft.username}</Card.Title>
        </Card.Header>
        <Card.Content>
          <form id="guest-form" class="grid gap-6" onsubmit={save}>
            <div class="grid gap-4 sm:grid-cols-2">
              {#if isNew}
                <div class="grid gap-2">
                  <Label for="guest-username">{t("guests.username")}</Label>
                  <Input id="guest-username" bind:value={draft.username} required minlength={3} maxlength={30} pattern="[a-zA-Z0-9_.]+" autocomplete="off" />
                </div>
              {/if}
              <div class="grid gap-2">
                <Label for="guest-password">{isNew ? t("guests.password") : t("guests.new_password")}</Label>
                <div class="flex gap-2">
                  <Input id="guest-password" bind:value={draft.password} required={isNew} minlength={8} autocomplete="new-password" />
                  <Button type="button" variant="outline" onclick={() => (draft.password = generatePassword())}>{t("guests.generate")}</Button>
                </div>
                {#if !isNew}<p class="text-xs text-muted-foreground">{t("guests.new_password_hint")}</p>{/if}
              </div>
              <div class="grid gap-2">
                <Label for="guest-dashboard">{t("guests.dashboard")}</Label>
                <Select.Root type="single" bind:value={draft.dashboard}>
                  <Select.Trigger id="guest-dashboard" class="w-full">{titles.get(draft.dashboard) ?? draft.dashboard}</Select.Trigger>
                  <Select.Content>
                    {#each dashboards as d (d.id)}
                      <Select.Item value={d.id} label={d.title} />
                    {/each}
                  </Select.Content>
                </Select.Root>
              </div>
            </div>
          </form>
        </Card.Content>
        <Card.Footer class="flex flex-wrap gap-2">
          <Button type="submit" form="guest-form">{t("save")}</Button>
          <Button variant="outline" onclick={() => (editing = null)}>{t("cancel")}</Button>
        </Card.Footer>
      </Card.Root>
    {/if}

    {#if guests.length === 0}
      <p class="text-sm text-muted-foreground">{t("guests.empty")}</p>
    {:else}
      <Card.Root class="py-2">
        <Card.Content class="px-2">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>{t("guests.username")}</Table.Head>
                <Table.Head>{t("guests.dashboard")}</Table.Head>
                <Table.Head class="w-0"><span class="sr-only">{t("guests.edit")}</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each guests as g (g.id)}
                <Table.Row>
                  <Table.Cell class="font-medium">{g.username}</Table.Cell>
                  <Table.Cell>{titles.get(g.dashboard) ?? g.dashboard}</Table.Cell>
                  <Table.Cell class="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" aria-label={t("guests.edit")} onclick={() => startEdit(g)}><Pencil class="size-4" /></Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="text-destructive hover:text-destructive"
                      aria-label={t("delete")}
                      onclick={() => ((deleting = g), (confirmOpen = true))}><Trash2 class="size-4" /></Button
                    >
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title={deleting ? t("guests.delete_confirm", { name: deleting.username }) : ""}
  action={t("delete")}
  onconfirm={() => deleting && remove(deleting)}
/>
