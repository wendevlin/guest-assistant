<script lang="ts">
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { api, type StateView } from "$lib/api";
  import { message } from "$lib/errors";
  import Connect from "./Connect.svelte";

  let { info, onstate }: { info: StateView; onstate: (s: StateView) => void } = $props();

  let reconnect = $state(false);
  let publicUrl = $state<string | null>(null);
  let saved = $state(false);
  let appName = $state<string | null>(null);
  let appNameSaved = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const CONNECTION_LABELS = { connected: "Connected", connecting: "Connecting", error: "Not connected", unconfigured: "Not set up" } as const;
  const guestLink = $derived(info.public_url ?? (info.mode === "standalone" ? window.location.origin : null));
  /** Opens the companion apps' onboarding with this server filled in. */
  const inviteLink = $derived(guestLink ? `https://my.home-assistant.io/invite/#url=${encodeURIComponent(guestLink)}` : null);
  let copied = $state(false);

  async function saveCompanion(changes: { enabled?: boolean; discoverable?: boolean }) {
    error = null;
    try {
      onstate(await api.saveSettings({ companion: changes }));
    } catch (err) {
      error = message(err);
    }
  }

  async function copyInvite() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      copied = true;
      setTimeout(() => (copied = false), 2500);
    } catch {
      // clipboard not available (http): the link is shown to copy by hand
    }
  }

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

  async function saveAppName(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    try {
      onstate(await api.saveSettings({ app_name: appName ?? info.app_name ?? "" }));
      appName = null;
      appNameSaved = true;
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
          {:else if info.mode === "app"}
            <p class="text-sm text-muted-foreground">
              Guests open port <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{info.guest_port}</code> of your Home Assistant
              machine. Change it on the app's Configuration tab.
            </p>
          {/if}
        </form>
      </Card.Content>
      <Card.Footer class="flex items-center gap-3">
        <Button type="submit" form="settings-form" variant="outline" disabled={publicUrl === null}>Save</Button>
        {#if saved}<span class="text-sm text-muted-foreground">Saved</span>{/if}
      </Card.Footer>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-lg">App name</Card.Title>
        <Card.Description>
          Guests can add the guest page to their home screen as an app. This name is shown under its icon. Up to about 12 characters fit
          without being cut off. Apps already on an iPhone keep the name they were added with; Android picks up a change after a while.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <form id="app-name-form" class="grid gap-3" onsubmit={saveAppName}>
          <Input
            maxlength={40}
            placeholder="Guest Assistant"
            value={appName ?? info.app_name ?? ""}
            oninput={(e) => ((appName = e.currentTarget.value), (appNameSaved = false))}
          />
        </form>
      </Card.Content>
      <Card.Footer class="flex items-center gap-3">
        <Button type="submit" form="app-name-form" variant="outline" disabled={appName === null}>Save</Button>
        {#if appNameSaved}<span class="text-sm text-muted-foreground">Saved</span>{/if}
      </Card.Footer>
    </Card.Root>

    {#if info.companion}
      {@const companion = info.companion}
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-lg">Home Assistant companion app</Card.Title>
          <Card.Description>
            Guests can add Guest Assistant as a server in the Home Assistant app on their phone and sign in with their guest account. They see
            their dashboard there, nothing else. For this, Guest Assistant answers the app like a Home Assistant server would. Sensors, location
            and notifications from the app are not used.
          </Card.Description>
        </Card.Header>
        <Card.Content class="grid gap-4">
          <div class="flex items-start gap-3">
            <Switch id="companion-enabled" checked={companion.enabled} onCheckedChange={(enabled) => saveCompanion({ enabled })} />
            <div class="grid gap-1">
              <Label for="companion-enabled">Allow the companion app</Label>
              <p class="text-sm text-muted-foreground">
                Switching this off signs every guest out of the app. Widgets can be allowed per dashboard on the Dashboards tab.
              </p>
            </div>
          </div>
          {#if companion.enabled}
            <div class="flex items-start gap-3">
              <Switch id="companion-discoverable" checked={companion.discoverable} onCheckedChange={(discoverable) => saveCompanion({ discoverable })} />
              <div class="grid gap-1">
                <Label for="companion-discoverable">Show in the app's server list on this network</Label>
                <p class="text-sm text-muted-foreground">
                  The app finds Guest Assistant under the app name above, next to your own Home Assistant.
                </p>
                {#if companion.discoverable && companion.discovery === "unavailable"}
                  <Alert.Root variant="warning">
                    <Alert.Description>
                      The app cannot find Guest Assistant on its own: {companion.discovery_error ?? "announcing on the local network is not possible here."}
                      Guests can still add it with the link below.
                    </Alert.Description>
                  </Alert.Root>
                {/if}
              </div>
            </div>
            {#if inviteLink}
              <div class="grid gap-2">
                <p class="text-sm text-muted-foreground">Or send guests this link. It opens the app with Guest Assistant filled in:</p>
                <div class="flex flex-wrap items-center gap-2">
                  <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">{inviteLink}</code>
                  <Button variant="outline" size="sm" onclick={copyInvite}>{copied ? "Copied" : "Copy"}</Button>
                </div>
              </div>
            {:else}
              <p class="text-sm text-muted-foreground">Set the guest address above to get a link that opens the app with Guest Assistant filled in.</p>
            {/if}
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}
