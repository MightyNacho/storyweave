'use client';
import { useState, useEffect, useRef } from "react";



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

// ── Storage helpers ────────────────────────────────────────────────────────
const STORAGE_KEY = "collab_stories_v1";
const loadStories = async () => {
  try {
    const res = await window.storage.get(STORAGE_KEY);
    return res ? JSON.parse(res.value) : [];
  } catch { return []; }
};
const saveStories = async (stories) => {
  try { await window.storage.set(STORAGE_KEY, JSON.stringify(stories)); } catch {}
};

// ── Email invite helper ────────────────────────────────────────────────────
// Calls /api/invite when running in your Next.js app.
// In Claude.ai this will silently do nothing (no backend available).
const sendInvites = async (story, participants) => {
  const res = await fetch("/api/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ story, participants }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
};

// ── Dan Harmon's Story Circle stages ─────────────────────────────────────
// 1. You (establish who the character is in their comfort zone)
// 2. Need (something is lacking; desire or discomfort emerges)
// 3. Go (character crosses a threshold into the unfamiliar)
// 4. Search (adapting, struggling, seeking in the unfamiliar world)
// 5. Find (they find what they were looking for — but at a cost)
// 6. Take (they take it; the price is paid, something changes)
// 7. Return (the character returns to the familiar world, changed)
// 8. Change (they are fundamentally different; a new equilibrium)

const STORY_CIRCLE_STAGES = [
  { num: 1, name: "You",    hint: "Who are we with? What is their ordinary world?" },
  { num: 2, name: "Need",   hint: "What do they want or lack? What disrupts the comfort?" },
  { num: 3, name: "Go",     hint: "They cross a threshold. Something begins." },
  { num: 4, name: "Search", hint: "They struggle, adapt, or seek in unfamiliar territory." },
  { num: 5, name: "Find",   hint: "Something is found — but it costs more than expected." },
  { num: 6, name: "Take",   hint: "They take what they found. A price is paid." },
  { num: 7, name: "Return", hint: "They begin the journey back. Something has shifted." },
  { num: 8, name: "Change", hint: "Who are they now? The circle closes — but differently." },
];

// ── AI suggestion via Claude API ──────────────────────────────────────────
const getAISuggestion = async (storyText, entries) => {
  const wordCount = storyText.split(/\s+/).filter(Boolean).length;
  const entryCount = entries.length;

  // Estimate where we are in the story circle based on progress
  // We use entry count as a rough proxy; every ~2-3 entries = one stage
  const stageIndex = Math.min(
    Math.floor(entryCount / 2),
    STORY_CIRCLE_STAGES.length - 1
  );
  const currentStage = STORY_CIRCLE_STAGES[stageIndex];
  const nextStage = STORY_CIRCLE_STAGES[Math.min(stageIndex + 1, 7)];

  const snippet = storyText.slice(-600);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `You are a subtle story compass using Dan Harmon's Story Circle framework. A group is collaboratively writing a story.

Based on the story so far, the narrative appears to be in or approaching Stage ${currentStage.num} ("${currentStage.name}") of the Story Circle.

Stage ${currentStage.num} — ${currentStage.name}: ${currentStage.hint}
Next stage to move toward — Stage ${nextStage.num} — ${nextStage.name}: ${nextStage.hint}

Your job: Give ONE very short, vague, poetic nudge (1-2 sentences MAX) that hints at a direction without telling them what to write. Be evocative, not prescriptive. Do NOT mention the Story Circle, stages, or theory. Do NOT write any story content. Just a gentle whisper of direction — like a muse, not an instructor.

STORY SO FAR:
${snippet || "(Story is just beginning.)"}

Nudge:`
      }]
    })
  });
  const data = await response.json();
  const text = data.content?.map(b => b.text || "").join("").trim() || "";
  return { text, stage: currentStage };
};

