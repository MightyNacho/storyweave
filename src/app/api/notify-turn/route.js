import { Resend } from "resend";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_ADDRESS = process.env.EMAIL_FROM || "Story Weave <noreply@invites.storiesweave.org>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const { story, currentParticipant, previousParticipant } = await request.json();

    // ── Input validation ─────────────────────────────────────────────────
    if (!story || !story.title || typeof story.title !== "string" || story.title.length > 200) {
      return Response.json({ error: "Invalid story." }, { status: 400 });
    }
    if (!currentParticipant?.email || !EMAIL_RE.test(currentParticipant.email)) {
      return Response.json({ error: "Invalid participant email." }, { status: 400 });
    }
    if (!currentParticipant?.name || typeof currentParticipant.name !== "string" || currentParticipant.name.length > 100) {
      return Response.json({ error: "Invalid participant name." }, { status: 400 });
    }

    const storyUrl = `${APP_URL}/story/${story.id}`;
    const entries = Array.isArray(story.entries) ? story.entries : [];
    const wordCount = entries.map((e) => e.text).join(" ").split(/\s+/).filter(Boolean).length;
    const lastEntry = entries[entries.length - 1];

    const { data, error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: currentParticipant.email,
      subject: `It's your turn to write in "${story.title}"`,
      html: buildTurnEmail({ story, currentParticipant, previousParticipant, storyUrl, wordCount, lastEntry }),
    });

    if (error) {
      console.error("Turn notification error:", error);
      return Response.json({ error: "Failed to send turn notification." }, { status: 500 });
    }

    return Response.json({ success: true, emailId: data?.id });
  } catch (error) {
    console.error("Turn notification error:", error);
    return Response.json({ error: "Failed to send turn notification." }, { status: 500 });
  }
}

function buildTurnEmail({ story, currentParticipant, previousParticipant, storyUrl, wordCount, lastEntry }) {
  const safeLastEntryText = lastEntry
    ? esc(lastEntry.text.length > 200 ? lastEntry.text.slice(0, 200) + "…" : lastEntry.text)
    : null;

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

              <!-- Turn alert -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0d;border-radius:10px;border-left:4px solid ${esc(currentParticipant.color)};margin-bottom:28px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:${esc(currentParticipant.color)};">Your Turn</p>
                    <h2 style="margin:0;font-family:'Georgia',serif;font-size:20px;color:#e8e0d0;">
                      ${esc(currentParticipant.name)}, the pen is yours.
                    </h2>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;font-size:15px;color:#aaa;line-height:1.7;">
                ${previousParticipant ? `<strong style="color:#d4cdc0;">${esc(previousParticipant.name)}</strong> just added to` : "It's time to continue"}
                <em style="color:#e8e0d0;">${esc(story.title)}</em>.
                The story is now ${wordCount} words long.
              </p>

              ${safeLastEntryText ? `
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0d;border-radius:10px;border:1px solid #2a2825;margin-bottom:28px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#555;">Last written</p>
                    <p style="margin:0;font-size:15px;color:#d4cdc0;line-height:1.8;font-style:italic;">
                      &ldquo;${safeLastEntryText}&rdquo;
                    </p>
                    <p style="margin:10px 0 0;font-size:12px;color:#666;">&mdash; ${esc(lastEntry.author)}</p>
                  </td>
                </tr>
              </table>` : ""}

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td align="center" style="background:#E07A5F;border-radius:8px;">
                    <a href="${storyUrl}" style="display:inline-block;padding:14px 32px;color:#fff;font-family:'Georgia',serif;font-size:15px;text-decoration:none;font-weight:bold;">
                      Write Now &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#555;text-align:center;line-height:1.6;">
                Take your time. The story will wait for you.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #2a2825;">
              <p style="margin:0;font-size:11px;color:#555;text-align:center;">
                Story Weave &middot; <a href="${APP_URL}" style="color:#888;">storiesweave.org</a>
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
