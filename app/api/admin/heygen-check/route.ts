import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { getCurrentUser } from "@/lib/auth";
import { heygen } from "@/lib/heygen";

// Admin only: checks the HeyGen key with GET /v3/users/me (free, no render).
// In mock mode (the default) it answers from the fixture and calls nothing.
// Open /api/admin/heygen-check while signed in as an admin.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return Response.json({ ok: false, message: "Not found." }, { status: 404, headers: NO_STORE });
  }
  const client = heygen({ forPage: true });
  try {
    const me = await client.getCurrentUser();
    return Response.json(
      {
        ok: true,
        mock: client.mock,
        message: client.mock ? "Mock mode: no HeyGen call was made." : "HeyGen accepted the API key.",
        user: { billingType: me.billingType, username: me.username },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    logAdminError("[admin] heygen check failed", {}, error);
    return Response.json(
      { ok: false, mock: client.mock, message: plainAdminMessage(error, "HeyGen check failed. See server logs.") },
      { status: 502, headers: NO_STORE },
    );
  }
}
