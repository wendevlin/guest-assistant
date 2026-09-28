<script lang="ts">
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { api } from "$lib/api";
  import { message } from "$lib/errors";
  import { t } from "$lib/i18n";

  let error = $state<string | null>(null);
  let busy = $state(false);

  async function login() {
    busy = true;
    try {
      const { authorize_url } = await api.login();
      window.location.assign(authorize_url);
    } catch (err) {
      error = message(err);
      busy = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="text-xl">{t("login.title")}</Card.Title>
    <Card.Description>{t("login.intro")}</Card.Description>
  </Card.Header>
  <Card.Content class="grid gap-4">
    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}
    <div><Button onclick={login} disabled={busy}>{t("login.submit")}</Button></div>
  </Card.Content>
</Card.Root>
