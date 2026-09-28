<script lang="ts">
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  let { label = "" }: { label?: string } = $props();
</script>

<div class="flex items-center gap-2 text-muted-foreground" role="status">
  <LoaderCircle class="size-5 animate-spin text-primary" />
  {#if label}<span class="text-sm">{label}</span>{/if}
</div>
