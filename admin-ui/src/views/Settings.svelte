<script lang="ts">
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { api, type StateView } from "$lib/api";
  import { message } from "$lib/errors";
  import Connect from "./Connect.svelte";

  let { info, onstate }: { info: StateView; onstate: (s: StateView) => void } = $props();

  let reconnect = $state(false);
  let publicUrl = $state<string | null>(null);
  let saved = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const CONNECTION_LABELS = { connected: "Connected", connecting: "Connecting", error: "Not connected", unconfigured: "Not set up" } as const;
  const guestLink = $derived(info.public_url ?? (info.mode === "standalone" ? window.location.origin : null));

  async function savePublicUrl(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    try {
      onstate(await api.saveSettings({ public_url: publicUrl ?? info.public_url ?? "" }));
      publicUrl = null;
      saved = true;
    } catch (err) {
      error = message(err);
    }
  }

  async function renew() {
    busy = true;
    error = null;
    try {
      onstate(await api.renewAppUser());
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }
</script>

{#if reconnect}
  <Connect oncancel={() => (reconnect = false)} />
{:else}
  <div class="grid gap-4">
    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}
    <Card.Root>
      <Card.Header><Card.Title class="text-lg">Home Assistant</Card.Title></Card.Header>
      <Card.Content class="grid gap-4">
        {#if info.ha}
          <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Address</dt>
            <dd class="break-all">{info.ha.url}</dd>
            <dt class="text-muted-foreground">Status</dt>
            <dd>{CONNECTION_LABELS[info.ha.state]}</dd>
            {#if info.ha.version}
              <dt class="text-muted-foreground">Version</dt>
              <dd>{info.ha.version}</dd>
            {/if}
            {#if info.ha.configured_by}
              <dt class="text-muted-foreground">Set up by</dt>
              <dd class="break-all">{info.ha.configured_by}</dd>
            {/if}
          </dl>
          {#if info.ha.error}
            <Alert.Root variant="destructive"><Alert.Description>{info.ha.error}</Alert.Description></Alert.Root>
          {/if}
        {/if}
      </Card.Content>
      <Card.Footer class="grid justify-items-start gap-2">
        {#if info.mode === "app"}
          <p class="text-sm text-muted-foreground">Creates a new non-admin user for Guest Assistant in Home Assistant and removes the old one.</p>
          <Button variant="outline" onclick={renew} disabled={busy}>Recreate the Guest Assistant user</Button>
        {:else}
          <p class="text-sm text-muted-foreground">Or the same one again, to create a new Guest Assistant user there.</p>
          <Button variant="outline" onclick={() => (reconnect = true)}>Connect a different Home Assistant</Button>
        {/if}
      </Card.Footer>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-lg">Guest address</Card.Title>
        <Card.Description>The address guests open, e.g. https://guests.example.com. With https, cookies are marked secure. Optional.</Card.Description>
      </Card.Header>
      <Card.Content>
        <form id="settings-form" class="grid gap-3" onsubmit={savePublicUrl}>
          <Input
            type="url"
            placeholder="https://"
            value={publicUrl ?? info.public_url ?? ""}
            oninput={(e) => ((publicUrl = e.currentTarget.value.trim()), (saved = false))}
          />
          {#if guestLink}
            <p class="text-sm text-muted-foreground">
              Guests open: <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{guestLink}</code>
            </p>
          {/if}
        </form>
      </Card.Content>
      <Card.Footer class="flex items-center gap-3">
        <Button type="submit" form="settings-form" variant="outline" disabled={publicUrl === null}>Save</Button>
        {#if saved}<span class="text-sm text-muted-foreground">Saved</span>{/if}
      </Card.Footer>
    </Card.Root>
  </div>
{/if}
