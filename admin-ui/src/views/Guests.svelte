<script lang="ts">
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import * as Table from "$lib/components/ui/table";
  import { api, generatePassword, type DashboardView, type Guest } from "$lib/api";
  import { message } from "$lib/errors";
  import ConfirmDialog from "$lib/widgets/ConfirmDialog.svelte";
  import Spinner from "$lib/widgets/Spinner.svelte";

  interface Draft {
    username: string;
    password: string;
    dashboard: string;
    enabled: boolean;
  }

  let guests = $state<Guest[] | null>(null);
  let dashboards = $state<DashboardView[]>([]);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** The guest being edited, or null for a new one. */
  let editing = $state<Guest | null>(null);
  let dialogOpen = $state(false);
  let dialogError = $state<string | null>(null);
  let busy = $state(false);
  let draft = $state<Draft>({ username: "", password: "", dashboard: "", enabled: true });
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
    dialogError = null;
    editing = null;
    draft = { username: "", password: generatePassword(), dashboard: dashboards[0]?.id ?? "", enabled: true };
    dialogOpen = true;
  }

  function startEdit(g: Guest) {
    notice = null;
    dialogError = null;
    editing = g;
    draft = { username: g.username, password: "", dashboard: g.dashboard, enabled: g.enabled };
    dialogOpen = true;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    dialogError = null;
    busy = true;
    try {
      if (!editing) {
        await api.createGuest({ ...draft });
        notice = `Guest ${draft.username} created. Password: ${draft.password}`;
      } else {
        await api.updateGuest(editing.id, {
          dashboard: draft.dashboard,
          enabled: draft.enabled,
          ...(draft.password ? { password: draft.password } : {}),
        });
      }
      dialogOpen = false;
      await load();
    } catch (err) {
      dialogError = message(err);
    } finally {
      busy = false;
    }
  }

  async function setEnabled(g: Guest, enabled: boolean) {
    error = null;
    try {
      await api.updateGuest(g.id, { enabled });
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
      <p class="text-sm text-muted-foreground">
        Guests sign in with these accounts. Each account belongs to one dashboard. Switch an account off while the guest is not visiting.
      </p>
      {#if dashboards.length > 0}
        <Button onclick={startNew}><Plus class="size-4" />Add guest</Button>
      {/if}
    </div>
    {#if dashboards.length === 0}
      <Alert.Root variant="warning"><Alert.Description>Add a guest dashboard first.</Alert.Description></Alert.Root>
    {/if}
    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}
    {#if notice}
      <Alert.Root variant="success"><Alert.Description>{notice}</Alert.Description></Alert.Root>
    {/if}

    {#if guests.length === 0}
      <p class="text-sm text-muted-foreground">No guests yet.</p>
    {:else}
      <Card.Root class="py-2">
        <Card.Content class="px-2">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Username</Table.Head>
                <Table.Head>Dashboard</Table.Head>
                <Table.Head class="w-0">Active</Table.Head>
                <Table.Head class="w-0"><span class="sr-only">Edit</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each guests as g (g.id)}
                <Table.Row class={g.enabled ? "" : "text-muted-foreground"}>
                  <Table.Cell class="font-medium">{g.username}</Table.Cell>
                  <Table.Cell>{titles.get(g.dashboard) ?? g.dashboard}</Table.Cell>
                  <Table.Cell>
                    <Switch checked={g.enabled} onCheckedChange={(enabled) => setEnabled(g, enabled)} aria-label="Active" />
                  </Table.Cell>
                  <Table.Cell class="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" aria-label="Edit" onclick={() => startEdit(g)}><Pencil class="size-4" /></Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="text-destructive hover:text-destructive"
                      aria-label="Delete"
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

<Dialog.Root bind:open={dialogOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{editing ? editing.username : "Add guest"}</Dialog.Title>
    </Dialog.Header>
    <form id="guest-form" class="grid gap-4" onsubmit={save}>
      {#if dialogError}
        <Alert.Root variant="destructive"><Alert.Description>{dialogError}</Alert.Description></Alert.Root>
      {/if}
      {#if !editing}
        <div class="grid gap-2">
          <Label for="guest-username">Username</Label>
          <Input id="guest-username" bind:value={draft.username} required minlength={3} maxlength={30} pattern="[a-zA-Z0-9_.]+" autocomplete="off" />
        </div>
      {/if}
      <div class="grid gap-2">
        <Label for="guest-password">{editing ? "New password" : "Password"}</Label>
        <div class="flex gap-2">
          <Input id="guest-password" bind:value={draft.password} required={!editing} minlength={8} autocomplete="new-password" />
          <Button type="button" variant="outline" onclick={() => (draft.password = generatePassword())}>Generate</Button>
        </div>
        {#if editing}<p class="text-xs text-muted-foreground">Leave empty to keep the current password.</p>{/if}
      </div>
      <div class="grid gap-2">
        <Label for="guest-dashboard">Dashboard</Label>
        <Select.Root type="single" bind:value={draft.dashboard}>
          <Select.Trigger id="guest-dashboard" class="w-full">{titles.get(draft.dashboard) ?? draft.dashboard}</Select.Trigger>
          <Select.Content>
            {#each dashboards as d (d.id)}
              <Select.Item value={d.id} label={d.title} />
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex items-center gap-3">
        <Switch id="guest-enabled" bind:checked={draft.enabled} />
        <Label for="guest-enabled" class="font-normal">Active</Label>
      </div>
    </form>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (dialogOpen = false)}>Cancel</Button>
      <Button type="submit" form="guest-form" disabled={busy}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={confirmOpen}
  title={deleting ? `Delete the guest ${deleting.username}?` : ""}
  action="Delete"
  onconfirm={() => deleting && remove(deleting)}
/>
