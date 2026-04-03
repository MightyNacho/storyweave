import { Resend } from "resend";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_ADDRESS = process.env.EMAIL_FROM || "Story Weave <noreply@invites.storiesweave.org>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const { story, participants } = await request.json();

    // ── Input validation ─────────────────────────────────────────────────
    if (!story || !story.title || typeof story.title !== "string" || story.title.length > 200) {
      return Response.json({ error: "Invalid story." }, { status: 400 });
    }
    if (!Array.isArray(participants) || participants.length === 0 || participants.length > 20) {
      return Response.json({ error: "Invalid participants list." }, { status: 400 });
    }
    for (const p of participants) {
      if (!p.name || typeof p.name !== "string" || p.name.length > 100) {
        return Response.json({ error: "Invalid participant name." }, { status: 400 });
      }
      if (!p.email || !EMAIL_RE.test(p.email) || p.email.length > 254) {
        return Response.json({ error: `Invalid email: ${p.email}` }, { status: 400 });
      }
    }

    const results = await Promise.allSettled(
      participants.map((participant) =>
        resend.emails.send({
          from: FROM_ADDRESS,
          to: participant.email,
          subject: `You've been invited to write "${story.title}" on Story Weave`,
          html: buildInviteEmail({ story, participant }),
        })
      )
    );

    const failed = results
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason?.message);

    if (failed.length === participants.length) {
      return Response.json({ error: "All invitations failed to send." }, { status: 500 });
    }

    return Response.json({
      success: true,
      sent: results.filter((r) => r.status === "fulfilled").length,
      failed: failed.length,
    });
  } catch (error) {
    console.error("Invite email error:", error);
    return Response.json({ error: "Failed to send invitations." }, { status: 500 });
  }
}

function buildInviteEmail({ story, participant }) {
  const modeLabel = story.turnBased ? "Turn-Based" : "Free for All";
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
                story.turnBased
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
