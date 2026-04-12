import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const PRESET_COLORS = [
  "#E07A5F", "#3D405B", "#81B29A", "#F2CC8F", "#BC4749",
  "#6B4226", "#457B9D", "#A8DADC", "#E9C46A", "#264653",
];

export async function POST(request) {
  // ── Auth check (session client, respects RLS) ────────────────────────────
  const cookieStore = await cookies();
  const sessionClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: { getAll() { return cookieStore.getAll(); } } }
  );
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized." }, { status: 401 });

  const { storyId } = await request.json().catch(() => ({}));
  if (!storyId || typeof storyId !== "string") {
    return Response.json({ error: "Missing storyId." }, { status: 400 });
  }

  // ── Admin client bypasses RLS ────────────────────────────────────────────
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: story } = await admin
    .from("stories")
    .select("*")
    .eq("id", storyId)
    .single();

  if (!story) return Response.json({ error: "Story not found." }, { status: 404 });

  // ── Check invite link is still active ────────────────────────────────────
  if (!story.open_invite_expires_at || new Date(story.open_invite_expires_at) <= new Date()) {
    return Response.json({ error: "Invite link has expired." }, { status: 403 });
  }

  // ── Add user to participants if not already in ───────────────────────────
  const userEmail = user.email.toLowerCase();
  const alreadyIn = (story.participants || []).some(p => p.email === userEmail);

  if (!alreadyIn) {
    const usedColors = (story.participants || []).map(p => p.color);
    const color = PRESET_COLORS.find(c => !usedColors.includes(c)) || PRESET_COLORS[0];
    const newP = {
      name: user.user_metadata?.full_name || user.user_metadata?.name || userEmail,
      email: userEmail,
      color,
    };
    const updated = [...(story.participants || []), newP];
    await admin.from("stories").update({ participants: updated }).eq("id", storyId);
    story.participants = updated;
  }

  return Response.json({ story });
}
