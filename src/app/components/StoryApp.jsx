'use client';
import { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";



// ── Palette helpers ────────────────────────────────────────────────────────
const PRESET_COLORS = [
  "#E07A5F", "#3D405B", "#81B29A", "#F2CC8F", "#BC4749",
  "#6B4226", "#457B9D", "#A8DADC", "#E9C46A", "#264653",
];

const hexToRgb = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
};

// ── Supabase mapping helpers ───────────────────────────────────────────────
const toDb = (story) => ({
  title: story.title,
  genre: story.genre || "",
  turn_based: story.turnBased,
  open_invite_expires_at: story.openInviteExpiresAt || null,
  participants: [...(story.participants || []), ...(story.leftParticipants || [])],
  entries: story.entries,
  current_turn_index: story.currentTurnIndex,
});

const fromDb = (row) => {
  const allP = row.participants || [];
  return {
    id: row.id,
    title: row.title,
    genre: row.genre || "",
    turnBased: row.turn_based,
    openInviteExpiresAt: row.open_invite_expires_at || null,
    participants: allP.filter(p => !p.left),
    leftParticipants: allP.filter(p => p.left),
    entries: row.entries || [],
    currentTurnIndex: row.current_turn_index || 0,
    creatorId: row.creator_id,
    createdAt: row.created_at,
  };
};

