import { Resend } from "resend";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_ADDRESS = process.env.EMAIL_FROM || "Story Weave <noreply@invites.storiesweave.org>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Escape user-supplied strings before inserting into HTML
const esc = (str) => String(str ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export async function POST(request) {
  // ── Auth check ──────────────────────────────────────────────────────────
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: { getAll() { return cookieStore.getAll(); } } }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const { storyId, email } = body;

    // ── Validate storyId ─────────────────────────────────────────────────
    if (!storyId || !UUID_RE.test(storyId)) {
      return Response.json({ error: "Invalid storyId." }, { status: 400 });
    }

    // ── Fetch story from DB (RLS ensures caller is creator or participant) ─
    const { data: story, error: dbError } = await supabase
      .from("stories")
      .select("*")
      .eq("id", storyId)
      .single();

    if (dbError || !story) {
      return Response.json({ error: "Story not found or access denied." }, { status: 404 });
    }

    const participants = story.participants || [];

    // ── Determine who to invite ──────────────────────────────────────────
    // If a specific email is provided, invite only that participant (must be in DB).
    // Otherwise invite all participants listed in the DB.
    let targets;
    if (email) {
      const emailLower = String(email).toLowerCase();
      const match = participants.find(p => p.email === emailLower);
      if (!match) {
        return Response.json({ error: "Participant not found in story." }, { status: 400 });
      }
      targets = [match];
    } else {
      targets = participants;
    }

    if (targets.length === 0) {
      return Response.json({ error: "No participants to invite." }, { status: 400 });
    }

    // ── Send emails using DB data only ───────────────────────────────────
    const results = await Promise.allSettled(
      targets.map((participant) =>
        resend.emails.send({
          from: FROM_ADDRESS,
          to: participant.email,
          subject: `You've been invited to write "${story.title}" on Story Weave`,
          html: buildInviteEmail({ story, participant }),
        })
      )
    );

    let sent = 0;
    const failed = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failed.push(result.reason?.message ?? "Unknown error");
      } else if (result.value?.error) {
        console.error("Resend error:", result.value.error);
        failed.push(result.value.error.message ?? "Resend error");
      } else {
        sent++;
      }
    }

    if (sent === 0) {
      return Response.json({ error: "All invitations failed to send.", details: failed }, { status: 500 });
    }

    return Response.json({ success: true, sent, failed: failed.length });
  } catch (error) {
    console.error("Invite email error:", error);
    return Response.json({ error: "Failed to send invitations." }, { status: 500 });
  }
}

function buildInviteEmail({ story, participant }) {
  const modeLabel = story.turn_based ? "Turn-Based" : "Free for All";
  const storyUrl = `${APP_URL}/story/${story.id}`;
  const participantCount = Array.isArray(story.participants) ? story.participants.length : 1;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#0f0e0d;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0d;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1917;border-radius:12px;overflow:hidden;border:1px solid #2a2825;">

          <!-- Header -->
          <tr>
            <td style="padding:40px 40px 24px;border-bottom:1px solid #2a2825;">
              <h1 style="margin:0;font-family:'Georgia',serif;font-size:32px;color:#e8e0d0;letter-spacing:-1px;">Story Weave</h1>
              <p style="margin:6px 0 0;font-size:13px;color:#888;font-style:italic;">Collaborative storytelling, one paragraph at a time.</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="margin:0 0 16px;font-size:16px;color:#d4cdc0;line-height:1.6;">
                Hello <strong style="color:#e8e0d0;">${esc(participant.name)}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#aaa;line-height:1.7;">
                You've been invited to co-write a story on Story Weave.
              </p>

              <!-- Story card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0d;border-radius:10px;border:1px solid #2a2825;margin-bottom:28px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#E07A5F;">${esc(modeLabel)}</p>
                    <h2 style="margin:0 0 12px;font-family:'Georgia',serif;font-size:22px;color:#e8e0d0;">${esc(story.title)}</h2>
                    ${story.genre ? `<p style="margin:0 0 16px;font-size:13px;color:#888;font-style:italic;">${esc(story.genre)}</p>` : ""}
                    <p style="margin:0;font-size:13px;color:#666;">
                      ${participantCount} writer${participantCount !== 1 ? "s" : ""} &middot;
                      Your colour: <span style="color:${esc(participant.color)};font-weight:bold;">&#9632;</span>
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td align="center" style="background:#E07A5F;border-radius:8px;">
                    <a href="${storyUrl}" style="display:inline-block;padding:14px 32px;color:#fff;font-family:'Georgia',serif;font-size:15px;text-decoration:none;font-weight:bold;">
                      Open the Story &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              ${
                story.turn_based
                  ? `<p style="margin:0;font-size:13px;color:#666;line-height:1.6;text-align:center;">
                  This is a turn-based story. You'll receive an email when it's your turn to write.
                </p>`
                  : `<p style="margin:0;font-size:13px;color:#666;line-height:1.6;text-align:center;">
                  This is a free-for-all story. Write whenever inspiration strikes.
                </p>`
              }
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #2a2825;">
              <p style="margin:0;font-size:11px;color:#555;text-align:center;">
                You were invited by someone using Story Weave &middot; <a href="${APP_URL}" style="color:#888;">storiesweave.org</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
