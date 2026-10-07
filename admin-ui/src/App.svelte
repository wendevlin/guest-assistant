<script lang="ts">
  import LogOut from "@lucide/svelte/icons/log-out";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Tabs from "$lib/components/ui/tabs";
  import { api, type StateView } from "$lib/api";
  import { message } from "$lib/errors";
  import Spinner from "$lib/widgets/Spinner.svelte";
  import Connect from "./views/Connect.svelte";
  import Dashboards from "./views/Dashboards.svelte";
  import Guests from "./views/Guests.svelte";
  import Login from "./views/Login.svelte";
  import Settings from "./views/Settings.svelte";
  import SetupCode from "./views/SetupCode.svelte";

  type Tab = "dashboards" | "guests" | "settings";
  const TABS: Tab[] = ["dashboards", "guests", "settings"];
  const TAB_LABELS: Record<Tab, string> = { dashboards: "Dashboards", guests: "Guests", settings: "Settings" };
  const CONNECTION_LABELS = { connected: "Connected", connecting: "Connecting", error: "Not connected", unconfigured: "Not set up" } as const;

  let info = $state<StateView | null>(null);
  let tab = $state<Tab>(TABS.includes(location.hash.slice(1) as Tab) ? (location.hash.slice(1) as Tab) : "dashboards");

  // Errors from the sign-in round trip arrive as ?error=…
  const initialError = new URLSearchParams(location.search).get("error");
  if (initialError) history.replaceState(null, "", location.pathname + location.hash);
  let error = $state<string | null>(initialError);

  const signedIn = $derived(info?.configured === true && info.signed_in === "admin");

  async function refresh() {
    try {
      info = await api.state();
      // Set-up as an app runs in the background: poll until it is done.
      if (info.mode === "app" && (!info.configured || info.ha?.state === "connecting")) setTimeout(refresh, 2000);
    } catch (err) {
      error = message(err);
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    await refresh();
  }

  $effect(() => {
    void refresh();
  });

  $effect(() => {
    history.replaceState(null, "", `#${tab}`);
  });

  // Follow the device's light/dark setting.
  $effect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  });

  const connection = $derived(info?.ha?.state ?? "unconfigured");
</script>

<div class="min-h-screen">
  <header class="border-b bg-card">
    <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
      <!-- Same drawing as public/icon.svg (the favicon and the app store icon). -->
      <svg class="size-8 shrink-0" viewBox="90 90 320 320" aria-hidden="true">
        <path fill="#18BCF2" d="M100 375 V265 Q100 245 114 231 L236 109 Q250 95 264 109 L386 231 Q400 245 400 265 V375 Q400 395 380 395 H120 Q100 395 100 375 Z" />
        <path fill="#F2F4F9" d="M190 395 V262 Q190 238 214 238 H286 Q310 238 310 262 V395 Z" />
        <g fill="#18BCF2"><circle cx="250" cy="290" r="24" /><path d="M206 395 V362 Q206 322 250 322 Q294 322 294 362 V395 Z" /></g>
      </svg>
      <h1 class="min-w-0 flex-1 truncate text-lg font-medium">
        Guest Assistant <span class="font-normal text-muted-foreground">Admin</span>
      </h1>
      {#if info?.configured && signedIn}
        <Badge variant={connection === "connected" ? "success" : connection === "error" ? "destructive" : "warning"} title={info.ha?.error ?? ""}>
          {CONNECTION_LABELS[connection]}
        </Badge>
      {/if}
      {#if signedIn && info}
        <div class="flex items-center gap-1">
          <span class="text-sm text-muted-foreground">Signed in as {info.admin_name ?? ""}</span>
          {#if info.mode === "standalone"}
            <Button variant="ghost" size="sm" onclick={logout}><LogOut class="size-4" />Sign out</Button>
          {/if}
        </div>
      {/if}
    </div>
  </header>

  <main class="mx-auto grid gap-4 px-4 py-6 {signedIn ? 'max-w-5xl' : 'max-w-xl pt-12'}">
    {#if error}
      <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
    {/if}

    {#if !info}
      <Spinner />
    {:else if !info.configured}
      {#if info.mode === "app"}
        <Card.Root>
          <Card.Header>
            <Card.Title class="text-xl">Setting up</Card.Title>
            <Card.Description>Guest Assistant is creating its own Home Assistant user.</Card.Description>
          </Card.Header>
          <Card.Content><Spinner /></Card.Content>
        </Card.Root>
      {:else if info.signed_in === null}
        <SetupCode ondone={refresh} />
      {:else}
        <Connect />
      {/if}
    {:else if !signedIn}
      {#if info.mode === "app"}
        <Alert.Root variant="destructive"><Alert.Description>Only Home Assistant administrators can open this page.</Alert.Description></Alert.Root>
      {:else}
        <Login />
      {/if}
    {:else}
      <Tabs.Root bind:value={tab} class="gap-4">
        <Tabs.List>
          {#each TABS as name (name)}
            <Tabs.Trigger value={name}>{TAB_LABELS[name]}</Tabs.Trigger>
          {/each}
        </Tabs.List>
        <!-- Each view is created when its tab opens, so it loads current data
             (e.g. a dashboard added a moment ago shows up for new guests). -->
        <Tabs.Content value="dashboards">{#if tab === "dashboards"}<Dashboards />{/if}</Tabs.Content>
        <Tabs.Content value="guests">{#if tab === "guests"}<Guests />{/if}</Tabs.Content>
        <Tabs.Content value="settings">{#if tab === "settings"}<Settings {info} onstate={(s) => (info = s)} />{/if}</Tabs.Content>
      </Tabs.Root>
    {/if}
  </main>
</div>
