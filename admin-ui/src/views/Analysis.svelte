<!-- Why a dashboard is rejected, or the questions it raises and the conditions it uses. -->
<script lang="ts">
  import type { DashboardView, QuestionView } from "$lib/api";
  import Questions from "./Questions.svelte";

  /** Condition types that behave differently for guests or are evaluated in the browser. */
  const CONDITION_NOTES: Record<string, string> = {
    user: "Guests are not a Home Assistant user, so no user in the list ever matches them",
    location: "Guests have no person, so a location condition never matches them",
    screen: "Evaluated in the guest's browser",
    view_columns: "Evaluated in the guest's browser",
    time: "Evaluated in the guest's browser",
  };

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
  {#if dashboard.conditions.length > 0}
    <section class="grid gap-3">
      <div>
        <h3 class="font-medium">Conditions</h3>
        <p class="text-sm text-muted-foreground">
          Cards, badges and sections on this dashboard are shown or hidden by these conditions. They work for guests as for any other
          user, except where noted.
        </p>
      </div>
      <ul class="grid gap-2">
        {#each dashboard.conditions as c (c.type)}
          <li class="grid gap-1 rounded-lg border p-3 text-sm">
            <span>
              <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8rem]">{c.type}</code>
              {c.paths.length === 1 ? "used once" : `used ${c.paths.length} times`}{#if CONDITION_NOTES[c.type]}. {CONDITION_NOTES[c.type]}{/if}
            </span>
            <code class="font-mono text-xs break-all text-muted-foreground">{c.paths.join(", ")}</code>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}
