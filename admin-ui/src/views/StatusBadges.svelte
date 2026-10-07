<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { DashboardView } from "$lib/api";

  let { dashboard, showGuests = true }: { dashboard: DashboardView; showGuests?: boolean } = $props();

  const STATUS = { ok: "Active", rejected: "Rejected", loading: "Loading" } as const;
</script>

<div class="flex flex-wrap gap-1.5">
  {#if dashboard.pending}<Badge variant="warning">Open: {dashboard.pending}</Badge>{/if}
  {#if dashboard.issues.length}<Badge variant="warning">Issues: {dashboard.issues.length}</Badge>{/if}
  {#if showGuests}<Badge variant="secondary">Guests: {dashboard.guests}</Badge>{/if}
  {#if dashboard.status === "ok"}<Badge variant="secondary">Entities: {dashboard.entities}</Badge>{/if}
  {#if !dashboard.enabled}
    <Badge variant="secondary">Inactive</Badge>
  {:else}
    <Badge variant={dashboard.status === "ok" ? "success" : dashboard.status === "rejected" ? "destructive" : "secondary"}>
      {STATUS[dashboard.status]}
    </Badge>
  {/if}
</div>