// ── AI Analysis agent via Claude API ─────────────────────────────────────
// A second agent — the Analyst — reads the whole story and gives concrete
// structural feedback based on where the Story Circle says things should be.
const getAIAnalysis = async (storyText, entries) => {
  const stageIndex = Math.min(Math.floor((entries.length || 0) / 2), STORY_CIRCLE_STAGES.length - 1);
  const currentStage = STORY_CIRCLE_STAGES[stageIndex];
  const wordCount = storyText.split(/\s+/).filter(Boolean).length;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `You are a thoughtful story editor and structural analyst. A group of collaborators is writing a story together. Analyse what they have written so far using Dan Harmon's Story Circle as your framework.

The story is currently in Stage ${currentStage.num}: "${currentStage.name}" — ${currentStage.hint}
Word count so far: ${wordCount}

Give exactly 2 or 3 short, specific, actionable observations. Each one should:
- Be 1–2 sentences maximum
- Name something concrete that is missing, underdeveloped, or working well
- Be written warmly, like a supportive editor — not a critic
- Reference the story content specifically where possible

Do NOT mention "Story Circle", "stages", "Dan Harmon", or any structural theory by name.
Do NOT write a preamble or explanation — just the observations, each on its own line, starting with a symbol: ◈

STORY SO FAR:
${storyText.slice(-1200) || "(The story has not yet begun.)"}`
      }]
    })
  });
  const data = await response.json();
  const raw = data.content?.map(b => b.text || "").join("").trim() || "";
  const points = raw.split("\n").map(l => l.replace(/^◈\s*/, "").trim()).filter(Boolean);
  return { points, stage: currentStage };
};
export default function App() {
  const [view, setView] = useState("dashboard"); // dashboard | create | edit | story
  const [stories, setStories] = useState([]);
  const [activeStory, setActiveStory] = useState(null);
  const [editingStory, setEditingStory] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStories().then(s => { setStories(s); setLoading(false); });
  }, []);

  const persistStories = (updated) => {
    setStories(updated);
    saveStories(updated);
  };

  const openStory = (story) => { setActiveStory(story); setView("story"); };
  const goHome = () => { setView("dashboard"); setActiveStory(null); setEditingStory(null); };

  const updateActiveStory = (updated) => {
    setActiveStory(updated);
    const all = stories.map(s => s.id === updated.id ? updated : s);
    persistStories(all);
  };

  const createStory = (newStory) => {
    const all = [newStory, ...stories];
    persistStories(all);
    setActiveStory(newStory);
    setView("story");
  };

  const deleteStory = (id) => {
    const all = stories.filter(s => s.id !== id);
    persistStories(all);
  };

  const startEdit = (story) => { setEditingStory(story); setView("edit"); };

  const saveEdit = (updated) => {
    const all = stories.map(s => s.id === updated.id ? updated : s);
    persistStories(all);
    goHome();
  };

  return (
    <div style={styles.root}>
      <div style={styles.grain} />
      {view === "dashboard" && (
        <Dashboard
          stories={stories}
          loading={loading}
          onOpen={openStory}
          onDelete={deleteStory}
          onEdit={startEdit}
          onCreate={() => setView("create")}
        />
      )}
      {view === "create" && (
        <CreateStory onCancel={goHome} onCreate={createStory} />
      )}
      {view === "edit" && editingStory && (
        <EditStory story={editingStory} onCancel={goHome} onSave={saveEdit} />
      )}
      {view === "story" && activeStory && (
        <StoryEditor
          story={activeStory}
          onBack={goHome}
          onUpdate={updateActiveStory}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════
function Dashboard({ stories, loading, onOpen, onDelete, onEdit, onCreate }) {
  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.logo}>Story Weave</h1>
          <p style={styles.tagline}>Collaborative storytelling, one paragraph at a time.</p>
        </div>
        <button style={styles.btnPrimary} onClick={onCreate}>+ New Story</button>
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
            <StoryCard key={s.id} story={s} onOpen={onOpen} onDelete={onDelete} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function StoryCard({ story, onOpen, onDelete, onEdit }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
                  <button style={styles.dropdownItem} onClick={handleEdit}>
                    <span style={styles.dropdownIcon}>✎</span> Edit
                  </button>
                  <div style={styles.dropdownDivider} />
                  <button style={{ ...styles.dropdownItem, color: "#BC4749" }} onClick={handleDelete}>
                    <span style={styles.dropdownIcon}>⌫</span> Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <h2 style={styles.cardTitle}>{story.title}</h2>
        <p style={styles.cardPreview}>{preview || "No entries yet…"}</p>
        <div style={styles.cardAuthors}>
          {story.participants.slice(0, 5).map(p => (
            <div
              key={p.email}
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
// CREATE STORY
// ══════════════════════════════════════════════════════════════════════════
function CreateStory({ onCancel, onCreate }) {
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [turnBased, setTurnBased] = useState(false);
  const [participants, setParticipants] = useState([
    { name: "", email: "", color: PRESET_COLORS[0] }
  ]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

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
    setParticipants(participants.filter((_, idx) => idx !== i));
  };

  const handleCreate = async () => {
    if (!title.trim()) return setError("Please give your story a title.");
    const validP = participants.filter(p => p.email.trim() || p.name.trim());
    if (validP.length === 0) return setError("Add at least one participant.");
    for (const p of validP) {
      if (!p.name.trim()) return setError("Every participant needs a name.");
      if (!p.email.includes("@")) return setError(`"${p.email}" doesn't look like a valid email.`);
    }
    const story = {
      id: Date.now().toString(),
      title: title.trim(),
      genre: genre.trim(),
      turnBased,
      participants: validP,
      entries: [],
      currentTurnIndex: 0,
      createdAt: new Date().toISOString(),
    };
    setSending(true);
    await sendInvites(story, validP);
    setSending(false);
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

        <label style={styles.label}>Participants</label>
        <div style={styles.participantList}>
          {participants.map((p, i) => (
            <div key={i} style={styles.participantRow}>
              <input
                style={{ ...styles.input, flex: "0 0 130px", marginBottom: 0 }}
                placeholder="Name"
                value={p.name}
                onChange={e => updateParticipant(i, "name", e.target.value)}
              />
              <input
                style={{ ...styles.input, flex: 1, marginBottom: 0 }}
                placeholder={`email@example.com`}
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
          ))}
          <button style={styles.btnSecondary} onClick={addParticipant}>+ Add Participant</button>
        </div>

        {error && <p style={styles.errorText}>{error}</p>}

        <button
          style={{ ...styles.btnPrimary, width: "100%", marginTop: 24, opacity: sending ? 0.7 : 1 }}
          onClick={handleCreate}
          disabled={sending}
        >
          {sending ? "Sending invites…" : "Start Writing →"}
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
  const [error, setError] = useState("");
  const [inviteStatus, setInviteStatus] = useState({}); // { email: "sending"|"sent"|"error" }

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
      await sendInvites(story, [p]);
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
      participants: validP,
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

        {error && <p style={styles.errorText}>{error}</p>}

        <button style={{ ...styles.btnPrimary, width: "100%", marginTop: 24 }} onClick={handleSave}>
          Save Changes →
        </button>
      </div>
    </div>
  );
}
function StoryEditor({ story, onBack, onUpdate }) {
  const [text, setText] = useState("");
  const [activePEmail, setActivePEmail] = useState(story.participants[0]?.email || "");
  const [aiSuggestion, setAiSuggestion] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiError, setAiError] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  // Panel: null | "muse" | "analysis"
  const [openPanel, setOpenPanel] = useState(null);
  // Lock both buttons after use — reset when a new entry is submitted
  const [musedThisCycle, setMusedThisCycle] = useState(false);
  const [analysedThisCycle, setAnalysedThisCycle] = useState(false);
  const [turnBased, setTurnBased] = useState(story.turnBased);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const bottomRef = useRef(null);

  const activeParticipant = story.participants.find(p => p.email === activePEmail) || story.participants[0];
  const currentTurnParticipant = story.participants[story.currentTurnIndex % story.participants.length];

  const canWrite = !turnBased || activeParticipant?.email === currentTurnParticipant?.email;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
      currentTurnIndex: story.currentTurnIndex + 1,
    };
    onUpdate(updated);
    setText("");
    setAiSuggestion(null);
    setAnalysis(null);
    setOpenPanel(null);
    setMusedThisCycle(false);
    setAnalysedThisCycle(false);
    setAiError("");
    setAnalysisError("");
  };

  const handleAISuggest = async () => {
    if (musedThisCycle) return;
    const fullText = story.entries.map(e => e.text).join("\n\n");
    if (!fullText && !text) { setAiError("Write or add something first to get a suggestion."); return; }
    setLoadingAI(true); setAiError(""); setAiSuggestion(null);
    setOpenPanel("muse");
    try {
      const result = await getAISuggestion(fullText + (text ? "\n\n" + text : ""), story.entries);
      setAiSuggestion(result);
      setMusedThisCycle(true);
    } catch (e) {
      setAiError("The Muse is silent. Please try again.");
    } finally { setLoadingAI(false); }
  };

  const handleAnalyse = async () => {
    if (analysedThisCycle) return;
    const fullText = story.entries.map(e => e.text).join("\n\n");
    if (!fullText) { setAnalysisError("Add at least one entry before analysing."); setOpenPanel("analysis"); return; }
    setLoadingAnalysis(true); setAnalysisError(""); setAnalysis(null);
    setOpenPanel("analysis");
    try {
      const result = await getAIAnalysis(fullText, story.entries);
      setAnalysis(result);
      setAnalysedThisCycle(true);
    } catch (e) {
      setAnalysisError("Couldn't reach the analyst. Please try again.");
    } finally { setLoadingAnalysis(false); }
  };

  const closePanel = () => setOpenPanel(null);

  const toggleMode = () => {
    const updated = { ...story, turnBased: !turnBased };
    setTurnBased(!turnBased);
    onUpdate(updated);
  };

  const storyText = story.entries.map(e => e.text).join("\n\n");

  return (
    <div style={styles.editorRoot}>
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
        <button style={styles.backBtn} onClick={onBack}>← Stories</button>
        <h2 style={styles.sideTitle}>{story.title}</h2>
        {story.genre && <p style={styles.sideGenre}>{story.genre}</p>}

        <div style={styles.divider} />

        <p style={styles.sideLabel}>Mode</p>
        <div style={styles.toggleRow}>
          <span style={{ ...styles.toggleLabel, fontSize: 11 }}>Free for All</span>
          <div
            style={{ ...styles.toggle, background: turnBased ? "#E07A5F" : "#3a3a3a", transform: "scale(0.85)" }}
            onClick={toggleMode}
          >
            <div style={{ ...styles.toggleThumb, transform: turnBased ? "translateX(20px)" : "translateX(2px)" }} />
          </div>
          <span style={{ ...styles.toggleLabel, fontSize: 11 }}>Turn-Based</span>
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
              background: activePEmail === p.email ? `rgba(${hexToRgb(p.color)},0.15)` : "transparent",
              borderLeft: `3px solid ${activePEmail === p.email ? p.color : "transparent"}`,
            }}
            onClick={() => setActivePEmail(p.email)}
          >
            <div style={{ ...styles.authorDot, background: p.color }} />
            <div>
              <div style={{ ...styles.participantName, color: activePEmail === p.email ? p.color : "#d4cdc0" }}>
                {p.name || p.email}
              </div>
              {p.name && <div style={styles.participantEmail}>{p.email}</div>}
            </div>
          </div>
        ))}

        <div style={styles.divider} />
        <p style={styles.sideLabel}>Stats</p>
        <p style={styles.stat}>{story.entries.length} contributions</p>
        <p style={styles.stat}>{storyText.split(/\s+/).filter(Boolean).length} words</p>
      </aside>

      {/* Main canvas */}
      <main style={styles.canvas}>
        {/* Top bar with sidebar toggle */}
        <div style={styles.canvasTopBar}>
          <button
            style={styles.sidebarToggleBtn}
            onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? "Hide panel" : "Show panel"}
          >
            <span style={styles.dotDot}>⋯</span>
          </button>
        </div>

        {/* Story scroll */}
        <div style={styles.storyScroll}>
          {story.entries.length === 0 && (
            <p style={styles.placeholder}>The page is blank. Begin the story…</p>
          )}
          {story.entries.map((entry, i) => (
            <EntryBlock key={entry.id} entry={entry} index={i} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* ── Slide-up AI panel — sits between scroll and write area ── */}
        <div style={{
          ...styles.aiPanel,
          maxHeight: openPanel ? 320 : 0,
          opacity: openPanel ? 1 : 0,
          borderTopWidth: openPanel ? 1 : 0,
        }}>
          {openPanel === "muse" && (
            <div style={styles.aiPanelInner}>
              <div style={styles.aiPanelHeader}>
                <span style={styles.aiPanelLabel}>✦ The Muse</span>
                <button style={styles.aiPanelClose} onClick={closePanel}>✕</button>
              </div>
              {loadingAI && <p style={styles.aiPanelLoading}>Listening to the story…</p>}
              {aiError && <p style={styles.aiPanelError}>{aiError}</p>}
              {aiSuggestion && (
                <>
                  <div style={styles.stageChip}>
                    Stage {aiSuggestion.stage.num} · {aiSuggestion.stage.name}
                  </div>
                  <p style={styles.museText}>"{aiSuggestion.text}"</p>
                </>
              )}
            </div>
          )}
          {openPanel === "analysis" && (
            <div style={styles.aiPanelInner}>
              <div style={styles.aiPanelHeader}>
                <span style={{ ...styles.aiPanelLabel, color: "#81B29A" }}>◈ Story Analysis</span>
                <button style={styles.aiPanelClose} onClick={closePanel}>✕</button>
              </div>
              {loadingAnalysis && <p style={styles.aiPanelLoading}>Reading the story…</p>}
              {analysisError && <p style={styles.aiPanelError}>{analysisError}</p>}
              {analysis && (
                <>
                  <div style={{ ...styles.stageChip, background: "rgba(129,178,154,0.12)", color: "#81B29A" }}>
                    Stage {analysis.stage.num} · {analysis.stage.name}
                  </div>
                  <ul style={styles.analysisList}>
                    {analysis.points.map((point, i) => (
                      <li key={i} style={styles.analysisItem}>
                        <span style={styles.analysisBullet}>◈</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Write area — always visible ── */}
        <div style={styles.writeArea}>
          {turnBased && !canWrite && (
            <div style={styles.notYourTurn}>
              It's <span style={{ color: currentTurnParticipant?.color }}>{currentTurnParticipant?.name || currentTurnParticipant?.email}</span>'s turn to write.
            </div>
          )}

          <div style={{ ...styles.authorBadge, background: `rgba(${hexToRgb(activeParticipant?.color || "#888")},0.2)`, borderColor: activeParticipant?.color }}>
            <div style={{ ...styles.authorDot, background: activeParticipant?.color }} />
            {activeParticipant?.name || activeParticipant?.email}
          </div>

          <textarea
            style={{ ...styles.textarea, borderColor: activeParticipant?.color || "#444" }}
            placeholder={canWrite ? "Continue the story…" : "Wait for your turn…"}
            value={text}
            disabled={!canWrite}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit(); }}
          />

          {/* Action row: Muse | Analyse | Add to Story */}
          <div style={styles.writeActions}>
            <div style={styles.aiButtons}>
              {/* Muse button — temporarily disabled */}
              <span title="Coming soon" style={{ display: "inline-block", cursor: "not-allowed" }}>
                <button
                  style={{
                    ...styles.aiBtn,
                    ...styles.aiBtnMuse,
                    opacity: 0.35,
                    pointerEvents: "none",
                  }}
                  disabled
                >
                  <span style={styles.aiBtnIcon}>✦</span>
                  <span>Muse</span>
                </button>
              </span>

              {/* Analyse button — temporarily disabled */}
              <span title="Coming soon" style={{ display: "inline-block", cursor: "not-allowed" }}>
                <button
                  style={{
                    ...styles.aiBtn,
                    ...styles.aiBtnAnalyse,
                    opacity: 0.35,
                    pointerEvents: "none",
                  }}
                  disabled
                >
                  <span style={styles.aiBtnIcon}>◈</span>
                  <span>Analyse</span>
                </button>
              </span>
            </div>

            <button
              style={{ ...styles.btnPrimary, opacity: (!canWrite || !text.trim()) ? 0.4 : 1 }}
              onClick={handleSubmit}
              disabled={!canWrite || !text.trim()}
            >
              Add to Story ⌘↵
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function EntryBlock({ entry, index }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div style={{ ...styles.entryBlock, borderLeft: `3px solid ${entry.color}` }}>
      <div style={styles.entryMeta}>
        <div style={{ ...styles.authorDot, background: entry.color }} />
        <span style={{ ...styles.entryAuthor, color: entry.color }}>{entry.author}</span>
        <span style={styles.entryTime}>{time}</span>
      </div>
      <p style={styles.entryText}>{entry.text}</p>
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
  stat: { fontSize: 12, color: "#666", margin: "2px 0" },

  canvas: {
    flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", width: "100%",
  },
  storyScroll: {
    flex: 1, overflowY: "auto", padding: "40px 48px", maxWidth: 720, width: "100%", margin: "0 auto",
  },
  placeholder: { color: "#555", fontStyle: "italic", textAlign: "center", marginTop: 60 },
  entryBlock: { marginBottom: 32, paddingLeft: 16 },
  entryMeta: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  entryAuthor: { fontSize: 12, fontWeight: 500 },
  entryTime: { fontSize: 11, color: "#555", marginLeft: "auto" },
  entryText: {
    fontFamily: "'Playfair Display', serif", fontSize: 17, lineHeight: 1.85,
    color: "#d4cdc0", margin: 0,
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
    border: "1px solid", borderRadius: 20, padding: "4px 10px", marginBottom: 10,
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
  aiButtons: { display: "flex", gap: 8 },
  aiBtn: {
    display: "flex", alignItems: "center", gap: 6,
    background: "#1a1917", border: "1px solid", borderRadius: 8,
    cursor: "pointer", fontSize: 13, padding: "8px 14px",
    fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
  },
  aiBtnMuse: { color: "#E07A5F" },
  aiBtnAnalyse: { color: "#81B29A" },
  aiBtnIcon: { fontSize: 12 },

  // Slide-up AI panel
  aiPanel: {
    borderTop: "1px solid #1f1e1c", borderTopStyle: "solid",
    background: "#111009", overflow: "hidden",
    transition: "max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease",
    maxWidth: 720, width: "100%", margin: "0 auto", boxSizing: "border-box",
    flexShrink: 0,
  },
  aiPanelInner: { padding: "16px 32px 20px", overflowY: "auto", maxHeight: 320 },
  aiPanelHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12,
  },
  aiPanelLabel: {
    fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5,
    color: "#E07A5F", fontWeight: 600,
  },
  aiPanelClose: {
    background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14,
  },
  aiPanelLoading: { color: "#555", fontSize: 13, fontStyle: "italic", margin: 0 },
  aiPanelError: { color: "#E07A5F", fontSize: 13, margin: 0 },
  stageChip: {
    display: "inline-block", fontSize: 10, textTransform: "uppercase",
    letterSpacing: 1.5, color: "#E07A5F", background: "rgba(224,122,95,0.12)",
    padding: "3px 10px", borderRadius: 20, marginBottom: 12,
  },
  museText: {
    fontFamily: "'Playfair Display', serif", fontSize: 16, lineHeight: 1.8,
    color: "#b8b0a0", margin: 0, fontStyle: "italic",
  },
  analysisList: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12 },
  analysisItem: {
    display: "flex", gap: 10, alignItems: "flex-start",
    fontSize: 14, color: "#c8c0b0", lineHeight: 1.6,
  },
  analysisBullet: { color: "#81B29A", flexShrink: 0, marginTop: 2, fontSize: 12 },

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
};
