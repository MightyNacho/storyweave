import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// The FROM address must be a verified domain in your Resend account.
// During development you can use: onboarding@resend.dev
const FROM_ADDRESS = process.env.EMAIL_FROM || "Story Weave <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function POST(request) {
  try {
    const { story, participants } = await request.json();

    if (!story || !participants?.length) {
      return Response.json(
        { error: "Missing story or participants." },
        { status: 400 }
      );
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
      return Response.json(
        { error: "All invitations failed to send.", details: failed },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      sent: results.filter((r) => r.status === "fulfilled").length,
      failed: failed.length,
    });
  } catch (error) {
    console.error("Invite email error:", error);
    return Response.json(
      { error: "Failed to send invitations." },
      { status: 500 }
    );
  }
}

function buildInviteEmail({ story, participant }) {
  const modeLabel = story.turnBased ? "Turn-Based" : "Free for All";
  const storyUrl = `${APP_URL}/story/${story.id}`;

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
                Hello <strong style="color:#e8e0d0;">${participant.name}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#aaa;line-height:1.7;">
                You've been invited to co-write a story on Story Weave.
              </p>

              <!-- Story card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e0d;border-radius:10px;border:1px solid #2a2825;margin-bottom:28px;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#E07A5F;">${modeLabel}</p>
                    <h2 style="margin:0 0 12px;font-family:'Georgia',serif;font-size:22px;color:#e8e0d0;">${story.title}</h2>
                    ${story.genre ? `<p style="margin:0 0 16px;font-size:13px;color:#888;font-style:italic;">${story.genre}</p>` : ""}
                    <p style="margin:0;font-size:13px;color:#666;">
                      ${story.participants.length} writer${story.participants.length !== 1 ? "s" : ""} · 
                      Your colour: <span style="color:${participant.color};font-weight:bold;">■</span> ${participant.color}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td align="center" style="background:#E07A5F;border-radius:8px;">
                    <a href="${storyUrl}" style="display:inline-block;padding:14px 32px;color:#fff;font-family:'Georgia',serif;font-size:15px;text-decoration:none;font-weight:bold;">
                      Open the Story →
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
                You were invited by someone using Story Weave · <a href="${APP_URL}" style="color:#888;">story-weave.app</a>
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
