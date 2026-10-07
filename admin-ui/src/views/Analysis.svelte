<!-- Why a dashboard cannot be used, or what is hidden from guests, the questions it raises and the conditions it uses. -->
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
      <h3 class="font-medium">Guests cannot use this dashboard</h3>
      <p class="text-sm text-muted-foreground">Until this is changed in Home Assistant, its guests only see that the dashboard is not available.</p>
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
  {#if dashboard.issues.length > 0}
    <section class="grid gap-3">
      <div>
        <h3 class="font-medium">Issues</h3>
        <p class="text-sm text-muted-foreground">
          These parts cannot be checked, so guests do not get them. Everything else on the dashboard works. Change them in Home Assistant
          to make them available to guests.
        </p>
      </div>
      <ul class="grid gap-2">
        {#each dashboard.issues as issue, i (i)}
          <li class="grid gap-1 rounded-lg border border-warning/30 p-3 text-sm">
            <span>{issue.message}</span>
            <span class="text-xs text-muted-foreground">
              {issue.effect === "hidden" ? "Hidden from guests:" : "Does nothing for guests:"}
              <code class="font-mono break-all">{issue.hidden}</code>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
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
