import type { Mode } from "./runtime";

/** Which of the proxy's servers could not open its port. */
export type ServerRole = "guest" | "ingress";

/**
 * A readable explanation of why a server could not open its port, with what
 * to do about it, or null for errors that are not about the port.
 *
 * As an app, Guest Assistant uses host networking: its ports open directly on
 * the Home Assistant machine, next to every other app and service there, so a
 * port can already be taken.
 */
export function describeListenError(err: unknown, port: number, role: ServerRole, mode: Mode): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  const what = role === "guest" ? `the guest page (port ${port})` : `the admin page for Home Assistant's sidebar (port ${port})`;
  const fix =
    role === "guest"
      ? mode === "app"
        ? `Choose another port on the app's Configuration tab ("Guest port"), save, and restart the app. Guests then open that port.`
        : `Start Guest Assistant with another port (environment variable PORT), or stop the other program.`
      : mode === "app"
        ? `Restart the app; the Supervisor normally picks a free port for it. If this keeps happening, update the app.`
        : `Set INGRESS_PORT to another port, or stop the other program.`;
  switch (code) {
    case "EADDRINUSE":
      return `Guest Assistant cannot open ${what}: another app or program on this machine already uses that port. ${fix}`;
    case "EACCES":
    case "EPERM":
      return `Guest Assistant is not allowed to open ${what}. Ports below 1024 need special rights. ${fix}`;
    case "EADDRNOTAVAIL":
      return `Guest Assistant cannot open ${what}: the network address is not available on this machine. ${fix}`;
    default:
      return null;
  }
}
