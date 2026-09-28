<script lang="ts">
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { api, type StateView } from "$lib/api";
  import { message } from "$lib/errors";
  import { t, type Key } from "$lib/i18n";
  import Connect from "./Connect.svelte";

  let { info, onstate }: { info: StateView; onstate: (s: StateView) => void } = $props();

  let reconnect = $state(false);
  let publicUrl = $state<string | null>(null);
  let saved = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

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
      <Card.Header><Card.Title class="text-lg">{t("settings.ha")}</Card.Title></Card.Header>
      <Card.Content class="grid gap-4">
        {#if info.ha}
          <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt class="text-muted-foreground">{t("settings.url")}</dt>
            <dd class="break-all">{info.ha.url}</dd>
            <dt class="text-muted-foreground">{t("settings.state")}</dt>
            <dd>{t(`conn.${info.ha.state}` as Key)}</dd>
            {#if info.ha.version}
              <dt class="text-muted-foreground">{t("settings.version")}</dt>
              <dd>{info.ha.version}</dd>
            {/if}
            {#if info.ha.configured_by}
              <dt class="text-muted-foreground">{t("settings.configured_by")}</dt>
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
          <p class="text-sm text-muted-foreground">{t("settings.renew_hint")}</p>
          <Button variant="outline" onclick={renew} disabled={busy}>{t("settings.renew")}</Button>
        {:else}
          <p class="text-sm text-muted-foreground">{t("settings.reconnect_hint")}</p>
          <Button variant="outline" onclick={() => (reconnect = true)}>{t("settings.reconnect")}</Button>
        {/if}
      </Card.Footer>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-lg">{t("settings.public_url")}</Card.Title>
        <Card.Description>{t("settings.public_url_hint")}</Card.Description>
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
              {t("settings.guest_link")}: <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{guestLink}</code>
            </p>
          {/if}
        </form>
      </Card.Content>
      <Card.Footer class="flex items-center gap-3">
        <Button type="submit" form="settings-form" variant="outline" disabled={publicUrl === null}>{t("save")}</Button>
        {#if saved}<span class="text-sm text-muted-foreground">{t("saved")}</span>{/if}
      </Card.Footer>
    </Card.Root>
  </div>
{/if}
