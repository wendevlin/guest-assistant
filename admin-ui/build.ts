/**
 * Builds the admin page with Bun: Svelte via bun-plugin-svelte, Tailwind via
 * bun-plugin-tailwind. No Vite. The output uses relative URLs, so the page
 * works under /admin/ and behind HA's ingress path prefix.
 *
 *   bun build.ts           production build into dist/
 *   bun build.ts --watch   development build, rebuilt on every change
 */
import { SveltePlugin } from "bun-plugin-svelte";
import tailwind from "bun-plugin-tailwind";
import { watch } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const outdir = join(root, "dist");
const development = process.argv.includes("--watch");

async function build(): Promise<boolean> {
  const started = performance.now();
  await rm(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(root, "index.html")],
    outdir,
    target: "browser",
    conditions: ["svelte", "browser"],
    minify: !development,
    define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
    plugins: [SveltePlugin({ development }), tailwind],
  });
  if (!result.success) {
    console.error("Admin UI build failed:");
    for (const log of result.logs) console.error(log);
    return false;
  }
  console.log(`Admin UI built in ${Math.round(performance.now() - started)} ms`);
  return true;
}

const ok = await build();
if (!development) process.exit(ok ? 0 : 1);

let timer: ReturnType<typeof setTimeout> | undefined;
const rebuild = () => {
  clearTimeout(timer);
  timer = setTimeout(() => void build(), 100);
};
watch(join(root, "src"), { recursive: true }, rebuild);
watch(join(root, "index.html"), rebuild);
console.log("Watching admin-ui/src for changes…");
