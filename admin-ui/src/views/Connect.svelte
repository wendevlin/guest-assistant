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
    <Card.Title class="text-xl">Connect Home Assistant</Card.Title>
    <Card.Description>Pick your Home Assistant. You sign in there as an administrator once. Guest Assistant then creates its own Home Assistant user without admin rights and uses only that one. Your admin login is not stored.</Card.Description>
  </Card.Header>
  <Card.Content>
    <form class="grid gap-6" onsubmit={submit}>
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}
      <div class="grid gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-medium">Found on the network</h3>
          <Button type="button" variant="ghost" size="sm" onclick={search} disabled={searching}>
            <RefreshCw class="size-4" />Search again
          </Button>
        </div>
        {#if searching}
          <Spinner label="Searching the network…" />
        {:else if found.length === 0}
          <p class="text-sm text-muted-foreground">No Home Assistant found on the network. Enter its address below.</p>
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
                  {#if !ha.reachable}<span class="text-xs">Not reachable from Guest Assistant under any announced address.</span>{/if}
                </span>
              </Label>
            {/each}
          </RadioGroup.Root>
        {/if}
      </div>
      <div class="grid gap-2">
        <Label for="ha-url">Or enter the address</Label>
        <Input id="ha-url" bind:value={typed} inputmode="url" placeholder="For example http://homeassistant.local:8123" />
      </div>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !target}>Sign in with Home Assistant</Button>
        {#if oncancel}<Button type="button" variant="outline" onclick={oncancel}>Cancel</Button>{/if}
      </div>
    </form>
  </Card.Content>
</Card.Root>
