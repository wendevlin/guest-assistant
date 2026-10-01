<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import type { QuestionView } from "$lib/api";

  let { questions, onanswer }: { questions: QuestionView[]; onanswer: (q: QuestionView, value: string) => void } = $props();

  /** The text around the subject, which is shown as code. */
  const SENTENCES: Record<QuestionView["kind"], [string, string]> = {
    navigate_view: ["Navigation to ", " opens another view of this dashboard. Guests can use it."],
    navigate_outside: ["Navigation to ", " leads outside this dashboard. Guests cannot open that page, so the action is removed for them."],
    url: ["A card opens the web page ", "."],
    media_group: ["", " can be grouped with other media players."],
  };
  const OPTIONS: Record<string, string> = {
    allow: "Allow",
    block: "Block",
    dashboard: "Allow grouping with players on this dashboard",
    none: "No grouping",
  };
</script>

{#if questions.length === 0}
  <p class="text-sm text-muted-foreground">Nothing to decide on this dashboard.</p>
{:else}
  <ul class="grid gap-2">
    {#each questions as q (q.key)}
      {@const [before, after] = SENTENCES[q.kind]}
      <li class="grid gap-3 rounded-lg border p-3 {q.answered ? '' : 'border-warning/60 bg-warning-soft/40'}">
        <p class="text-sm leading-relaxed">
          {#if !q.answered}<Badge variant="warning" class="me-1.5">New</Badge>{/if}
          {before}<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8rem] break-all">{q.subject}</code>{after}
        </p>
        {#if q.informational}
          {#if !q.answered}
            <div><Button size="sm" variant="outline" onclick={() => onanswer(q, "ok")}>Understood</Button></div>
          {/if}
        {:else}
          <RadioGroup.Root value={q.answered ? q.answer : ""} onValueChange={(v) => onanswer(q, v)} class="flex flex-wrap gap-x-6 gap-y-2">
            {#each q.options as opt (opt)}
              <div class="flex items-center gap-2">
                <RadioGroup.Item value={opt} id="{q.key}-{opt}" />
                <Label for="{q.key}-{opt}" class="font-normal">{OPTIONS[opt] ?? opt}</Label>
              </div>
            {/each}
          </RadioGroup.Root>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
