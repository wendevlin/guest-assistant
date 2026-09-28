<script lang="ts">
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { t } from "$lib/i18n";

  let {
    open = $bindable(false),
    title,
    action,
    onconfirm,
  }: { open?: boolean; title: string; action: string; onconfirm: () => void } = $props();
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{t("cancel")}</AlertDialog.Cancel>
      <AlertDialog.Action
        class="bg-destructive text-white hover:bg-destructive/90"
        onclick={() => {
          open = false;
          onconfirm();
        }}>{action}</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
