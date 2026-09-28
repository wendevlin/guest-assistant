<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { DashboardView } from "$lib/api";
  import { t } from "$lib/i18n";

  let { dashboard, showGuests = true }: { dashboard: DashboardView; showGuests?: boolean } = $props();
</script>

<div class="flex flex-wrap gap-1.5">
  {#if dashboard.pending}<Badge variant="warning">{t("dash.pending", { count: dashboard.pending })}</Badge>{/if}
  {#if showGuests}<Badge variant="secondary">{t("dash.guests", { count: dashboard.guests })}</Badge>{/if}
  {#if dashboard.status === "ok"}<Badge variant="secondary">{t("dash.entities", { count: dashboard.entities })}</Badge>{/if}
  <Badge variant={dashboard.status === "ok" ? "success" : dashboard.status === "rejected" ? "destructive" : "secondary"}>
    {t(`dash.status.${dashboard.status}`)}
  </Badge>
</div>
