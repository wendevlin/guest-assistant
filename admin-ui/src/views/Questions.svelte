<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import * as RadioGroup from "$lib/components/ui/radio-group";
  import type { QuestionView } from "$lib/api";
  import { t, type Key } from "$lib/i18n";

  let { questions, onanswer }: { questions: QuestionView[]; onanswer: (q: QuestionView, value: string) => void } = $props();

  /** The sentence with the subject as code, e.g. "A card opens the web page <code>…</code>." */
  function parts(q: QuestionView): [string, string] {
    const [before, after] = t(`q.${q.kind}` as Key, { subject: "\u0000" }).split("\u0000");
    return [before ?? "", after ?? ""];
  }
</script>

{#if questions.length === 0}
  <p class="text-sm text-muted-foreground">{t("dash.no_questions")}</p>
{:else}
  <ul class="grid gap-2">
    {#each questions as q (q.key)}
      {@const [before, after] = parts(q)}
      <li class="grid gap-3 rounded-lg border p-3 {q.answered ? '' : 'border-warning/60 bg-warning-soft/40'}">
        <p class="text-sm leading-relaxed">
          {#if !q.answered}<Badge variant="warning" class="me-1.5">{t("dash.new")}</Badge>{/if}
          {before}<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8rem] break-all">{q.subject}</code>{after}
        </p>
        {#if q.informational}
          {#if !q.answered}
            <div><Button size="sm" variant="outline" onclick={() => onanswer(q, "ok")}>{t("q.opt.ok")}</Button></div>
          {/if}
        {:else}
          <RadioGroup.Root value={q.answered ? q.answer : ""} onValueChange={(v) => onanswer(q, v)} class="flex flex-wrap gap-x-6 gap-y-2">
            {#each q.options as opt (opt)}
              <div class="flex items-center gap-2">
                <RadioGroup.Item value={opt} id="{q.key}-{opt}" />
                <Label for="{q.key}-{opt}" class="font-normal">{t(`q.opt.${opt}` as Key)}</Label>
              </div>
            {/each}
          </RadioGroup.Root>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
