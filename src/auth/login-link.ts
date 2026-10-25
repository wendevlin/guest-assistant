import type { BetterAuthPlugin, User } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import z from "zod";
import { isGuestEnabled } from "../guests";

/**
 * Sign-in with a guest's login link (`/#login=<token>`, see Guests.setLoginLink).
 * The link can be used any number of times until the admin replaces or
 * removes it. While the guest is switched off it signs nobody in, but it
 * stays valid and works again once the guest is switched back on.
 */
export function loginLink() {
  return {
    id: "guest-assistant-login-link",
    endpoints: {
      signInLink: createAuthEndpoint("/sign-in/link", { method: "POST", body: z.object({ token: z.string().min(1).max(200) }) }, async (ctx) => {
        const user = await ctx.context.adapter.findOne<User>({
          model: "user",
          where: [{ field: "loginLink", value: ctx.body.token }],
        });
        if (!user) throw new APIError("UNAUTHORIZED", { message: "Invalid login link", code: "INVALID_LOGIN_LINK" });
        if (!isGuestEnabled(user)) throw new APIError("FORBIDDEN", { message: "Account not active", code: "GUEST_DISABLED" });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to create session" });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ ok: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}
