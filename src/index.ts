import { ConfigError } from "./config";
import { initialize, type Runtime } from "./initialize";
import { createServer } from "./server";

let runtime: Runtime;
try {
  runtime = await initialize();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error("Startup failed:", err);
  }
  process.exit(1);
}

const { server } = createServer(runtime);
console.log(`Guest Assistant listening on ${server.url} (public URL: ${runtime.config.base_url})`);