// ── Email invite helper ────────────────────────────────────────────────────
// storyId: DB UUID of the story
// email (optional): invite a single participant; omit to invite all in the story
const sendInvites = async (storyId, email = null) => {
  const res = await fetch("/api/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(email ? { storyId, email } : { storyId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
};

export default function App({ storyId } = {}) {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState("dashboard");
  const [stories, setStories] = useState([]);
  const [activeStory, setActiveStory] = useState(null);
  const [editingStory, setEditingStory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [shareModalStory, setShareModalStory] = useState(null);

  // Auth state — also handles ?code= PKCE exchange if OAuth redirected to root
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    const init = async () => {
      if (code) {
        // Exchange the PKCE code if it landed here instead of /auth/callback
        await supabase.auth.exchangeCodeForSession(code);
        // Clean the URL so the code doesn't linger
        window.history.replaceState({}, "", window.location.pathname);
      }
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
      setAuthLoading(false);
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Load stories when signed in
  useEffect(() => {
    if (!session) { setLoading(false); return; }
    setLoading(true);
    const load = async () => {
      const userEmailLower = session.user.email.toLowerCase();

      const [ownedRes, participatedRes] = await Promise.all([
        supabase
          .from("stories")
          .select("*")
          .eq("creator_id", session.user.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("stories")
          .select("*")
          .filter("participants", "cs", JSON.stringify([{ email: userEmailLower }]))
          .order("created_at", { ascending: false }),
      ]);

      const seen = new Set();
      const allRows = [...(ownedRes.data || []), ...(participatedRes.data || [])].filter(row => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
      allRows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const loaded = allRows
        .map(fromDb)
        .filter(s => !(s.leftParticipants || []).some(
          p => p.email.toLowerCase() === userEmailLower
        ));
      setStories(loaded);

      if (storyId) {
        const target = loaded.find(s => s.id === storyId);
        if (target) {
          setActiveStory(target); setView("story");
        } else {
          // Not in user's list — try to join via invite link
          const res = await fetch("/api/join", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ storyId }),
          });
          if (res.ok) {
            const { story: row } = await res.json();
            const joined = fromDb(row);
            setStories(prev => [joined, ...prev]);
            setActiveStory(joined);
            setView("story");
          }
        }
      }
      setLoading(false);
    };
    load();
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  const openStory = (story) => { setActiveStory(story); setView("story"); };
  const goHome = () => { setView("dashboard"); setActiveStory(null); setEditingStory(null); };

  const updateActiveStory = async (updated) => {
    setActiveStory(updated);
    setStories(prev => prev.map(s => s.id === updated.id ? updated : s));
    await supabase.from("stories").update(toDb(updated)).eq("id", updated.id);
  };

  const createStory = async (newStory) => {
    // Build the full story object locally — we don't need the server to give it back
    const created = { ...newStory, creatorId: session.user.id };
    setStories(prev => [created, ...prev]);
    setActiveStory(created);
    setView("story");
    // Share modal is opened AFTER the insert so the row exists before any
    // UPDATE (share link / email invite) can run against it.

    const { error } = await supabase
      .from("stories")
      .insert({ id: newStory.id, ...toDb(newStory), creator_id: session.user.id });

    if (error) {
      console.error("Story creation failed:", error);
      // Roll back optimistic state so the user isn't stuck on a phantom story
      setStories(prev => prev.filter(s => s.id !== created.id));
      setActiveStory(null);
      setView("create");
      return;
    }

    setShareModalStory(created); // safe to open — story now exists in DB
  };

  const deleteStory = async (id) => {
    setStories(prev => prev.filter(s => s.id !== id));
    await supabase.from("stories").delete().eq("id", id);
  };

  const leaveStory = async (id) => {
    const story = stories.find(s => s.id === id);
    if (!story) return;
    const userEmailLower = session.user.email.toLowerCase();
    const markedLeft = story.participants
      .filter(p => p.email.toLowerCase() === userEmailLower)
      .map(p => ({ ...p, left: true }));
    const remaining = story.participants.filter(
      p => p.email.toLowerCase() !== userEmailLower
    );
    setStories(prev => prev.filter(s => s.id !== id));
    await supabase.from("stories").update({
      participants: [...remaining, ...(story.leftParticipants || []), ...markedLeft],
    }).eq("id", id);
  };

  const startEdit = (story) => { setEditingStory(story); setView("edit"); };

  const saveEdit = async (updated) => {
    setStories(prev => prev.map(s => s.id === updated.id ? updated : s));
    goHome();
    await supabase.from("stories").update(toDb(updated)).eq("id", updated.id);
  };

  if (authLoading) {
    return (
      <div style={styles.root}>
        <div style={styles.grain} />
        <p style={{ ...styles.muted, position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }}>
          Loading…
        </p>
      </div>
    );
  }

  if (!session) return <LoginScreen storyId={storyId} />;

  return (
    <div style={styles.root}>
      <div style={styles.grain} />
      {view === "dashboard" && (
        <Dashboard
          stories={stories}
          loading={loading}
          user={session.user}
          onOpen={openStory}
          onDelete={deleteStory}
          onLeave={leaveStory}
          onEdit={startEdit}
          onCreate={() => setView("create")}
          onSignOut={() => supabase.auth.signOut()}
        />
      )}
      {view === "create" && (
        <CreateStory onCancel={goHome} onCreate={createStory} user={session.user} />
      )}
      {view === "edit" && editingStory && (
        <EditStory story={editingStory} onCancel={goHome} onSave={saveEdit} />
      )}
      {view === "story" && activeStory && (
        <StoryEditor
          story={activeStory}
          onBack={goHome}
          onUpdate={updateActiveStory}
          onEdit={() => startEdit(activeStory)}
          userEmail={session.user.email}
          userId={session.user.id}
        />
      )}
      {shareModalStory && (
        <ShareModal
          story={shareModalStory}
          user={session.user}
          onClose={() => setShareModalStory(null)}
          onUpdate={(updated) => {
            setShareModalStory(updated);
            updateActiveStory(updated);
          }}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// LOGIN SCREEN
// ══════════════════════════════════════════════════════════════════════════
function LoginScreen({ storyId }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const next = storyId ? `/story/${storyId}` : "/";
  const callbackUrl = typeof window !== "undefined"
    ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
    : "/auth/callback";

  const handleGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl },
    });
  };

  const handleEmail = async (e) => {
    e.preventDefault();
    if (!email.includes("@")) return setError("Enter a valid email address.");
    setError("");
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callbackUrl },
    });
    if (error) setError(error.message);
    else setSent(true);
    setLoading(false);
  };

  return (
    <div style={styles.root}>
      <div style={styles.grain} />
      <div style={loginStyles.wrap}>
        <h1 style={{ ...styles.logo, marginBottom: 4 }}>Story Weave</h1>
        <p style={loginStyles.subtitle}>Collaborative storytelling, one paragraph at a time.</p>

        <button style={loginStyles.googleBtn} onClick={handleGoogle}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 11.83 17.64 9.67 17.64 9.2z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
            <path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.548 0 9s.348 2.825.957 4.039l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>

        <div style={loginStyles.divider}>
          <div style={loginStyles.dividerLine} />
          <span style={loginStyles.dividerText}>or</span>
          <div style={loginStyles.dividerLine} />
        </div>

        {sent ? (
          <p style={loginStyles.sent}>✓ Check your email for a magic link.</p>
        ) : (
          <form onSubmit={handleEmail} style={loginStyles.form}>
            <input
              style={{ ...styles.input, marginBottom: 0 }}
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            {error && <p style={loginStyles.error}>{error}</p>}
            <button
              type="submit"
              style={{ ...styles.btnPrimary, width: "100%", opacity: loading ? 0.6 : 1 }}
              disabled={loading}
            >
              {loading ? "Sending…" : "Send Magic Link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const loginStyles = {
  wrap: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "100vh", padding: "40px 24px",
    maxWidth: 380, margin: "0 auto", width: "100%",
  },
  subtitle: {
    color: "#666", fontSize: 14, fontStyle: "italic", textAlign: "center",
    marginBottom: 40, marginTop: 0,
  },
  googleBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
    width: "100%", background: "#fff", color: "#111", border: "none",
    borderRadius: 8, padding: "11px 20px", cursor: "pointer", fontSize: 14,
    fontWeight: 500, fontFamily: "'DM Sans', sans-serif",
  },
  divider: {
    display: "flex", alignItems: "center", gap: 12, width: "100%", margin: "20px 0",
  },
  dividerLine: { flex: 1, height: 1, background: "#2a2825" },
  dividerText: { color: "#555", fontSize: 12 },
  form: { display: "flex", flexDirection: "column", gap: 10, width: "100%" },
  sent: { color: "#81B29A", textAlign: "center", fontSize: 14, margin: 0 },
  error: { color: "#E07A5F", fontSize: 12, margin: 0 },
};

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════
function Dashboard({ stories, loading, user, onOpen, onDelete, onLeave, onEdit, onCreate, onSignOut }) {
  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.logo}>Story Weave</h1>
          <p style={styles.tagline}>Collaborative storytelling, one paragraph at a time.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {user?.user_metadata?.avatar_url && (
            <img
              src={user.user_metadata.avatar_url}
              alt=""
              style={{ width: 30, height: 30, borderRadius: "50%", border: "1px solid #2a2825" }}
            />
          )}
          <button style={styles.btnPrimary} onClick={onCreate}>+ New Story</button>
          <button style={styles.btnSecondary} onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {loading ? (
        <p style={styles.muted}>Loading your stories…</p>
      ) : stories.length === 0 ? (
        <div style={styles.empty}>
          <span style={styles.emptyIcon}>✦</span>
          <p style={styles.emptyText}>No stories yet. Begin your first.</p>
          <button style={styles.btnPrimary} onClick={onCreate}>Create a Story</button>
        </div>
      ) : (
        <div style={styles.grid}>
          {stories.map(s => (
            <StoryCard key={s.id} story={s} onOpen={onOpen} onDelete={onDelete} onLeave={onLeave} onEdit={onEdit} userId={user.id} userEmail={user.email} />
          ))}
        </div>
      )}
    </div>
  );
}

function StoryCard({ story, onOpen, onDelete, onLeave, onEdit, userId, userEmail }) {
  const isCreator = story.creatorId === userId;
  const isParticipant = !isCreator && story.participants.some(
    p => p.email.toLowerCase() === userEmail?.toLowerCase()
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const preview = story.entries.map(e => e.text).join(" ").slice(0, 120);

  const handleDelete = (e) => {
    e.stopPropagation();
    setMenuOpen(false);
    setConfirmDelete(true);
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    setMenuOpen(false);
    onEdit(story);
  };

  const handleLeave = (e) => {
    e.stopPropagation();
    setMenuOpen(false);
    setConfirmLeave(true);
  };

  return (
    <>
      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div style={styles.modalOverlay} onClick={() => setConfirmDelete(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Delete this story?</h3>
            <p style={styles.modalBody}>
              <em style={{ color: "#e8e0d0" }}>{story.title}</em> and all its entries will be permanently removed. This cannot be undone.
            </p>
            <div style={styles.modalActions}>
              <button style={styles.btnSecondary} onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button
                style={{ ...styles.btnPrimary, background: "#BC4749" }}
                onClick={() => { setConfirmDelete(false); onDelete(story.id); }}
              >Delete Forever</button>
            </div>
          </div>
        </div>
      )}

      {/* Leave confirmation modal */}
      {confirmLeave && (
        <div style={styles.modalOverlay} onClick={() => setConfirmLeave(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Leave this story?</h3>
            <p style={styles.modalBody}>
              You'll be removed from <em style={{ color: "#e8e0d0" }}>{story.title}</em>. The story will continue for other collaborators.
            </p>
            <div style={styles.modalActions}>
              <button style={styles.btnSecondary} onClick={() => setConfirmLeave(false)}>Cancel</button>
              <button
                style={{ ...styles.btnPrimary, background: "#BC4749" }}
                onClick={() => { setConfirmLeave(false); onLeave(story.id); }}
              >Leave Story</button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.card} onClick={() => { if (!menuOpen) onOpen(story); }}>
        <div style={styles.cardTop}>
          <span style={styles.cardMode}>{story.turnBased ? "Turn-based" : "Free for all"}</span>

          {/* ⋯ menu */}
          <div style={{ position: "relative" }}>
            <button
              style={styles.menuBtn}
              onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
              title="Options"
            >⋯</button>
            {menuOpen && (
              <>
                {/* click-away */}
                <div
                  style={styles.menuBackdrop}
                  onClick={e => { e.stopPropagation(); setMenuOpen(false); }}
                />
                <div style={styles.dropdown}>
                  {isCreator && (
                    <>
                      <button style={styles.dropdownItem} onClick={handleEdit}>
                        <span style={styles.dropdownIcon}>✎</span> Edit
                      </button>
                      <div style={styles.dropdownDivider} />
                      <button style={{ ...styles.dropdownItem, color: "#BC4749" }} onClick={handleDelete}>
                        <span style={styles.dropdownIcon}>⌫</span> Delete
                      </button>
                    </>
                  )}
                  {isParticipant && (
                    <button style={{ ...styles.dropdownItem, color: "#BC4749" }} onClick={handleLeave}>
                      <span style={styles.dropdownIcon}>✕</span> Leave story
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <h2 style={styles.cardTitle}>{story.title}</h2>
        <p style={styles.cardPreview}>{preview || "No entries yet…"}</p>
        <div style={styles.cardAuthors}>
          {story.participants.slice(0, 5).map((p, i) => (
            <div
              key={`${p.email}-${i}`}
              title={p.name || p.email}
              style={{ ...styles.authorDot, background: p.color }}
            />
          ))}
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SHARE MODAL
// ══════════════════════════════════════════════════════════════════════════
function ShareModal({ story, onClose, onUpdate }) {
  const [currentStory, setCurrentStory] = useState(story);
  const [rows, setRows] = useState([{ name: "", email: "", color: "" }]);
  const [inviteStatus, setInviteStatus] = useState({});
  const [copied, setCopied] = useState(false);

  const nextColor = (existingStory) => {
    const used = existingStory.participants.map(p => p.color);
    return PRESET_COLORS.find(c => !used.includes(c)) || PRESET_COLORS[0];
  };

  // Initialise first row's color based on story participants
  useEffect(() => {
    setRows([{ name: "", email: "", color: nextColor(currentStory) }]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addRow = () => {
    const color = nextColor({ participants: [...currentStory.participants, ...rows.filter(r => r.email)] });
    setRows(prev => [...prev, { name: "", email: "", color }]);
  };

  const updateRow = (i, field, val) => {
    setRows(prev => { const u = [...prev]; u[i] = { ...u[i], [field]: val }; return u; });
  };

  const removeRow = (i) => {
    setRows(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleSendInvite = async (row, i) => {
    const emailLower = row.email.trim().toLowerCase();
    if (!row.name.trim() || !emailLower.includes("@")) return;

    setInviteStatus(s => ({ ...s, [emailLower]: "sending" }));

    // Add to DB first (invite API requires participant to exist in story)
    // Include leftParticipants so the left: true records are preserved in the DB
    const newActive = [...currentStory.participants, { name: row.name.trim(), email: emailLower, color: row.color }];
    await supabase.from("stories").update({
      participants: [...newActive, ...(currentStory.leftParticipants || [])],
    }).eq("id", currentStory.id);
    const updated = { ...currentStory, participants: newActive };
    setCurrentStory(updated);
    onUpdate(updated);

    // Send invite email
    try {
      await sendInvites(currentStory.id, emailLower);
      setInviteStatus(s => ({ ...s, [emailLower]: "sent" }));
    } catch {
      setInviteStatus(s => ({ ...s, [emailLower]: "error" }));
    }

    setTimeout(() => {
      setRows(prev => prev.filter((_, idx) => idx !== i));
      setInviteStatus(s => { const n = { ...s }; delete n[emailLower]; return n; });
    }, 2000);
  };

  const handleShareLink = async () => {
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("stories").update({ open_invite_expires_at: expiresAt }).eq("id", currentStory.id);
    const updated = { ...currentStory, openInviteExpiresAt: expiresAt };
    setCurrentStory(updated);
    onUpdate(updated);
    navigator.clipboard.writeText(`${window.location.origin}/story/${currentStory.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 480, width: "100%" }} onClick={e => e.stopPropagation()}>
        <h2 style={{ ...styles.modalTitle, marginBottom: 4 }}>Invite Collaborators</h2>
        <p style={{ ...styles.modalBody, marginBottom: 20 }}>
          Add writers to <em>{currentStory.title}</em> by email, or share an open link.
        </p>

        {/* Participant rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          {rows.map((row, i) => {
            const emailLower = row.email.trim().toLowerCase();
            const status = inviteStatus[emailLower];
            const canInvite = row.name.trim() && emailLower.includes("@");
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    style={{ ...styles.input, flex: "0 0 130px", marginBottom: 0 }}
                    placeholder="Name"
                    value={row.name}
                    onChange={e => updateRow(i, "name", e.target.value)}
                  />
                  <input
                    style={{ ...styles.input, flex: 1, marginBottom: 0 }}
                    placeholder="email@example.com"
                    value={row.email}
                    onChange={e => updateRow(i, "email", e.target.value)}
                  />
                  {rows.length > 1 && (
                    <button style={styles.removeBtn} onClick={() => removeRow(i)}>✕</button>
                  )}
                </div>
                {canInvite && (
                  <div style={styles.inviteRow}>
                    <button
                      style={{
                        ...styles.inviteBtn,
                        ...(status === "sent" ? styles.inviteBtnSent : {}),
                        ...(status === "error" ? { color: "#BC4749", border: "1px solid #BC4749" } : {}),
                        opacity: status === "sending" ? 0.6 : 1,
                      }}
                      disabled={status === "sending" || status === "sent"}
                      onClick={() => handleSendInvite(row, i)}
                    >
                      {status === "sending" ? "Sending…" : status === "sent" ? "Invited!" : status === "error" ? "Failed — retry?" : "Send Invite"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <button style={{ ...styles.btnSecondary, marginBottom: 20 }} onClick={addRow}>
          + Add Another
        </button>

        {/* Share link */}
        <div style={{ borderTop: "1px solid #2a2825", paddingTop: 16, marginBottom: 24 }}>
          <label style={{ ...styles.label, marginBottom: 10 }}>Or share an open link <span style={styles.optional}>(2-day access)</span></label>
          <button
            style={{
              ...styles.pillBtn,
              ...(copied ? { color: "#81B29A", border: "1px solid #81B29A" } : {}),
            }}
            onClick={handleShareLink}
          >
            {copied ? "Link copied!" : "Copy Share Link"}
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button style={styles.btnPrimary} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// CREATE STORY
// ══════════════════════════════════════════════════════════════════════════
function CreateStory({ onCancel, onCreate, user }) {
  const creatorName = user?.user_metadata?.full_name || user?.user_metadata?.name || "";
  const creatorEmail = user?.email || "";

  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [turnBased, setTurnBased] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = () => {
    if (!title.trim()) return setError("Please give your story a title.");
    const story = {
      id: crypto.randomUUID(),
      title: title.trim(),
      genre: genre.trim(),
      turnBased,
      openInviteExpiresAt: null,
      participants: [{ name: creatorName, email: creatorEmail.toLowerCase(), color: PRESET_COLORS[0] }],
      entries: [],
      currentTurnIndex: 0,
      createdAt: new Date().toISOString(),
    };
    onCreate(story);
  };

  return (
    <div style={styles.page}>
      <button style={styles.backBtn} onClick={onCancel}>← Back</button>
      <div style={styles.createWrap}>
        <h1 style={styles.createTitle}>Begin a New Story</h1>

        <label style={styles.label}>Story Title</label>
        <input
          style={styles.input}
          placeholder="The Lighthouse at the Edge of the World…"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />

        <label style={styles.label}>Genre / Vibe <span style={styles.optional}>(optional)</span></label>
        <input
          style={styles.input}
          placeholder="Gothic horror, space opera, cozy mystery…"
          value={genre}
          onChange={e => setGenre(e.target.value)}
        />

        <label style={styles.label}>Writing Mode</label>
        <div style={styles.toggleRow}>
          <span style={styles.toggleLabel}>Free for All</span>
          <div
            style={{ ...styles.toggle, background: turnBased ? "#E07A5F" : "#3a3a3a" }}
            onClick={() => setTurnBased(!turnBased)}
          >
            <div style={{ ...styles.toggleThumb, transform: turnBased ? "translateX(20px)" : "translateX(2px)" }} />
          </div>
          <span style={styles.toggleLabel}>Turn-Based</span>
        </div>

        {error && <p style={styles.errorText}>{error}</p>}

        <button
          style={{ ...styles.btnPrimary, width: "100%", marginTop: 24 }}
          onClick={handleCreate}
        >
          Create Story →
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// EDIT STORY
// ══════════════════════════════════════════════════════════════════════════
function EditStory({ story, onCancel, onSave }) {
  const [title, setTitle] = useState(story.title);
  const [genre, setGenre] = useState(story.genre || "");
  const [turnBased, setTurnBased] = useState(story.turnBased);
  const [participants, setParticipants] = useState(
    story.participants.length > 0 ? story.participants : [{ name: "", email: "", color: PRESET_COLORS[0] }]
  );
  const [currentExpiresAt, setCurrentExpiresAt] = useState(story.openInviteExpiresAt);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [inviteStatus, setInviteStatus] = useState({}); // { email: "sending"|"sent"|"error" }

  const handleShareLink = async () => {
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    setCurrentExpiresAt(expiresAt);
    await supabase.from("stories").update({ open_invite_expires_at: expiresAt }).eq("id", story.id);
    navigator.clipboard.writeText(`${window.location.origin}/story/${story.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const originalEmails = new Set(story.participants.map(p => p.email));

  const addParticipant = () => {
    if (participants.length >= 10) return;
    const usedColors = participants.map(p => p.color);
    const nextColor = PRESET_COLORS.find(c => !usedColors.includes(c)) || PRESET_COLORS[0];
    setParticipants([...participants, { name: "", email: "", color: nextColor }]);
  };

  const updateParticipant = (i, field, val) => {
    const updated = [...participants];
    updated[i] = { ...updated[i], [field]: val };
    setParticipants(updated);
  };

  const removeParticipant = (i) => {
    if (participants.length <= 1) return;
    setParticipants(participants.filter((_, idx) => idx !== i));
  };

  const handleSendInvite = async (p) => {
    if (!p.name.trim() || !p.email.includes("@")) return;
    setInviteStatus(s => ({ ...s, [p.email]: "sending" }));
    try {
      await sendInvites(story.id, p.email);
      setInviteStatus(s => ({ ...s, [p.email]: "sent" }));
      setTimeout(() => setInviteStatus(s => { const n = { ...s }; delete n[p.email]; return n; }), 3000);
    } catch (err) {
      setInviteStatus(s => ({ ...s, [p.email]: "error" }));
      setTimeout(() => setInviteStatus(s => { const n = { ...s }; delete n[p.email]; return n; }), 4000);
      console.error("Invite failed:", err.message);
    }
  };

  const handleSave = () => {
    if (!title.trim()) return setError("Please give your story a title.");
    const validP = participants.filter(p => p.email.trim() || p.name.trim());
    if (validP.length === 0) return setError("Add at least one participant.");
    for (const p of validP) {
      if (!p.name.trim()) return setError("Every participant needs a name.");
      if (!p.email.includes("@")) return setError(`"${p.email}" doesn't look like a valid email.`);
    }
    onSave({
      ...story,
      title: title.trim(),
      genre: genre.trim(),
      turnBased,
      openInviteExpiresAt: currentExpiresAt,
      participants: validP.map(p => ({ ...p, email: p.email.trim().toLowerCase() })),
    });
  };

  return (
    <div style={styles.page}>
      <button style={styles.backBtn} onClick={onCancel}>← Back</button>
      <div style={styles.createWrap}>
        <h1 style={styles.createTitle}>Edit Story</h1>

        <label style={styles.label}>Story Title</label>
        <input
          style={styles.input}
          placeholder="The Lighthouse at the Edge of the World…"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />

        <label style={styles.label}>Genre / Vibe <span style={styles.optional}>(optional)</span></label>
        <input
          style={styles.input}
          placeholder="Gothic horror, space opera, cozy mystery…"
          value={genre}
          onChange={e => setGenre(e.target.value)}
        />

        <label style={styles.label}>Writing Mode</label>
        <div style={styles.toggleRow}>
          <span style={styles.toggleLabel}>Free for All</span>
          <div
            style={{ ...styles.toggle, background: turnBased ? "#E07A5F" : "#3a3a3a" }}
            onClick={() => setTurnBased(!turnBased)}
          >
            <div style={{ ...styles.toggleThumb, transform: turnBased ? "translateX(20px)" : "translateX(2px)" }} />
          </div>
          <span style={styles.toggleLabel}>Turn-Based</span>
        </div>

        <label style={styles.label}>Participants</label>
        <div style={styles.participantList}>
          {participants.map((p, i) => {
            const isNew = p.email && !originalEmails.has(p.email);
            const status = inviteStatus[p.email];
            const canInvite = p.name.trim() && p.email.includes("@");
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={styles.participantRow}>
                  <input
                    style={{ ...styles.input, flex: "0 0 130px", marginBottom: 0 }}
                    placeholder="Name"
                    value={p.name}
                    onChange={e => updateParticipant(i, "name", e.target.value)}
                  />
                  <input
                    style={{ ...styles.input, flex: 1, marginBottom: 0 }}
                    placeholder="email@example.com"
                    value={p.email}
                    onChange={e => updateParticipant(i, "email", e.target.value)}
                  />
                  <div style={styles.colorPickerWrap}>
                    {PRESET_COLORS.map(c => (
                      <div
                        key={c}
                        onClick={() => updateParticipant(i, "color", c)}
                        style={{
                          ...styles.colorSwatch,
                          background: c,
                          outline: p.color === c ? `2px solid #fff` : "none",
                          outlineOffset: "2px",
                        }}
                      />
                    ))}
                  </div>
                  {participants.length > 1 && (
                    <button style={styles.removeBtn} onClick={() => removeParticipant(i)}>✕</button>
                  )}
                </div>
                {/* Send Invite row — shown for new participants or anyone with a valid email */}
                {canInvite && (
                  <div style={styles.inviteRow}>
                    <button
                      style={{
                        ...styles.inviteBtn,
                        ...(status === "sent" ? styles.inviteBtnSent : {}),
                        ...(status === "error" ? { color: "#BC4749", border: "1px solid #BC4749" } : {}),
                        opacity: status === "sending" ? 0.6 : 1,
                      }}
                      onClick={() => handleSendInvite(p)}
                      disabled={!!status}
                    >
                      {status === "sending" ? "Sending…"
                        : status === "sent" ? "✓ Invite sent"
                        : status === "error" ? "✕ Failed — check console"
                        : isNew ? "✉ Send Invite"
                        : "✉ Resend Invite"}
                    </button>
                    {isNew && !status && (
                      <span style={styles.newBadge}>New</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <button style={styles.btnSecondary} onClick={addParticipant}>+ Add Participant</button>
        </div>

        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={styles.label}>Link Sharing</label>
          <button
            type="button"
            style={{
              ...styles.pillBtn,
              alignSelf: "flex-start",
              ...(copied ? { color: "#81B29A", border: "1px solid #81B29A" } : {}),
            }}
            onClick={handleShareLink}
          >
            {copied ? "Copied link!" : "Share Link"}
          </button>
        </div>

        {error && <p style={styles.errorText}>{error}</p>}

        <button style={{ ...styles.btnPrimary, width: "100%", marginTop: 24 }} onClick={handleSave}>
          Save Changes →
        </button>
      </div>
    </div>
  );
}
function StoryEditor({ story, onBack, onUpdate, onEdit, userEmail, userId }) {
  const isCreator = story.creatorId === userId;
  const [text, setText] = useState("");
  const [turnBased, setTurnBased] = useState(story.turnBased);
  const [inlineMode, setInlineMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? !window.matchMedia("(max-width: 768px)").matches : true
  );
  const [reminderSent, setReminderSent] = useState(new Set());
  const [reminderFeedback, setReminderFeedback] = useState(new Set());
  const [showPassModal, setShowPassModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showTopBar, setShowTopBar] = useState(false);
  const bottomRef = useRef(null);
  const scrollRef = useRef(null);
  const lastScrollY = useRef(0);
  const touchStartX = useRef(null);
  const touchStartY = useRef(null);

  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) return;
    const t = setTimeout(() => setSidebarOpen(false), 2000);
    return () => clearTimeout(t);
  }, []);

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      setSidebarOpen(deltaX > 0);
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  useEffect(() => {
    setReminderSent(new Set());
  }, [story.currentTurnIndex]);

  const activeParticipant = story.participants.find(
    p => p.email.toLowerCase() === userEmail?.toLowerCase()
  ) || story.participants[0];
  const currentTurnParticipant = story.participants[story.currentTurnIndex % story.participants.length];

  const canWrite = !turnBased || activeParticipant?.email === currentTurnParticipant?.email;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    const el = scrollRef.current;
    if (el) {
      const canScroll = el.scrollHeight > el.clientHeight;
      setShowTopBar(!canScroll);
    }
  }, [story.entries]);

  const handleSubmit = () => {
    if (!text.trim() || !canWrite) return;
    const newEntry = {
      id: Date.now().toString(),
      text: text.trim(),
      author: activeParticipant.name || activeParticipant.email,
      email: activeParticipant.email,
      color: activeParticipant.color,
      timestamp: new Date().toISOString(),
    };
    const updated = {
      ...story,
      turnBased,
      entries: [...story.entries, newEntry],
    };
    onUpdate(updated);
    setText("");
  };

  const handlePassQuill = async () => {
    const nextIndex = (story.currentTurnIndex + 1) % story.participants.length;
    const nextParticipant = story.participants[nextIndex];
    const updated = { ...story, turnBased: true, currentTurnIndex: nextIndex };
    setTurnBased(true);
    onUpdate(updated);
    setShowPassModal(false);
    try {
      await fetch("/api/notify-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: updated.id, currentParticipantEmail: nextParticipant.email, previousParticipantEmail: activeParticipant?.email }),
      });
    } catch (err) {
      console.error("Pass quill notify failed:", err);
    }
  };

  const handleReminder = async (e, p) => {
    e.stopPropagation();
    if (reminderSent.has(p.email)) return;
    setReminderSent(s => new Set([...s, p.email]));
    setReminderFeedback(s => new Set([...s, p.email]));
    setTimeout(() => setReminderFeedback(s => { const n = new Set(s); n.delete(p.email); return n; }), 2000);
    const lastEntry = story.entries[story.entries.length - 1];
    const previousParticipant = lastEntry
      ? story.participants.find(x => x.email === lastEntry.email) ?? null
      : null;
    try {
      await fetch("/api/notify-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: story.id, currentParticipantEmail: p.email, previousParticipantEmail: previousParticipant?.email }),
      });
    } catch (err) {
      console.error("Reminder failed:", err);
    }
  };

  const handleShareLink = async () => {
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const updated = { ...story, openInviteExpiresAt: expiresAt };
    await onUpdate(updated);
    navigator.clipboard.writeText(`${window.location.origin}/story/${story.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleMode = () => {
    const updated = { ...story, turnBased: !turnBased };
    setTurnBased(!turnBased);
    onUpdate(updated);
  };

  const storyText = story.entries.map(e => e.text).join("\n\n");

  return (
    <div style={styles.editorRoot} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {/* Sidebar overlay (mobile tap-to-close) */}
      {sidebarOpen && (
        <div
          style={styles.sidebarOverlay}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside style={{
        ...styles.sidebar,
        transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
      }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button style={styles.pillBtn} onClick={onBack}>← Stories</button>
          {isCreator && (
            <button style={styles.pillBtn} onClick={onEdit}>✎ Edit</button>
          )}
        </div>
        <h2 style={styles.sideTitle}>{story.title}</h2>
        {story.genre && <p style={styles.sideGenre}>{story.genre}</p>}

        <div style={styles.divider} />

        <p style={styles.sideLabel}>Mode</p>
        <div style={styles.toggleRow}>
          <span style={{ ...styles.toggleLabel, fontSize: 11, width: 62, textAlign: "right" }}>Free for All</span>
          <div
            style={{ ...styles.toggle, background: turnBased ? "#E07A5F" : "#3a3a3a", transform: "scale(0.85)", opacity: isCreator ? 1 : 0.4, cursor: isCreator ? "pointer" : "default", flexShrink: 0 }}
            onClick={isCreator ? toggleMode : undefined}
          >
            <div style={{ ...styles.toggleThumb, transform: turnBased ? "translateX(20px)" : "translateX(2px)" }} />
          </div>
          <span style={{ ...styles.toggleLabel, fontSize: 11 }}>Turn-Based</span>
        </div>

        <p style={{ ...styles.sideLabel, marginTop: 12 }}>Layout</p>
        <div style={styles.toggleRow}>
          <span style={{ ...styles.toggleLabel, fontSize: 11, width: 62, textAlign: "right" }}>Entries</span>
          <div
            style={{ ...styles.toggle, background: inlineMode ? "#E07A5F" : "#3a3a3a", transform: "scale(0.85)", flexShrink: 0 }}
            onClick={() => setInlineMode(m => !m)}
          >
            <div style={{ ...styles.toggleThumb, transform: inlineMode ? "translateX(20px)" : "translateX(2px)" }} />
          </div>
          <span style={{ ...styles.toggleLabel, fontSize: 11 }}>Book</span>
        </div>

        {turnBased && (
          <div style={styles.turnIndicator}>
            <span style={styles.sideLabel}>Current Turn</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <div style={{ ...styles.authorDot, background: currentTurnParticipant?.color }} />
              <span style={{ ...styles.toggleLabel, color: currentTurnParticipant?.color }}>
                {currentTurnParticipant?.name || currentTurnParticipant?.email}
              </span>
            </div>
          </div>
        )}

        <div style={styles.divider} />

        <p style={styles.sideLabel}>Writing as</p>
        {story.participants.map(p => (
          <div
            key={p.email}
            style={{
              ...styles.participantItem,
              background: activeParticipant?.email === p.email ? `rgba(${hexToRgb(p.color)},0.15)` : "transparent",
              borderLeft: `3px solid ${activeParticipant?.email === p.email ? p.color : "transparent"}`,
              cursor: "default",
            }}
          >
            <div style={{ ...styles.authorDot, background: p.color }} />
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              {reminderFeedback.has(p.email) ? (
                <div style={styles.reminderFeedback}>Reminder sent</div>
              ) : (
                <>
                  <div style={{ ...styles.participantName, color: activeParticipant?.email === p.email ? p.color : "#d4cdc0" }}>
                    {p.name || p.email}
                  </div>
                  {p.name && <div style={styles.participantEmail}>{p.email}</div>}
                </>
              )}
            </div>
            <button
              style={{
                ...styles.bellBtn,
                opacity: reminderSent.has(p.email) ? 0.25 : 0.6,
                cursor: reminderSent.has(p.email) ? "default" : "pointer",
              }}
              onClick={(e) => handleReminder(e, p)}
              disabled={reminderSent.has(p.email)}
              title="Send reminder"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            </button>
          </div>
        ))}

        {isCreator && (
          <>
            <div style={styles.divider} />
            <p style={styles.sideLabel}>Share Link</p>
            <button
              style={{
                ...styles.pillBtn,
                ...(copied ? { color: "#81B29A", border: "1px solid #81B29A" } : {}),
              }}
              onClick={handleShareLink}
            >
              {copied ? "Copied link!" : "Share Link"}
            </button>
            {story.openInviteExpiresAt && new Date(story.openInviteExpiresAt) > new Date() && (
              <p style={{ fontSize: 11, color: "#555", margin: "4px 0 0" }}>
                Active for 2 days from last share
              </p>
            )}
          </>
        )}

        <div style={styles.divider} />
        <p style={styles.sideLabel}>Stats</p>
        <p style={styles.stat}>{story.entries.length} contributions</p>
        <p style={styles.stat}>{storyText.split(/\s+/).filter(Boolean).length} words</p>
      </aside>

      {/* Main canvas */}
      <main style={styles.canvas}>
        {/* Top bar with sidebar toggle */}
        <div style={{ ...styles.canvasTopBar, opacity: showTopBar ? 1 : 0, pointerEvents: showTopBar ? "auto" : "none", transition: "opacity 0.2s" }}>
          <button
            style={styles.sidebarToggleBtn}
            onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? "Hide panel" : "Show panel"}
          >
            <span style={styles.dotDot}>⋯</span>
          </button>
        </div>

        {/* Story scroll */}
        <div
          ref={(el) => {
            scrollRef.current = el;
            if (el) {
              const canScroll = el.scrollHeight > el.clientHeight;
              setShowTopBar(!canScroll || el.scrollTop === 0);
            }
          }}
          className="story-scroll"
          style={styles.storyScroll}
          onScroll={(e) => {
            const el = e.currentTarget;
            const current = el.scrollTop;
            if (current === 0) setShowTopBar(true);
            else if (current < lastScrollY.current - 5) setShowTopBar(true);
            else if (current > lastScrollY.current + 5) setShowTopBar(false);
            lastScrollY.current = current;
          }}
        >
          {story.entries.length === 0 && (
            <p style={styles.placeholder}>The page is blank. Begin the story…</p>
          )}
          {inlineMode ? (
            <p style={{ ...styles.entryText, margin: 0 }}>
              {story.entries.map((entry, i) => {
                const authorChanged = i > 0 && story.entries[i - 1].email !== entry.email;
                return (
                  <span key={entry.id}>
                    {authorChanged && (
                      <span style={{
                        display: "inline-block", width: 7, height: 7, borderRadius: "50%",
                        background: entry.color, margin: "0 8px", verticalAlign: "middle",
                      }} />
                    )}
                    <span style={{ whiteSpace: "pre-wrap" }}>{entry.text}</span>{" "}
                  </span>
                );
              })}
            </p>
          ) : (
            story.entries.map((entry) => (
              <EntryBlock key={entry.id} entry={entry} />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* ── Write area — always visible ── */}
        <div style={styles.writeArea}>
<div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, overflow: "hidden" }}>
              {story.participants.map(p => {
                const isTurn = turnBased
                  ? p.email === currentTurnParticipant?.email
                  : p.email === activeParticipant?.email;
                return isTurn ? (
                  <div
                    key={p.email}
                    style={{
                      ...styles.authorBadge,
                      background: `rgba(${hexToRgb(p.color)},0.2)`,
                      borderColor: p.color,
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ ...styles.authorDot, background: p.color }} />
                    <span style={{ color: p.color, fontSize: 12 }}>{p.name || p.email}</span>
                  </div>
                ) : (
                  <div
                    key={p.email}
                    title={p.name || p.email}
                    style={{ ...styles.authorDot, background: p.color, opacity: 0.4, flexShrink: 0 }}
                  />
                );
              })}
            </div>
            {/* 46px = 34px button + 12px gap, so "next writer" right-edge aligns with textarea right-edge */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                style={{ ...styles.passQuillBtn, opacity: !canWrite ? 0.4 : 1 }}
                onClick={() => setShowPassModal(true)}
                disabled={!canWrite}
                title="Pass the quill to the next writer"
              >
                next writer
              </button>
              <div style={{ width: 34, flexShrink: 0 }} />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <textarea
              style={{ ...styles.textarea, borderColor: activeParticipant?.color || "#444" }}
              placeholder={canWrite ? "Continue the story…" : "Wait for your turn…"}
              value={text}
              disabled={!canWrite}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit(); }}
            />
            <button
              style={{
                flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
                background: activeParticipant?.color || "#E07A5F",
                border: "none", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                opacity: (!canWrite || !text.trim()) ? 0.35 : 1,
                transition: "opacity 0.15s",
                fontSize: 16, color: "#fff",
              }}
              onClick={handleSubmit}
              disabled={!canWrite || !text.trim()}
              title="Add to Story (⌘↵)"
            >
              ↑
            </button>
          </div>
        </div>
      </main>

      {showPassModal && (() => {
        const nextIndex = (story.currentTurnIndex + 1) % story.participants.length;
        const next = story.participants[nextIndex];
        return (
          <div style={styles.modalOverlay}>
            <div style={styles.modal}>
              <h3 style={styles.modalTitle}>Pass the Quill?</h3>
              <p style={styles.modalBody}>
                This will end your turn and pass the quill to{" "}
                <strong style={{ color: next?.color }}>{next?.name || next?.email}</strong>.
                They'll receive an email letting them know it's their turn to write.
              </p>
              <div style={styles.modalActions}>
                <button style={styles.btnSecondary} onClick={() => setShowPassModal(false)}>Cancel</button>
                <button style={styles.btnPrimary} onClick={handlePassQuill}>Pass the Quill →</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function EntryBlock({ entry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const [showTime, setShowTime] = useState(false);
  const touchStartX = useRef(null);

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta < -40) setShowTime(true);
    else if (delta > 40) setShowTime(false);
    touchStartX.current = null;
  };

  return (
    <div
      style={{ ...styles.entryBlock, borderLeft: `3px solid ${entry.color}`, position: "relative" }}
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <p style={{ ...styles.entryText, margin: 0 }}>{entry.text}</p>
      <span style={{ ...styles.entryTime, position: "absolute", top: 0, right: 0, opacity: showTime ? 1 : 0, transition: "opacity 0.15s" }}>{time}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════════════════
const styles = {
  root: {
    minHeight: "100vh",
    background: "#0f0e0d",
    color: "#e8e0d0",
    fontFamily: "'DM Sans', sans-serif",
    position: "relative",
  },
  grain: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")`,
    opacity: 0.5,
  },
  page: {
    maxWidth: 900, margin: "0 auto", padding: "40px 24px", position: "relative", zIndex: 1,
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 48,
  },
  logo: {
    fontFamily: "'Playfair Display', serif", fontSize: 42, fontWeight: 700,
    color: "#e8e0d0", margin: 0, letterSpacing: "-1px",
  },
  tagline: { margin: "4px 0 0", color: "#888", fontSize: 14, fontStyle: "italic" },
  muted: { color: "#666", fontStyle: "italic" },
  empty: { textAlign: "center", padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 },
  emptyIcon: { fontSize: 40, color: "#E07A5F" },
  emptyText: { color: "#888", fontSize: 16, fontStyle: "italic" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 20 },
  card: {
    background: "#1a1917", border: "1px solid #2a2825", borderRadius: 12, padding: 24,
    cursor: "pointer", transition: "all 0.2s", position: "relative",
  },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  cardMode: { fontSize: 11, color: "#E07A5F", textTransform: "uppercase", letterSpacing: 1, fontWeight: 500 },
  menuBtn: {
    background: "none", border: "1px solid transparent", borderRadius: 6,
    color: "#666", cursor: "pointer", fontSize: 18, padding: "2px 8px",
    letterSpacing: 2, lineHeight: 1, transition: "all 0.15s",
  },
  menuBackdrop: {
    position: "fixed", inset: 0, zIndex: 50,
  },
  dropdown: {
    position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 51,
    background: "#1e1c1a", border: "1px solid #2a2825", borderRadius: 10,
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)", minWidth: 140, overflow: "hidden",
  },
  dropdownItem: {
    display: "flex", alignItems: "center", gap: 10, width: "100%",
    background: "none", border: "none", color: "#d4cdc0", cursor: "pointer",
    padding: "11px 16px", fontSize: 14, fontFamily: "'DM Sans', sans-serif",
    textAlign: "left", transition: "background 0.12s",
  },
  dropdownIcon: { fontSize: 14, opacity: 0.7 },
  dropdownDivider: { height: 1, background: "#2a2825", margin: "0 12px" },
  // Modal
  modalOverlay: {
    position: "fixed", inset: 0, zIndex: 100,
    background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
  },
  modal: {
    background: "#1a1917", border: "1px solid #2a2825", borderRadius: 14,
    padding: "32px 28px", maxWidth: 400, width: "100%",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
  },
  modalTitle: {
    fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700,
    color: "#e8e0d0", margin: "0 0 12px",
  },
  modalBody: { fontSize: 14, color: "#888", lineHeight: 1.6, margin: "0 0 24px" },
  modalActions: { display: "flex", gap: 10, justifyContent: "flex-end" },
  cardTitle: {
    fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700,
    color: "#e8e0d0", margin: "0 0 8px",
  },
  cardPreview: { fontSize: 13, color: "#888", lineHeight: 1.6, margin: "0 0 16px" },
  cardAuthors: { display: "flex", gap: 6 },
  authorDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },

  // CREATE
  createWrap: { maxWidth: 560, margin: "0 auto" },
  createTitle: {
    fontFamily: "'Playfair Display', serif", fontSize: 32, fontWeight: 700,
    color: "#e8e0d0", marginBottom: 32,
  },
  label: { display: "block", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "#888", marginBottom: 8 },
  optional: { color: "#555", textTransform: "none", letterSpacing: 0 },
  input: {
    width: "100%", background: "#1a1917", border: "1px solid #2a2825", borderRadius: 8,
    color: "#e8e0d0", padding: "12px 14px", fontSize: 14, marginBottom: 20, boxSizing: "border-box",
    fontFamily: "'DM Sans', sans-serif", outline: "none",
  },
  toggleRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
  toggleLabel: { fontSize: 13, color: "#aaa" },
  toggle: {
    width: 44, height: 24, borderRadius: 12, cursor: "pointer",
    position: "relative", transition: "background 0.2s", flexShrink: 0,
  },
  toggleThumb: {
    position: "absolute", top: 2, width: 20, height: 20, borderRadius: "50%",
    background: "#fff", transition: "transform 0.2s",
  },
  participantList: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 8 },
  participantRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  colorPickerWrap: { display: "flex", gap: 5, flexWrap: "wrap" },
  colorSwatch: { width: 18, height: 18, borderRadius: "50%", cursor: "pointer" },
  removeBtn: { background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 16 },
  errorText: { color: "#E07A5F", fontSize: 13, margin: "8px 0 0" },
  inviteRow: { display: "flex", alignItems: "center", gap: 8, paddingLeft: 4 },
  inviteBtn: {
    background: "none", border: "1px solid #2a2825", borderRadius: 6,
    color: "#888", cursor: "pointer", fontSize: 12, padding: "5px 12px",
    fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
  },
  inviteBtnSent: { color: "#81B29A", border: "1px solid #81B29A" },
  newBadge: {
    fontSize: 10, textTransform: "uppercase", letterSpacing: 1,
    color: "#E07A5F", background: "rgba(224,122,95,0.12)",
    padding: "2px 7px", borderRadius: 10,
  },

  // EDITOR
  editorRoot: {
    display: "flex", height: "100vh", position: "relative", zIndex: 1, overflow: "hidden",
  },
  sidebarOverlay: {
    position: "fixed", inset: 0, zIndex: 9, background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(2px)",
    cursor: "pointer",
  },
  sidebar: {
    position: "fixed", top: 0, left: 0, height: "100vh", zIndex: 11,
    width: 260, flexShrink: 0, background: "#131210", borderRight: "1px solid #2a2825",
    padding: "20px 16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8,
    transition: "transform 0.35s cubic-bezier(0.4,0,0.2,1)",
    boxShadow: "6px 0 32px rgba(0,0,0,0.6)",
  },
  canvasTopBar: {
    display: "flex", alignItems: "center", padding: "14px 20px 0",
    flexShrink: 0,
  },
  sidebarToggleBtn: {
    background: "#1a1917", border: "1px solid #2a2825", borderRadius: 10,
    color: "#888", cursor: "pointer", width: 38, height: 38,
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "all 0.15s", flexShrink: 0,
    fontSize: 18, letterSpacing: 2,
  },
  dotDot: { fontSize: 16, letterSpacing: 2, lineHeight: 1, marginTop: -2 },
  sideTitle: {
    fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700,
    color: "#e8e0d0", margin: "8px 0 2px",
  },
  sideGenre: { fontSize: 12, color: "#888", fontStyle: "italic", margin: 0 },
  sideLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#555", marginBottom: 4 },
  divider: { height: 1, background: "#1f1e1c", margin: "8px 0" },
  turnIndicator: { background: "#1a1917", borderRadius: 8, padding: 10, marginTop: 4 },
  participantItem: {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
    borderRadius: 8, cursor: "pointer", transition: "all 0.15s",
  },
  participantName: { fontSize: 13, fontWeight: 500, transition: "color 0.15s" },
  participantEmail: { fontSize: 11, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  bellBtn: {
    background: "none", border: "none", color: "#aaa", padding: "2px 4px",
    display: "flex", alignItems: "center", flexShrink: 0, transition: "opacity 0.15s",
  },
  reminderFeedback: {
    fontSize: 12, color: "#81B29A", fontStyle: "italic",
  },
  passQuillBtn: {
    background: "none", border: "1px solid #3a3a3a", borderRadius: 20,
    color: "#aaa", cursor: "pointer", fontSize: 12, padding: "4px 10px",
    fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
  },
  stat: { fontSize: 12, color: "#666", margin: "2px 0" },

  canvas: {
    flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", width: "100%",
  },
  storyScroll: {
    flex: 1, overflowY: "auto", padding: "40px 20px", maxWidth: 720, width: "100%", margin: "0 auto",
    scrollbarWidth: "thin", scrollbarColor: "#333 transparent",
  },
  placeholder: { color: "#555", fontStyle: "italic", textAlign: "center", marginTop: 60 },
  entryBlock: { marginBottom: 0, paddingLeft: 10 },
  entryMeta: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  entryAuthor: { fontSize: 12, fontWeight: 500 },
  entryTime: { fontSize: 11, color: "#555", marginLeft: "auto" },
  entryText: {
    fontFamily: "'Playfair Display', serif", fontSize: 16, lineHeight: 1.75,
    color: "#d4cdc0", margin: 0, padding: "2px 0", whiteSpace: "pre-wrap",
  },

  writeArea: {
    borderTop: "1px solid #1f1e1c", padding: "16px 32px 20px", background: "#0f0e0d",
    maxWidth: 720, width: "100%", margin: "0 auto", boxSizing: "border-box", flexShrink: 0,
  },
  notYourTurn: {
    background: "#1a1917", border: "1px solid #2a2825", borderRadius: 8,
    padding: "10px 14px", fontSize: 13, color: "#888", marginBottom: 12,
  },
  authorBadge: {
    display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12,
    border: "1px solid", borderRadius: 20, padding: "4px 10px",
  },
  textarea: {
    width: "100%", background: "#1a1917", border: "1px solid",
    borderRadius: 10, color: "#e8e0d0", padding: "14px 16px", fontSize: 15,
    fontFamily: "'Playfair Display', serif", lineHeight: 1.7, resize: "none",
    minHeight: 100, boxSizing: "border-box", outline: "none",
  },
  writeActions: {
    display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 10,
  },
  // Shared buttons
  btnPrimary: {
    background: "#E07A5F", color: "#fff", border: "none", borderRadius: 8,
    padding: "10px 20px", cursor: "pointer", fontSize: 14, fontWeight: 500,
    fontFamily: "'DM Sans', sans-serif",
  },
  btnSecondary: {
    background: "#1a1917", color: "#aaa", border: "1px solid #2a2825", borderRadius: 8,
    padding: "10px 20px", cursor: "pointer", fontSize: 14,
    fontFamily: "'DM Sans', sans-serif",
  },
  backBtn: {
    background: "none", border: "none", color: "#888", cursor: "pointer",
    fontSize: 13, padding: 0, marginBottom: 16,
  },
  pillBtn: {
    background: "none", border: "1px solid #3a3835", color: "#aaa", cursor: "pointer",
    fontSize: 12, padding: "5px 12px", borderRadius: 999,
    fontFamily: "'DM Sans', sans-serif", transition: "border-color 0.15s, color 0.15s",
  },
};
