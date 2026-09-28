import { join } from "node:path";

interface Asset {
  body: string;
  type: string;
}

const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Guest Assistant admin</title>
    <link rel="icon" href="icon.svg" type="image/svg+xml" />
    <style>
      html { background: #f6f7f9; color: #1b1f24; font-family: Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; }
      @media (prefers-color-scheme: dark) { html { background: #111418; color: #e3e6ea; } }
      body { margin: 0; }
    </style>
    <script type="module" src="app.js"></script>
  </head>
  <body>
    <ga-admin></ga-admin>
  </body>
</html>
`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#009ac7"/><path fill="#fff" d="M12 4 4 10.5V20h5.5v-5h5v5H20v-9.5z"/></svg>`;

let assets: Promise<Map<string, Asset>> | null = null;

/** Builds the admin page once per process; Bun bundles the Lit app in memory. */
export function adminAssets(): Promise<Map<string, Asset>> {
  assets ??= build().catch((err) => {
    assets = null;
    throw err;
  });
  return assets;
}

async function build(): Promise<Map<string, Asset>> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "ui/main.ts")],
    target: "browser",
    minify: true,
  });
  if (!result.success || !result.outputs[0]) {
    throw new Error(`Building the admin UI failed:\n${result.logs.map(String).join("\n")}`);
  }
  return new Map<string, Asset>([
    ["index.html", { body: INDEX_HTML, type: "text/html; charset=utf-8" }],
    ["app.js", { body: await result.outputs[0].text(), type: "text/javascript; charset=utf-8" }],
    ["icon.svg", { body: ICON_SVG, type: "image/svg+xml" }],
  ]);
}
