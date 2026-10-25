<script lang="ts">
  import Clock from "@lucide/svelte/icons/clock";
  import Link from "@lucide/svelte/icons/link";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Smartphone from "@lucide/svelte/icons/smartphone";
  import X from "@lucide/svelte/icons/x";
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
  import { api, generatePassword, type DashboardView, type Guest, type GuestDevice, type StateView } from "$lib/api";
  import { message } from "$lib/errors";
  import ConfirmDialog from "$lib/widgets/ConfirmDialog.svelte";
  import Spinner from "$lib/widgets/Spinner.svelte";

  let { info }: { info: StateView } = $props();

  interface Draft {
    username: string;
    password: string;
    dashboard: string;
    enabled: boolean;
    /** `datetime-local` value; empty for never. */
    disableAt: string;
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
  let draft = $state<Draft>({ username: "", password: "", dashboard: "", enabled: true, disableAt: "" });
  let deleting = $state<Guest | null>(null);
  let confirmOpen = $state(false);

  const titles = $derived(new Map(dashboards.map((d) => [d.id, d.title])));
  /** Where guests open Guest Assistant; unknown as an app until the guest address is set. */
  const guestBase = $derived(info.public_url ?? (info.mode === "standalone" ? window.location.origin : null));
  const loginUrl = (token: string) => (guestBase ? `${guestBase}/#login=${token}` : null);
  /** The guest whose link was copied last, for the "Copied" feedback. */
  let copiedId = $state<string | null>(null);
  /** Earliest time the picker offers (it cannot update itself). */
  let minDisableAt = $state("");

  /** ISO date → `datetime-local` value in the browser's time zone. */
  function toLocalInput(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }

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
    draft = { username: "", password: generatePassword(), dashboard: dashboards[0]?.id ?? "", enabled: true, disableAt: "" };
    minDisableAt = toLocalInput(new Date().toISOString());
    dialogOpen = true;
  }

  function startEdit(g: Guest) {
    notice = null;
    dialogError = null;
    editing = g;
    draft = { username: g.username, password: "", dashboard: g.dashboard, enabled: g.enabled, disableAt: toLocalInput(g.disable_at) };
    minDisableAt = toLocalInput(new Date().toISOString());
    dialogOpen = true;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    dialogError = null;
    busy = true;
    try {
      // `datetime-local` values are local time, which Date parses them as.
      const disableAt = draft.disableAt ? new Date(draft.disableAt).toISOString() : null;
      if (!editing) {
        const { disableAt: _, ...guest } = draft;
        await api.createGuest({ ...guest, disable_at: disableAt });
        notice = `Guest ${draft.username} created. Password: ${draft.password}`;
      } else {
        await api.updateGuest(editing.id, {
          dashboard: draft.dashboard,
          enabled: draft.enabled,
          ...(draft.password ? { password: draft.password } : {}),
          // Only when changed: an unchanged time may have passed while the dialog was open.
          ...(draft.disableAt !== toLocalInput(editing.disable_at) ? { disable_at: disableAt } : {}),
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

  /** Creates a new login link (the old one stops working) or removes it. */
  async function setLoginLink(g: Guest, create: boolean) {
    dialogError = null;
    try {
      const updated = await (create ? api.createLoginLink(g.id) : api.removeLoginLink(g.id));
      editing = { ...g, login_link: updated.login_link };
      await load();
    } catch (err) {
      dialogError = message(err);
    }
  }

  async function copyLink(g: Guest) {
    const url = g.login_link && loginUrl(g.login_link);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copiedId = g.id;
      setTimeout(() => (copiedId = null), 2500);
    } catch {
      // clipboard not available (http): the dialog shows the link to copy by hand
      if (!dialogOpen) startEdit(g);
    }
  }

  /** Signs one device out of the companion app. */
  async function removeDevice(g: Guest, d: GuestDevice) {
    error = null;
    try {
      guests = await api.removeDevice(g.id, d.id);
    } catch (err) {
      error = message(err);
    }
  }

  const lastUsed = (iso: string) => new Date(iso).toLocaleString();

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
        Guests sign in with these accounts or with a login link. Each account belongs to one dashboard. Switch an account off while the guest
        is not visiting, or let it switch off at a set time.
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
                <Table.Head class="hidden sm:table-cell">Dashboard</Table.Head>
                <Table.Head class="w-0">Active</Table.Head>
                <Table.Head class="w-0"><span class="sr-only">Edit</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each guests as g (g.id)}
                <Table.Row class={g.enabled ? "" : "text-muted-foreground"}>
                  <!-- Wraps instead of widening the table on phones. -->
                  <Table.Cell class="font-medium whitespace-normal">
                    {g.username}
                    <div class="text-xs font-normal text-muted-foreground sm:hidden">{titles.get(g.dashboard) ?? g.dashboard}</div>
                    {#if g.disable_at}
                      <div class="mt-1 flex items-center gap-2 text-xs font-normal text-muted-foreground">
                        <Clock class="size-3.5 shrink-0" />
                        <span>Switches off {lastUsed(g.disable_at)}</span>
                      </div>
                    {/if}
                    {#each g.devices ?? [] as d (d.id)}
                      <div class="mt-1 flex items-center gap-2 text-xs font-normal text-muted-foreground">
                        <Smartphone class="size-3.5 shrink-0" />
                        <span class="break-words" title={d.app ?? ""}>{d.name ?? "Companion app"} · last used {lastUsed(d.last_used_at)}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="size-6"
                          aria-label="Sign this device out of the companion app"
                          title="Sign out of the companion app"
                          onclick={() => removeDevice(g, d)}><X class="size-3.5" /></Button
                        >
                      </div>
                    {/each}
                  </Table.Cell>
                  <Table.Cell class="hidden sm:table-cell">{titles.get(g.dashboard) ?? g.dashboard}</Table.Cell>
                  <Table.Cell>
                    <Switch checked={g.enabled} onCheckedChange={(enabled) => setEnabled(g, enabled)} aria-label="Active" />
                  </Table.Cell>
                  <Table.Cell class="text-right whitespace-nowrap">
                    {#if g.login_link && guestBase}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Copy login link"
                        title={copiedId === g.id ? "Copied" : "Copy login link"}
                        onclick={() => copyLink(g)}><Link class="size-4" /></Button
                      >
                    {/if}
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
      <div class="grid gap-2">
        <Label for="guest-disable-at">Switch off automatically</Label>
        <div class="flex gap-2">
          <Input id="guest-disable-at" type="datetime-local" bind:value={draft.disableAt} min={minDisableAt} />
          {#if draft.disableAt}
            <Button type="button" variant="outline" onclick={() => (draft.disableAt = "")}>Clear</Button>
          {/if}
        </div>
        <p class="text-xs text-muted-foreground">
          At this time the account is switched off and the guest is signed out. Leave empty to keep it on.
        </p>
      </div>
      {#if editing}
        <div class="grid gap-2">
          <Label for="guest-login-link">Login link</Label>
          {#if editing.login_link}
            {@const url = loginUrl(editing.login_link)}
            {#if url}
              <div class="flex gap-2">
                <Input id="guest-login-link" value={url} readonly onfocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onclick={() => editing && copyLink(editing)}>
                  {copiedId === editing.id ? "Copied" : "Copy"}
                </Button>
              </div>
            {:else}
              <p class="text-sm text-muted-foreground">Set the guest address in the settings to get the link.</p>
            {/if}
            <div class="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onclick={() => editing && setLoginLink(editing, true)}>New link</Button>
              <Button type="button" variant="outline" size="sm" onclick={() => editing && setLoginLink(editing, false)}>Remove link</Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Anyone with the link signs in as this guest, as often as they like, while the account is active. A new link or removing it
              makes the old one stop working; guests already signed in stay signed in until you switch the account off.
            </p>
          {:else}
            <div>
              <Button type="button" variant="outline" size="sm" onclick={() => editing && setLoginLink(editing, true)}>Create login link</Button>
            </div>
            <p class="text-xs text-muted-foreground">Lets the guest sign in without a username and password.</p>
          {/if}
        </div>
      {/if}
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
