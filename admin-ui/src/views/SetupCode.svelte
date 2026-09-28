<script lang="ts">
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { api } from "$lib/api";
  import { message } from "$lib/errors";
  import { t } from "$lib/i18n";

  let { ondone }: { ondone: () => void } = $props();
  let code = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await api.setupCode(code);
      ondone();
    } catch (err) {
      error = message(err);
    } finally {
      busy = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="text-xl">{t("setup.code.title")}</Card.Title>
    <Card.Description>{t("setup.code.intro")}</Card.Description>
  </Card.Header>
  <Card.Content>
    <form class="grid gap-4" onsubmit={submit}>
      {#if error}
        <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
      {/if}
      <div class="grid gap-2">
        <Label for="setup-code">{t("setup.code.label")}</Label>
        <Input id="setup-code" bind:value={code} autocomplete="one-time-code" inputmode="numeric" placeholder="1234-5678" required />
      </div>
      <div><Button type="submit" disabled={busy}>{t("setup.code.submit")}</Button></div>
    </form>
  </Card.Content>
</Card.Root>
