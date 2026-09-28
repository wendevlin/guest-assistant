<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import { api, type DiscoveredHa } from "$lib/api";
  import { message } from "$lib/errors";
  import { t } from "$lib/i18n";
  import Spinner from "$lib/widgets/Spinner.svelte";

  let { oncancel }: { oncancel?: () => void } = $props();

  let found = $state<DiscoveredHa[]>([]);
  let searching = $state(false);
  let picked = $state("");
  let typed = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  const target = $derived(typed.trim() || picked);

  async function search() {
    searching = true;
    error = null;
    try {
      found = await api.discover();
      if (!picked) picked = found.find((f) => f.reachable)?.url ?? "";
    } catch (err) {
      error = message(err);
    } finally {
      searching = false;
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!target) return;
    busy = true;
    error = null;
    try {
      const { authorize_url } = await api.connect(target);
      window.location.assign(authorize_url);
    } catch (err) {
      error = message(err);
      busy = false;
    }
  }

  $effect(() => {
    void search();
  });
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="text-xl">{t("setup.connect.title")}</Card.Title>
    <Card.Description>{t("setup.connect.intro")}</Card.Description>
  </Card.Header>
  <Card.Content>
    <form class="grid gap-6" onsubmit={submit}>
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}
      <div class="grid gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-medium">{t("setup.connect.found")}</h3>
          <Button type="button" variant="ghost" size="sm" onclick={search} disabled={searching}>
            <RefreshCw class="size-4" />{t("setup.connect.search_again")}
          </Button>
        </div>
        {#if searching}
          <Spinner label={t("setup.connect.searching")} />
        {:else if found.length === 0}
          <p class="text-sm text-muted-foreground">{t("setup.connect.none")}</p>
        {:else}
          <RadioGroup.Root value={typed.trim() ? "" : picked} onValueChange={(v) => ((picked = v), (typed = ""))} class="grid gap-2">
            {#each found as ha (ha.uuid)}
              <Label
                for="ha-{ha.uuid}"
                class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent {ha.reachable
                  ? ''
                  : 'cursor-default opacity-60'}"
              >
                <RadioGroup.Item value={ha.url} id="ha-{ha.uuid}" disabled={!ha.reachable} />
                <span class="grid gap-0.5">
                  <span class="font-medium">{ha.name}</span>
                  <span class="text-sm text-muted-foreground">{ha.url}{ha.version ? ` · ${ha.version}` : ""}</span>
                  {#if !ha.reachable}<span class="text-xs">{t("setup.connect.unreachable")}</span>{/if}
                </span>
              </Label>
            {/each}
          </RadioGroup.Root>
        {/if}
      </div>
      <div class="grid gap-2">
        <Label for="ha-url">{t("setup.connect.manual")}</Label>
        <Input id="ha-url" bind:value={typed} inputmode="url" placeholder={t("setup.connect.url_hint")} />
      </div>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !target}>{t("setup.connect.submit")}</Button>
        {#if oncancel}<Button type="button" variant="outline" onclick={oncancel}>{t("cancel")}</Button>{/if}
      </div>
    </form>
  </Card.Content>
</Card.Root>
