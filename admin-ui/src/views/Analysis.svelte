<!-- Why a dashboard is rejected, or the questions it raises. -->
<script lang="ts">
  import type { DashboardView, QuestionView } from "$lib/api";
  import Questions from "./Questions.svelte";

  let { dashboard, onanswer }: { dashboard: DashboardView; onanswer: (q: QuestionView, value: string) => void } = $props();
</script>

{#if dashboard.status === "rejected"}
  <section class="grid gap-3">
    <div>
      <h3 class="font-medium">Why it is rejected</h3>
      <p class="text-sm text-muted-foreground">Guests of this dashboard cannot sign in until these cards are changed in Home Assistant.</p>
    </div>
    <ul class="grid gap-2">
      {#each dashboard.violations as v, i (i)}
        <li class="grid gap-1 rounded-lg border border-destructive/30 p-3 text-sm">
          <span>{v.message}</span>
          <code class="font-mono text-xs text-muted-foreground">{v.path}</code>
        </li>
      {/each}
    </ul>
  </section>
{:else}
  <section class="grid gap-3">
    <div>
      <h3 class="font-medium">Your decisions</h3>
      {#if dashboard.questions.some((q) => !q.informational)}
        <p class="text-sm text-muted-foreground">Until you decide, the restrictive choice applies.</p>
      {/if}
    </div>
    <Questions questions={dashboard.questions} {onanswer} />
  </section>
{/if}
