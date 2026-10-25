<script lang="ts">
  import Smartphone from "@lucide/svelte/icons/smartphone";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import type { Guest, GuestDevice } from "$lib/api";
  import { message } from "$lib/errors";
  import ConfirmDialog from "$lib/widgets/ConfirmDialog.svelte";

  /** The guest's companion app logins, each of which the admin can sign out. */
  let {
    open = $bindable(false),
    guest,
    onsignout,
  }: { open?: boolean; guest: Guest | null; onsignout: (g: Guest, d: GuestDevice) => Promise<void> } = $props();

  let signingOut = $state<GuestDevice | null>(null);
  let confirmOpen = $state(false);
  let error = $state<string | null>(null);

  const date = (iso: string) => new Date(iso).toLocaleString();
  const deviceName = (d: GuestDevice) => d.name ?? "Companion app";

  async function signOut(d: GuestDevice) {
    if (!guest) return;
    error = null;
    try {
      await onsignout(guest, d);
    } catch (err) {
      error = message(err);
    }
  }

  $effect(() => {
    if (open) error = null;
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Companion apps of {guest?.username ?? ""}</Dialog.Title>
      <Dialog.Description>Devices where the guest is signed in to the Home Assistant app.</Dialog.Description>
    </Dialog.Header>
    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}
    {#if !guest?.devices?.length}
      <p class="text-sm text-muted-foreground">Not signed in on any device.</p>
    {:else}
      <ul class="grid gap-3">
        {#each guest.devices as d (d.id)}
          <li class="flex items-start gap-3 rounded-lg border p-3">
            <Smartphone class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div class="grid min-w-0 flex-1 gap-0.5 text-sm">
              <span class="font-medium break-words">{deviceName(d)}</span>
              {#if d.app}<span class="text-xs break-words text-muted-foreground">{d.app}</span>{/if}
              <span class="text-xs text-muted-foreground">Signed in {date(d.created_at)} · last used {date(d.last_used_at)}</span>
            </div>
            <Button variant="outline" size="sm" onclick={() => ((signingOut = d), (confirmOpen = true))}>Sign out</Button>
          </li>
        {/each}
      </ul>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={confirmOpen}
  title={signingOut ? `Sign ${deviceName(signingOut)} out?` : ""}
  description="The Home Assistant app on this device loses access right away and has to sign in again. The guest account and its other devices stay as they are."
  action="Sign out"
  onconfirm={() => signingOut && signOut(signingOut)}
/>
