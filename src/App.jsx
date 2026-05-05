import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

// ── Fonts ──────────────────────────────────────────────────────────────────
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500;600&display=swap";
document.head.appendChild(fontLink);

// ── Mode ───────────────────────────────────────────────────────────────────
const MODE = "solo"; // "solo" or "national"

// ── Matching Engine ────────────────────────────────────────────────────────
const ABO_COMPATIBLE = {
  O: ["O", "A", "B", "AB"],
  A: ["A", "AB"],
  B: ["B", "AB"],
  AB: ["AB"],
};

function calcAge(yearBorn) {
  if (!yearBorn) return null;
  return new Date().getFullYear() - parseInt(yearBorn);
}

function checkABO(donorBlood, recipientBlood) {
  return ABO_COMPATIBLE[donorBlood]?.includes(recipientBlood) ?? false;
}

function countHLAMismatches(donor, recipient) {
  let mismatches = 0;
  ["a", "b", "dr"].forEach((locus) => {
    const d = [donor[`donor_hla_${locus}1`], donor[`donor_hla_${locus}2`]].filter(Boolean);
    const r = [recipient[`recipient_hla_${locus}1`], recipient[`recipient_hla_${locus}2`]].filter(Boolean);
    if (d.length === 0) return;
    d.forEach((a) => { if (a && !r.includes(a)) mismatches++; });
  });
  return mismatches;
}

function calculateCompatibility(donor, recipient) {
  const aboOk = checkABO(donor.donor_blood_type, recipient.recipient_blood_type);
  const hlaMismatches = countHLAMismatches(donor, recipient);
  const highPRA = (recipient.recipient_pra_percent || 0) > 80;
  const sizeDiff = Math.abs((donor.donor_weight_kg || 70) - (recipient.recipient_weight_kg || 70));
  const sizeOk = sizeDiff < 40;
  const cmvRisk = donor.donor_cmv === "Positive" && recipient.recipient_cmv === "Negative";
  const donorAge = calcAge(donor.donor_year_born);
  const recipientAge = calcAge(recipient.recipient_year_born);
  const ageDiff = donorAge && recipientAge ? Math.abs(donorAge - recipientAge) : 0;
  const ageFlag = ageDiff > 15;
  const donorBMI = donor.donor_weight_kg && donor.donor_height_cm
    ? donor.donor_weight_kg / Math.pow(donor.donor_height_cm / 100, 2) : null;
  const bmiFlag = donorBMI && donorBMI > 35;

  const score = aboOk
    ? Math.max(0, 100
        - hlaMismatches * 10
        - (highPRA ? 20 : 0)
        - (sizeOk ? 0 : 10)
        - (cmvRisk ? 5 : 0)
        - (ageFlag ? 8 : 0)
        - (bmiFlag ? 5 : 0))
    : 0;

  const dataComplete = !!(donor.donor_hla_a1 || donor.donor_hla_notes);
  return {
    compatible: aboOk && hlaMismatches <= 4,
    score,
    partial: !dataComplete,
    reasons: { abo: aboOk, hlaMismatches, highSensitization: highPRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff },
  };
}

// ── Chain Detection ────────────────────────────────────────────────────────
function findChains(pairs) {
  const active = pairs.filter(p => p.status === "active");
  const chains = [];

  function dfs(path, visited) {
    if (path.length >= 2) {
      chains.push([...path]);
    }
    if (path.length >= 6) return;
    const last = path[path.length - 1];
    for (const candidate of active) {
      if (visited.has(candidate.id)) continue;
      const result = calculateCompatibility(last, candidate);
      if (result.compatible && result.score >= 60) {
        visited.add(candidate.id);
        path.push(candidate);
        dfs(path, visited);
        path.pop();
        visited.delete(candidate.id);
      }
    }
  }

  for (const pair of active) {
    const visited = new Set([pair.id]);
    dfs([pair], visited);
  }

  return chains
    .filter(c => c.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 20);
}

// ── Styling helpers ────────────────────────────────────────────────────────
function scoreStyle(score, partial) {
  if (partial && score === 0) return { bg: "#1e2530", text: "#5a6a7a", label: "Incomplete Data" };
  if (score >= 70) return { bg: "#0d6e4a", text: "#6effc6", label: "Compatible" };
  if (score >= 40) return { bg: "#6b4a00", text: "#ffd166", label: "Marginal" };
  return { bg: "#6e0d0d", text: "#ff8a8a", label: "Incompatible" };
}

const URGENCY_COLORS = { High: "#ff8a8a", Medium: "#ffd166", Low: "#6effc6" };
const URGENCY_DEFS = {
  High: "Needs transplant within weeks to months. Deteriorating on dialysis or medically urgent.",
  Medium: "Stable but needs transplant within the year. Standard priority.",
  Low: "Early evaluation or preemptive. Medically stable with longer window.",
};

// ── Empty form ─────────────────────────────────────────────────────────────
const emptyForm = {
  recipient_name: "", recipient_blood_type: "A", recipient_pra_percent: "",
  recipient_weight_kg: "", recipient_height_cm: "", recipient_year_born: "",
  recipient_hla_a1: "", recipient_hla_a2: "", recipient_hla_b1: "", recipient_hla_b2: "",
  recipient_hla_dr1: "", recipient_hla_dr2: "", recipient_hla_notes: "",
  recipient_cmv: "Unknown", recipient_dialysis_start: "", recipient_prior_transplants: "",
  recipient_sensitisation_notes: "", recipient_relationship: "",
  recipient_zip: "", recipient_crossmatch_virtual: "", recipient_crossmatch_physical: "",
  donor_name: "", donor_blood_type: "A", donor_weight_kg: "", donor_height_cm: "",
  donor_year_born: "", donor_hla_a1: "", donor_hla_a2: "", donor_hla_b1: "", donor_hla_b2: "",
  donor_hla_dr1: "", donor_hla_dr2: "", donor_hla_notes: "",
  donor_egfr: "", donor_cmv: "Unknown", donor_backup: false,
  urgency: "Medium", status: "active", notes: "",
  centre: "", altruistic: false, pair_type: "paired",
};

// ── CSV Template ───────────────────────────────────────────────────────────
function downloadTemplate() {
  const headers = [
    "recipient_name","recipient_dob","recipient_blood_type","recipient_pra_percent",
    "recipient_weight_kg","recipient_height_cm","recipient_year_born",
    "recipient_hla_a1","recipient_hla_a2","recipient_hla_b1","recipient_hla_b2",
    "recipient_hla_dr1","recipient_hla_dr2","recipient_hla_notes","recipient_cmv",
    "recipient_dialysis_start","recipient_prior_transplants","recipient_sensitisation_notes",
    "recipient_relationship","recipient_zip",
    "donor_name","donor_dob","donor_blood_type","donor_weight_kg","donor_height_cm",
    "donor_year_born","donor_hla_a1","donor_hla_a2","donor_hla_b1","donor_hla_b2",
    "donor_hla_dr1","donor_hla_dr2","donor_hla_notes","donor_egfr","donor_cmv",
    "urgency","notes","centre","pair_type"
  ];
  const example = [
    "Jane Smith","01/15/1978","A","25","65","163","1978",
    "A2","A24","B7","B44","DR4","DR7","","Negative",
    "2022-03-01","0","","Spouse","94109",
    "John Smith","03/22/1976","B","78","180","1976",
    "A1","A3","B8","B35","DR3","DR11","","90","Negative",
    "Medium","","Sutter CPMC","paired"
  ];
  const csv = [headers.join(","), example.join(",")].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "pairpath_upload_template.csv"; a.click();
}

function exportRegistry(pairs) {
  if (!pairs.length) return;
  const keys = Object.keys(pairs[0]).filter(k => k !== "id");
  const rows = pairs.map(p => keys.map(k => {
    const v = p[k];
    return typeof v === "string" && v.includes(",") ? `"${v}"` : (v ?? "Not recorded");
  }).join(","));
  const csv = [keys.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "pairpath_registry_export.csv"; a.click();
}

function parseCSV(text) {
  const [headerLine, ...rows] = text.trim().split("\n");
  const headers = headerLine.split(",").map(h => h.trim());
  return rows.map(row => {
    const vals = row.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    if (obj.recipient_dob) {
      const parts = obj.recipient_dob.split("/");
      if (parts.length === 3) obj.recipient_year_born = parts[2].length === 4 ? parts[2] : `20${parts[2]}`;
    }
    if (obj.donor_dob) {
      const parts = obj.donor_dob.split("/");
      if (parts.length === 3) obj.donor_year_born = parts[2].length === 4 ? parts[2] : `20${parts[2]}`;
    }
    obj.status = obj.status || "active";
    obj.urgency = obj.urgency || "Medium";
    return obj;
  });
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [pairs, setPairs] = useState([]);
  const [view, setView] = useState("grid");
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState(null);
  const [hoveredCell, setHoveredCell] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("active");
  const [filterUrgency, setFilterUrgency] = useState("all");
  const [filterBlood, setFilterBlood] = useState("all");
  const [filterCompat, setFilterCompat] = useState("all");
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [editingPair, setEditingPair] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [mode, setMode] = useState(MODE);
  const [showHLAAdvanced, setShowHLAAdvanced] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    supabase.from("pairs").select("*").order("created_at", { ascending: false }).then(({ data }) => {
      if (data) setPairs(data);
    });
    const channel = supabase.channel("pairpath-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "pairs" }, (payload) => {
        if (payload.eventType === "INSERT") setPairs(prev => [payload.new, ...prev]);
        if (payload.eventType === "UPDATE") setPairs(prev => prev.map(p => p.id === payload.new.id ? payload.new : p));
        if (payload.eventType === "DELETE") setPairs(prev => prev.filter(p => p.id !== payload.old.id));
      }).subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const activePairs = pairs.filter(p => p.status === "active");

  const filteredPairs = pairs.filter(p => {
    if (filterStatus !== "all" && p.status !== filterStatus) return false;
    if (filterUrgency !== "all" && p.urgency !== filterUrgency) return false;
    if (filterBlood !== "all" && p.recipient_blood_type !== filterBlood) return false;
    if (search && !p.recipient_name?.toLowerCase().includes(search.toLowerCase())
        && !p.donor_name?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => {
    let va, vb;
    if (sortBy === "date") { va = new Date(a.created_at); vb = new Date(b.created_at); }
    else if (sortBy === "urgency") {
      const u = { High: 0, Medium: 1, Low: 2 };
      va = u[a.urgency] ?? 1; vb = u[b.urgency] ?? 1;
    }
    else if (sortBy === "name") { va = a.recipient_name || ""; vb = b.recipient_name || ""; }
    return sortDir === "desc" ? (va > vb ? -1 : 1) : (va > vb ? 1 : -1);
  });

  const chains = findChains(pairs);

  const stats = {
    total: pairs.length,
    active: activePairs.length,
    highUrgency: activePairs.filter(p => p.urgency === "High").length,
    completed: pairs.filter(p => p.status === "completed").length,
    withdrawn: pairs.filter(p => p.status === "withdrawn").length,
    withMatch: activePairs.filter(p =>
      activePairs.some(d => d.id !== p.id && calculateCompatibility(d, p).score >= 70)
    ).length,
    chains2: chains.filter(c => c.length === 2).length,
    chains3: chains.filter(c => c.length === 3).length,
    chainsLong: chains.filter(c => c.length > 3).length,
  };

  async function handleAdd() {
    if (!form.recipient_name || !form.donor_name || !form.recipient_blood_type || !form.donor_blood_type) return;
    setAdding(true);
    const insertData = { ...form, status: form.status || "active" };
    if (editingPair) {
      await supabase.from("pairs").update(insertData).eq("id", editingPair);
      setEditingPair(null);
    } else {
      const { data, error } = await supabase.from("pairs").insert([insertData]).select();
      if (!error && data) { setFlash(data[0].id); setTimeout(() => setFlash(null), 2500); }
    }
    setForm(emptyForm);
    setView("grid");
    setAdding(false);
  }

  async function handleStatusChange(id, status) {
    await supabase.from("pairs").update({ status }).eq("id", id);
  }

  function openDetail(donor, recipient) {
    const result = calculateCompatibility(donor, recipient);
    setSelected({ donor, recipient, result });
    setView("detail");
  }

  function startEdit(pair) {
    setForm({ ...emptyForm, ...pair });
    setEditingPair(pair.id);
    setView("add");
  }

  async function handleCSVUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const text = await file.text();
    try {
      const rows = parseCSV(text);
      const { data, error } = await supabase.from("pairs").insert(rows).select();
      if (error) setUploadResult({ success: false, message: error.message });
      else setUploadResult({ success: true, message: `${data.length} pairs imported successfully` });
    } catch (err) {
      setUploadResult({ success: false, message: "CSV parsing error — check your file matches the template" });
    }
    setUploading(false);
    e.target.value = "";
  }

  const S = {
    app: { minHeight: "100vh", background: "#0a0e14", color: "#e8e4dc", fontFamily: "'DM Sans', sans-serif", fontSize: 14 },
    header: { borderBottom: "1px solid #1e2530", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, background: "#0d1219", gap: 12 },
    navBtn: (active) => ({ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, background: active ? "#1a2e24" : "transparent", color: active ? "#2dd4a0" : "#6b7a8d", transition: "all 0.15s" }),
    page: { padding: "24px 28px", maxWidth: 1400, margin: "0 auto" },
    pageTitle: { fontFamily: "'DM Serif Display', serif", fontSize: 26, fontWeight: 400, margin: "0 0 4px", color: "#e8e4dc" },
    subtitle: { margin: "0 0 24px", color: "#5a6a7a", fontSize: 13 },
    card: { background: "#0d1219", border: "1px solid #1a2530", borderRadius: 10, padding: 16 },
    input: { width: "100%", boxSizing: "border-box", background: "#111820", border: "1px solid #1e2a34", borderRadius: 6, padding: "8px 10px", color: "#c8d4dc", fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: "none" },
    select: { width: "100%", background: "#111820", border: "1px solid #1e2a34", borderRadius: 6, padding: "8px 10px", color: "#c8d4dc", fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: "none", cursor: "pointer" },
    label: { fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", letterSpacing: "0.08em", display: "block", marginBottom: 4 },
    btn: { padding: "9px 20px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontWeight: 600, fontSize: 13, transition: "all 0.15s" },
    tag: (color) => ({ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: `${color}22`, color, fontFamily: "'DM Mono', monospace", letterSpacing: "0.05em" }),
  };

  return (
    <div style={S.app}>
      {/* Header */}
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, color: "#e8e4dc" }}>PairPath</span>
          <span style={S.tag("#3d8c6e")}>{mode.toUpperCase()}</span>
          {stats.highUrgency > 0 && (
            <span style={{ ...S.tag("#ff8a8a"), animation: "pulse 2s infinite" }}>
              {stats.highUrgency} HIGH URGENCY
            </span>
          )}
        </div>
        <nav style={{ display: "flex", gap: 2 }}>
          {[["grid","Grid"],["registry","Registry"],["chains","Chains"],["dashboard","Dashboard"],["add","+ Add Pair"]].map(([v,l]) => (
            <button key={v} onClick={() => { setView(v); setEditingPair(null); if(v==="add") setForm(emptyForm); }} style={S.navBtn(view===v)}>{l}</button>
          ))}
        </nav>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {mode === "solo" && (
            <button onClick={() => setMode("national")} style={{ ...S.navBtn(false), fontSize: 11 }}>Switch to National</button>
          )}
          {mode === "national" && (
            <button onClick={() => setMode("solo")} style={{ ...S.navBtn(false), fontSize: 11 }}>Switch to Solo</button>
          )}
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#2dd4a0", boxShadow: "0 0 6px #2dd4a0" }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#3d8c6e" }}>{activePairs.length} ACTIVE</span>
        </div>
      </header>

      {/* Grid View */}
      {view === "grid" && (
        <div style={S.page}>
          <h1 style={S.pageTitle}>Compatibility Grid</h1>
          <p style={S.subtitle}>Scores between every active donor and recipient. Click any cell for full breakdown.</p>

          {/* Filters */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
            <select value={filterBlood} onChange={e => setFilterBlood(e.target.value)} style={{ ...S.select, width: 110 }}>
              <option value="all">All Blood</option>
              {["A","B","AB","O"].map(b => <option key={b}>{b}</option>)}
            </select>
            <select value={filterUrgency} onChange={e => setFilterUrgency(e.target.value)} style={{ ...S.select, width: 120 }}>
              <option value="all">All Urgency</option>
              {["High","Medium","Low"].map(u => <option key={u}>{u}</option>)}
            </select>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {[["Compatible","70+"],["Marginal","40-69"],["Incompatible","<40"]].map(([l,r]) => (
                <span key={l} style={{ fontSize: 11, color: "#5a6a7a" }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: scoreStyle(l==="Compatible"?80:l==="Marginal"?55:10).bg, marginRight: 4 }}/>
                  {l} ({r})
                </span>
              ))}
            </div>
          </div>

          {activePairs.length === 0 ? (
            <div style={{ textAlign: "center", padding: 80, color: "#3a4a5a" }}>
              <div style={{ fontSize: 13, marginBottom: 16 }}>No active pairs in registry</div>
              <button onClick={() => setView("add")} style={{ ...S.btn, background: "#2dd4a0", color: "#0a1a14" }}>Register First Pair</button>
            </div>
          ) : (
            <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid #1a2530" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ background: "#0d1219" }}>
                    <th style={{ padding: "12px 16px", textAlign: "left", fontSize: 10, color: "#3d5060", fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", fontWeight: 400, borderBottom: "1px solid #1a2530", borderRight: "1px solid #1a2530", minWidth: 180, whiteSpace: "nowrap" }}>
                      RECIPIENT ↓ / DONOR →
                    </th>
                    {activePairs.map(p => (
                      <th key={p.id} style={{ padding: "10px 12px", textAlign: "center", borderBottom: "1px solid #1a2530", borderRight: "1px solid #1a2530", minWidth: 90 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#c8d4dc", whiteSpace: "nowrap" }}>{p.donor_name?.split(" ")[0]}</div>
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d8c6e", marginTop: 2 }}>{p.donor_blood_type}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activePairs
                    .filter(p => filterBlood === "all" || p.recipient_blood_type === filterBlood)
                    .filter(p => filterUrgency === "all" || p.urgency === filterUrgency)
                    .map((recipient, ri) => (
                    <tr key={recipient.id} style={{ background: recipient.id === flash ? "#0d2a1e" : ri % 2 === 0 ? "#0a0e14" : "#0c1018", transition: "background 0.5s" }}>
                      <td style={{ padding: "10px 16px", borderBottom: "1px solid #141c24", borderRight: "1px solid #1a2530", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 6, height: 6, borderRadius: "50%", background: URGENCY_COLORS[recipient.urgency] || "#5a6a7a", flexShrink: 0 }} title={URGENCY_DEFS[recipient.urgency]} />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#c8d4dc" }}>{recipient.recipient_name}</div>
                            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", marginTop: 1 }}>
                              {recipient.recipient_blood_type} · PRA {recipient.recipient_pra_percent || "?"}%
                              {recipient.recipient_pra_percent > 80 && <span style={{ color: "#ff8a8a", marginLeft: 4 }}>HIGH</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      {activePairs.map(donor => {
                        if (donor.id === recipient.id) return (
                          <td key={donor.id} style={{ textAlign: "center", borderBottom: "1px solid #141c24", borderRight: "1px solid #141c24", background: "#0d1219", color: "#1e2a34", fontSize: 14 }}>—</td>
                        );
                        const result = calculateCompatibility(donor, recipient);
                        const s = scoreStyle(result.score, result.partial);
                        const cellKey = `${donor.id}-${recipient.id}`;
                        return (
                          <td key={donor.id}
                            onMouseEnter={() => setHoveredCell(cellKey)}
                            onMouseLeave={() => setHoveredCell(null)}
                            onClick={() => openDetail(donor, recipient)}
                            title={`ABO: ${result.reasons.abo ? "✓" : "✗"} | HLA MM: ${result.reasons.hlaMismatches} | ${result.partial ? "Partial data" : s.label}`}
                            style={{ textAlign: "center", cursor: "pointer", borderBottom: "1px solid #141c24", borderRight: "1px solid #141c24", background: hoveredCell === cellKey ? s.bg : `${s.bg}99`, transition: "background 0.15s", padding: "10px 6px" }}>
                            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 16, fontWeight: 500, color: s.text, lineHeight: 1 }}>
                              {result.partial ? "?" : result.score}
                            </div>
                            <div style={{ fontSize: 9, color: `${s.text}88`, marginTop: 3 }}>
                              {result.partial ? "data" : `${result.reasons.hlaMismatches}MM`}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ marginTop: 10, fontSize: 11, color: "#2a3a4a", fontFamily: "'DM Mono', monospace" }}>
            MM = HLA mismatches · ? = incomplete HLA data · Scores are computational screens only — confirm with crossmatch
          </p>
        </div>
      )}

      {/* Registry View */}
      {view === "registry" && (
        <div style={S.page}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
            <div>
              <h1 style={S.pageTitle}>Registry</h1>
              <p style={{ ...S.subtitle, marginBottom: 0 }}>All pairs — manage, edit, filter and export</p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={downloadTemplate} style={{ ...S.btn, background: "transparent", border: "1px solid #1e2a34", color: "#5a6a7a" }}>Download CSV Template</button>
              <label style={{ ...S.btn, background: "transparent", border: "1px solid #1e2a34", color: "#5a6a7a", cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
                {uploading ? "Uploading…" : "Bulk Upload CSV"}
                <input ref={fileRef} type="file" accept=".csv" onChange={handleCSVUpload} style={{ display: "none" }} />
              </label>
              <button onClick={() => exportRegistry(filteredPairs)} style={{ ...S.btn, background: "#1a2e24", color: "#2dd4a0" }}>Export CSV</button>
            </div>
          </div>

          {uploadResult && (
            <div style={{ marginBottom: 16, padding: "10px 16px", borderRadius: 8, background: uploadResult.success ? "#0d2a1e" : "#2a1010", border: `1px solid ${uploadResult.success ? "#1a3028" : "#3a1010"}`, color: uploadResult.success ? "#2dd4a0" : "#ff8a8a", fontSize: 13 }}>
              {uploadResult.message}
              <button onClick={() => setUploadResult(null)} style={{ marginLeft: 12, background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
          )}

          {/* Search and filters */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <input placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...S.input, width: 200 }} />
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...S.select, width: 140 }}>
              <option value="all">All Status</option>
              {["active","matched","surgery_scheduled","completed","withdrawn","on_hold","transferred"].map(s => (
                <option key={s} value={s}>{s.replace("_"," ").replace(/\b\w/g,l=>l.toUpperCase())}</option>
              ))}
            </select>
            <select value={filterUrgency} onChange={e => setFilterUrgency(e.target.value)} style={{ ...S.select, width: 130 }}>
              <option value="all">All Urgency</option>
              {["High","Medium","Low"].map(u => <option key={u}>{u}</option>)}
            </select>
            <select value={filterBlood} onChange={e => setFilterBlood(e.target.value)} style={{ ...S.select, width: 120 }}>
              <option value="all">All Blood Type</option>
              {["A","B","AB","O"].map(b => <option key={b}>{b}</option>)}
            </select>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...S.select, width: 130 }}>
              <option value="date">Sort: Date Added</option>
              <option value="urgency">Sort: Urgency</option>
              <option value="name">Sort: Name</option>
            </select>
            <button onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")} style={{ ...S.btn, background: "transparent", border: "1px solid #1e2a34", color: "#5a6a7a", padding: "9px 12px" }}>
              {sortDir === "desc" ? "↓" : "↑"}
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredPairs.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#3a4a5a", fontSize: 13 }}>No pairs match your filters</div>
            )}
            {filteredPairs.map(pair => {
              const bestScore = activePairs
                .filter(d => d.id !== pair.id)
                .map(d => calculateCompatibility(d, pair).score)
                .sort((a,b) => b-a)[0] ?? null;
              const bs = bestScore !== null ? scoreStyle(bestScore) : null;
              const donorAge = calcAge(pair.donor_year_born);
              const recipientAge = calcAge(pair.recipient_year_born);
              return (
                <div key={pair.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ width: 6, height: 40, borderRadius: 3, background: URGENCY_COLORS[pair.urgency] || "#3a4a5a", flexShrink: 0 }} title={pair.urgency} />
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#c8d4dc" }}>{pair.recipient_name}</span>
                      <span style={S.tag("#3d8c6e")}>{pair.recipient_blood_type}</span>
                      {pair.recipient_pra_percent > 80 && <span style={S.tag("#ff8a8a")}>HIGH PRA</span>}
                      {pair.urgency === "High" && <span style={S.tag("#ff8a8a")}>URGENT</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#5a6a7a" }}>
                      Recipient{recipientAge ? ` · Age ${recipientAge}` : ""} · PRA {pair.recipient_pra_percent || "?"}%
                      {pair.recipient_zip ? ` · ${pair.recipient_zip}` : ""}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 13, color: "#8a9aaa", marginBottom: 2 }}>Donor: <strong style={{ color: "#c8d4dc" }}>{pair.donor_name}</strong></div>
                    <div style={{ fontSize: 12, color: "#5a6a7a" }}>
                      {pair.donor_blood_type}{donorAge ? ` · Age ${donorAge}` : ""}
                      {pair.donor_egfr ? ` · eGFR ${pair.donor_egfr}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {bs && (
                      <div style={{ textAlign: "center", padding: "6px 12px", borderRadius: 8, background: `${bs.bg}99` }}>
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, color: bs.text, lineHeight: 1 }}>{bestScore}</div>
                        <div style={{ fontSize: 9, color: `${bs.text}88`, marginTop: 2 }}>BEST</div>
                      </div>
                    )}
                    <select value={pair.status} onChange={e => handleStatusChange(pair.id, e.target.value)}
                      style={{ ...S.select, width: 160, fontSize: 12 }}>
                      {["active","matched","surgery_scheduled","completed","withdrawn","on_hold","transferred"].map(s => (
                        <option key={s} value={s}>{s.replace("_"," ").replace(/\b\w/g,l=>l.toUpperCase())}</option>
                      ))}
                    </select>
                    <button onClick={() => startEdit(pair)} style={{ ...S.btn, background: "transparent", border: "1px solid #1e2a34", color: "#5a6a7a", padding: "6px 12px" }}>Edit</button>
                  </div>
                  {pair.notes && (
                    <div style={{ width: "100%", fontSize: 12, color: "#4a5a6a", borderTop: "1px solid #141c24", paddingTop: 8, marginTop: 4 }}>
                      📝 {pair.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p style={{ marginTop: 12, fontSize: 11, color: "#2a3a4a", fontFamily: "'DM Mono', monospace" }}>
            {filteredPairs.length} pairs shown 
          </p>
        </div>
      )}

      {/* Chains View */}
      {view === "chains" && (
        <div style={S.page}>
          <h1 style={S.pageTitle}>Chain Identification</h1>
          <p style={S.subtitle}>Compatible exchange chains detected across all active pairs. No length cap.</p>
          {chains.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#3a4a5a", fontSize: 13 }}>
              No compatible chains found yet — add more pairs to the registry to identify exchange opportunities
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {chains.map((chain, ci) => (
                <div key={ci} style={{ ...S.card, borderColor: chain.length >= 4 ? "#2d6e8c" : chain.length >= 3 ? "#3d8c6e" : "#1a2530" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <span style={S.tag(chain.length >= 4 ? "#6ab4d0" : chain.length >= 3 ? "#2dd4a0" : "#5a6a7a")}>
                      {chain.length}-WAY CHAIN
                    </span>
                    {chain.length >= 4 && <span style={S.tag("#ffd166")}>COMPLEX EXCHANGE</span>}
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "#5a6a7a" }}>
                      All pairs within ~{Math.round(chain.reduce((acc, p) => {
                        if (!p.recipient_zip) return acc;
                        return acc;
                      }, 0))} mi
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
                    {chain.map((pair, pi) => {
                      const nextPair = chain[(pi + 1) % chain.length];
                      const result = pi < chain.length - 1 ? calculateCompatibility(pair, nextPair) : null;
                      return (
                        <div key={pair.id} style={{ display: "flex", alignItems: "center" }}>
                          <div style={{ padding: "8px 14px", borderRadius: 8, background: "#111820", border: "1px solid #1e2a34", textAlign: "center" }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#c8d4dc" }}>{pair.donor_name?.split(" ")[0]}</div>
                            <div style={{ fontSize: 10, color: "#3d5060", marginTop: 1 }}>donates to</div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#8a9aaa", marginTop: 1 }}>{nextPair ? nextPair.recipient_name?.split(" ")[0] : chain[0].recipient_name?.split(" ")[0]}</div>
                            {result && (
                              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: scoreStyle(result.score).text, marginTop: 4 }}>
                                Score: {result.score}
                              </div>
                            )}
                          </div>
                          {pi < chain.length - 1 && (
                            <div style={{ padding: "0 8px", color: "#2dd4a0", fontSize: 16 }}>→</div>
                          )}
                        </div>
                      );
                    })}
                    <div style={{ padding: "0 8px", color: "#3d5060", fontSize: 16 }}>↩</div>
                  </div>
                  {chain.some(p => p.recipient_zip) && (
                    <div style={{ marginTop: 10, fontSize: 11, color: "#4a5a6a" }}>
                      ZIP codes: {chain.map(p => p.recipient_zip).filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p style={{ marginTop: 16, fontSize: 11, color: "#2a3a4a", fontFamily: "'DM Mono', monospace" }}>
            Chains update automatically as new pairs are added · All matches require crossmatch confirmation before any clinical decision
          </p>
        </div>
      )}

      {/* Dashboard View */}
      {view === "dashboard" && (
        <div style={S.page}>
          <h1 style={S.pageTitle}>Dashboard</h1>
          <p style={S.subtitle}>Registry overview and summary statistics</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
            {[
              { label: "Total Pairs", value: stats.total, color: "#5a6a7a" },
              { label: "Active", value: stats.active, color: "#2dd4a0" },
              { label: "High Urgency", value: stats.highUrgency, color: "#ff8a8a" },
              { label: "With Match (70+)", value: stats.withMatch, color: "#6effc6" },
              { label: "Completed", value: stats.completed, color: "#6ab4d0" },
              { label: "Withdrawn", value: stats.withdrawn, color: "#5a6a7a" },
              { label: "2-Way Chains", value: stats.chains2, color: "#2dd4a0" },
              { label: "3-Way Chains", value: stats.chains3, color: "#6ab4d0" },
              { label: "4+ Way Chains", value: stats.chainsLong, color: "#ffd166" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ ...S.card, textAlign: "center" }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 32, fontWeight: 500, color, lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 11, color: "#5a6a7a", marginTop: 6, letterSpacing: "0.03em" }}>{label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Blood type breakdown */}
            <div style={S.card}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", letterSpacing: "0.1em", marginBottom: 14 }}>RECIPIENT BLOOD TYPE DISTRIBUTION</div>
              {["A","B","AB","O"].map(bt => {
                const count = activePairs.filter(p => p.recipient_blood_type === bt).length;
                const pct = activePairs.length ? Math.round((count / activePairs.length) * 100) : 0;
                return (
                  <div key={bt} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
                      <span style={{ color: "#8a9aaa" }}>Type {bt}</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: "#c8d4dc" }}>{count} <span style={{ color: "#5a6a7a" }}>({pct}%)</span></span>
                    </div>
                    <div style={{ height: 4, background: "#1a2530", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: "#2dd4a0", borderRadius: 2, transition: "width 0.5s" }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Urgency breakdown */}
            <div style={S.card}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", letterSpacing: "0.1em", marginBottom: 14 }}>URGENCY BREAKDOWN (ACTIVE PAIRS)</div>
              {["High","Medium","Low"].map(u => {
                const count = activePairs.filter(p => p.urgency === u).length;
                const pct = activePairs.length ? Math.round((count / activePairs.length) * 100) : 0;
                return (
                  <div key={u} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
                      <span style={{ color: "#8a9aaa", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: URGENCY_COLORS[u], display: "inline-block" }}/>
                        {u}
                      </span>
                      <span style={{ fontFamily: "'DM Mono', monospace", color: "#c8d4dc" }}>{count} <span style={{ color: "#5a6a7a" }}>({pct}%)</span></span>
                    </div>
                    <div style={{ height: 4, background: "#1a2530", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: URGENCY_COLORS[u], borderRadius: 2, transition: "width 0.5s" }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 8, background: "#0a1a14", border: "1px solid #1a3028" }}>
                <div style={{ fontSize: 11, color: "#3d6a50" }}>High urgency with no match yet</div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, color: "#ff8a8a", marginTop: 4 }}>
                  {activePairs.filter(p => p.urgency === "High" && !activePairs.some(d => d.id !== p.id && calculateCompatibility(d,p).score >= 70)).length}
                </div>
              </div>
            </div>

            {/* No match found */}
            <div style={S.card}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", letterSpacing: "0.1em", marginBottom: 14 }}>PAIRS WITH NO COMPATIBLE MATCH YET</div>
              {activePairs.filter(p => !activePairs.some(d => d.id !== p.id && calculateCompatibility(d,p).score >= 70)).length === 0 ? (
                <div style={{ fontSize: 13, color: "#2dd4a0" }}>All active pairs have at least one compatible match ✓</div>
              ) : (
                activePairs.filter(p => !activePairs.some(d => d.id !== p.id && calculateCompatibility(d,p).score >= 70)).map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: URGENCY_COLORS[p.urgency], flexShrink: 0 }} />
                    <span style={{ color: "#c8d4dc" }}>{p.recipient_name}</span>
                    <span style={{ color: "#5a6a7a" }}>· {p.recipient_blood_type} · PRA {p.recipient_pra_percent || "?"}%</span>
                  </div>
                ))
              )}
            </div>

            {/* Recent activity */}
            <div style={S.card}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", letterSpacing: "0.1em", marginBottom: 14 }}>RECENT PAIRS</div>
              {pairs.slice(0, 6).map(p => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: "#c8d4dc" }}>{p.recipient_name}</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={S.tag(URGENCY_COLORS[p.urgency] || "#5a6a7a")}>{p.urgency}</span>
                    <span style={{ color: "#3a4a5a", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>
                      {p.created_at ? new Date(p.created_at).toLocaleDateString() : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Pair */}
      {view === "add" && (
        <div style={{ ...S.page, maxWidth: 960 }}>
          <h1 style={S.pageTitle}>{editingPair ? "Edit Pair" : "Register New Pair"}</h1>
          <p style={S.subtitle}>
            {editingPair ? "Update clinical details for this pair." : "PairPath calculates compatibility against all active pairs automatically."}
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
            {[
              { title: "Recipient", color: "#3d8c6e", prefix: "recipient" },
              { title: "Donor", color: "#2d6e8c", prefix: "donor" },
            ].map(({ title, color, prefix }) => (
              <div key={prefix} style={S.card}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div style={{ width: 3, height: 18, borderRadius: 2, background: color }} />
                  <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 18, color: "#e8e4dc" }}>{title}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#3a4a5a" }}>* required</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Field label={`${title} Full Name *`} value={form[`${prefix}_name`]} onChange={v => setForm(f => ({ ...f, [`${prefix}_name`]: v }))} S={S} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <label style={S.label}>BLOOD TYPE *</label>
                      <select value={form[`${prefix}_blood_type`]} onChange={e => setForm(f => ({ ...f, [`${prefix}_blood_type`]: e.target.value }))} style={S.select}>
                        {["A","B","AB","O"].map(o => <option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <Field label="Year Born *" type="number" placeholder="e.g. 1975" value={form[`${prefix}_year_born`]} onChange={v => setForm(f => ({ ...f, [`${prefix}_year_born`]: v }))} S={S} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Field label="Weight (kg)" type="number" value={form[`${prefix}_weight_kg`]} onChange={v => setForm(f => ({ ...f, [`${prefix}_weight_kg`]: v }))} S={S} />
                    <Field label="Height (cm)" type="number" value={form[`${prefix}_height_cm`]} onChange={v => setForm(f => ({ ...f, [`${prefix}_height_cm`]: v }))} S={S} />
                  </div>
                  {prefix === "recipient" && (
                    <Field label="PRA %" type="number" placeholder="0–100" value={form.recipient_pra_percent} onChange={v => setForm(f => ({ ...f, recipient_pra_percent: v }))} S={S} />
                  )}
                  {prefix === "donor" && (
                    <Field label="eGFR (mL/min)" type="number" value={form.donor_egfr} onChange={v => setForm(f => ({ ...f, donor_egfr: v }))} S={S} />
                  )}
                  <div>
                    <label style={S.label}>CMV STATUS</label>
                    <select value={form[`${prefix}_cmv`]} onChange={e => setForm(f => ({ ...f, [`${prefix}_cmv`]: e.target.value }))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o => <option key={o}>{o}</option>)}
                    </select>
                  </div>

                  {/* HLA Section */}
                  <div style={{ borderTop: "1px solid #1a2530", paddingTop: 12, marginTop: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <label style={{ ...S.label, marginBottom: 0 }}>HLA TYPING <span style={{ color: "#2a3a4a" }}>(optional)</span></label>
                      <button onClick={() => setShowHLAAdvanced(v => !v)} style={{ background: "none", border: "none", color: "#3d8c6e", cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>
                        {showHLAAdvanced ? "▲ hide fields" : "▼ individual fields"}
                      </button>
                    </div>
                    <Field label="HLA Notes (paste Epic output)" placeholder="e.g. A*02:01, A*24:02, B*07:02..." value={form[`${prefix}_hla_notes`]} onChange={v => setForm(f => ({ ...f, [`${prefix}_hla_notes`]: v }))} S={S} />
                    {showHLAAdvanced && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 8 }}>
                        {["A1","A2","B1","B2","DR1","DR2"].map(h => (
                          <div key={h}>
                            <label style={{ ...S.label, fontSize: 9 }}>HLA-{h}</label>
                            <input value={form[`${prefix}_hla_${h.toLowerCase()}`]} onChange={e => setForm(f => ({ ...f, [`${prefix}_hla_${h.toLowerCase()}`]: e.target.value }))}
                              style={{ ...S.input, padding: "6px 8px", fontSize: 12, fontFamily: "'DM Mono', monospace" }} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {prefix === "recipient" && (
                    <>
                      <Field label="Dialysis Start Date" type="date" value={form.recipient_dialysis_start} onChange={v => setForm(f => ({ ...f, recipient_dialysis_start: v }))} S={S} />
                      <Field label="Prior Transplants" type="number" placeholder="0" value={form.recipient_prior_transplants} onChange={v => setForm(f => ({ ...f, recipient_prior_transplants: v }))} S={S} />
                      <Field label="Sensitisation History Notes" placeholder="Prior transplants, pregnancies, transfusions…" value={form.recipient_sensitisation_notes} onChange={v => setForm(f => ({ ...f, recipient_sensitisation_notes: v }))} S={S} />
                      <Field label="Crossmatch (Virtual)" placeholder="Negative / Positive / Pending" value={form.recipient_crossmatch_virtual} onChange={v => setForm(f => ({ ...f, recipient_crossmatch_virtual: v }))} S={S} />
                      <Field label="Crossmatch (Physical/Lab)" placeholder="Negative / Positive / Pending" value={form.recipient_crossmatch_physical} onChange={v => setForm(f => ({ ...f, recipient_crossmatch_physical: v }))} S={S} />
                    </>
                  )}
                  {prefix === "donor" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" id="backup" checked={form.donor_backup} onChange={e => setForm(f => ({ ...f, donor_backup: e.target.checked }))} />
                      <label htmlFor="backup" style={{ fontSize: 12, color: "#8a9aaa", cursor: "pointer" }}>Designated backup donor</label>
                    </div>
                  )}
                  <Field label="ZIP Code" placeholder="e.g. 94109" value={form[`${prefix === "recipient" ? "recipient" : "donor"}_zip`] || form.recipient_zip} onChange={v => setForm(f => ({ ...f, [`${prefix}_zip`]: v }))} S={S} />
                </div>
              </div>
            ))}
          </div>

          {/* Pair-level fields */}
          <div style={{ ...S.card, marginBottom: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div>
                <label style={S.label}>URGENCY *</label>
                <select value={form.urgency} onChange={e => setForm(f => ({ ...f, urgency: e.target.value }))} style={S.select}>
                  {["High","Medium","Low"].map(u => <option key={u} value={u}>{u} — {URGENCY_DEFS[u].split(".")[0]}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>DONOR-RECIPIENT RELATIONSHIP</label>
                <select value={form.recipient_relationship} onChange={e => setForm(f => ({ ...f, recipient_relationship: e.target.value }))} style={S.select}>
                  {["","Spouse/Partner","Parent","Sibling","Child","Friend","Altruistic Stranger","Other"].map(r => <option key={r} value={r}>{r || "Select…"}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>PAIR TYPE</label>
                <select value={form.pair_type} onChange={e => setForm(f => ({ ...f, pair_type: e.target.value }))} style={S.select}>
                  <option value="paired">Paired — incompatible donor/recipient</option>
                  <option value="altruistic">Altruistic donor (no paired recipient)</option>
                  <option value="recipient_only">Recipient seeking altruistic donor</option>
                </select>
              </div>
              {mode === "national" && (
                <Field label="Transplant Centre" placeholder="e.g. Sutter CPMC" value={form.centre} onChange={v => setForm(f => ({ ...f, centre: v }))} S={S} />
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={S.label}>CLINICAL NOTES</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Any clinical context, flags, or coordinator notes…"
                style={{ ...S.input, minHeight: 70, resize: "vertical", fontFamily: "'DM Sans', sans-serif" }} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={handleAdd} disabled={adding || !form.recipient_name || !form.donor_name}
              style={{ ...S.btn, background: "#2dd4a0", color: "#0a1a14", opacity: (!form.recipient_name || !form.donor_name) ? 0.4 : 1 }}>
              {adding ? (editingPair ? "Saving…" : "Registering…") : (editingPair ? "Save Changes" : "Register Pair")}
            </button>
            <button onClick={() => { setView("grid"); setEditingPair(null); setForm(emptyForm); }}
              style={{ ...S.btn, background: "transparent", border: "1px solid #1e2a34", color: "#5a6a7a" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Detail View */}
      {view === "detail" && selected && (() => {
        const { donor, recipient, result } = selected;
        const s = scoreStyle(result.score, result.partial);
        const donorAge = calcAge(donor.donor_year_born);
        const recipientAge = calcAge(recipient.recipient_year_born);
        return (
          <div style={{ ...S.page, maxWidth: 860 }}>
            <button onClick={() => setView("grid")} style={{ background: "none", border: "none", color: "#3d8c6e", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: 0, marginBottom: 24, letterSpacing: "0.05em" }}>← BACK TO GRID</button>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
              <div>
                <h1 style={S.pageTitle}>Compatibility Report</h1>
                <p style={{ margin: "4px 0 0", color: "#5a6a7a", fontSize: 13 }}>{donor.donor_name} → {recipient.recipient_name}</p>
                {result.partial && <p style={{ margin: "4px 0 0", color: "#ffd166", fontSize: 12 }}>⚠ Partial score — HLA data incomplete</p>}
              </div>
              <div style={{ textAlign: "center", padding: "14px 22px", borderRadius: 12, background: s.bg, border: `1px solid ${s.text}33` }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 40, fontWeight: 500, color: s.text, lineHeight: 1 }}>{result.partial ? "?" : result.score}</div>
                <div style={{ fontSize: 11, color: `${s.text}cc`, marginTop: 4, letterSpacing: "0.1em" }}>{s.label.toUpperCase()}</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {[
                { label: "ABO Compatibility", value: result.reasons.abo ? "Compatible" : "Incompatible", ok: result.reasons.abo, detail: `${donor.donor_blood_type} → ${recipient.recipient_blood_type}` },
                { label: "HLA Mismatches", value: `${result.reasons.hlaMismatches} / 6`, ok: result.reasons.hlaMismatches <= 2, warn: result.reasons.hlaMismatches <= 4, detail: "0 = perfect · 6 = full mismatch" },
                { label: "PRA Sensitization", value: `${recipient.recipient_pra_percent || "?"}%`, ok: !result.reasons.highSensitization, detail: result.reasons.highSensitization ? "Highly sensitized — harder to match" : "Acceptable level" },
                { label: "Size Compatibility", value: result.reasons.sizeMatch ? "Acceptable" : "Flag", ok: result.reasons.sizeMatch, detail: `Donor ${donor.donor_weight_kg || "?"}kg → Recipient ${recipient.recipient_weight_kg || "?"}kg` },
                { label: "CMV Risk", value: result.reasons.cmvRisk ? "Risk Flagged" : "Acceptable", ok: !result.reasons.cmvRisk, detail: `Donor ${donor.donor_cmv} / Recipient ${recipient.recipient_cmv}` },
                { label: "Age Gap", value: donorAge && recipientAge ? `${result.reasons.ageDiff} yrs` : "Unknown", ok: !result.reasons.ageFlag, detail: `Donor ${donorAge || "?"}y · Recipient ${recipientAge || "?"}y · >15yr gap flagged` },
                { label: "Donor eGFR", value: donor.donor_egfr ? `${donor.donor_egfr} mL/min` : "Not recorded", ok: (donor.donor_egfr || 0) >= 60, detail: (donor.donor_egfr || 0) >= 60 ? "Adequate renal function" : "Below 60 — review required" },
                { label: "Virtual Crossmatch", value: recipient.recipient_crossmatch_virtual || "Not recorded", ok: recipient.recipient_crossmatch_virtual === "Negative", detail: "Negative = compatible" },
              ].map(({ label, value, ok, warn, detail }) => (
                <div key={label} style={{ ...S.card, borderColor: ok ? "#1a3028" : warn ? "#2a2010" : "#2a1010" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <span style={{ fontSize: 12, color: "#5a6a7a" }}>{label}</span>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: ok ? "#2dd4a0" : warn ? "#ffd166" : "#ff8a8a" }}>{value}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#3a4a5a", marginTop: 5 }}>{detail}</div>
                </div>
              ))}
            </div>

            {/* HLA comparison */}
            <div style={{ ...S.card, marginBottom: 16 }}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", letterSpacing: "0.1em", marginBottom: 12 }}>HLA ALLELE COMPARISON</div>
              {(donor.donor_hla_notes || recipient.recipient_hla_notes) && (
                <div style={{ marginBottom: 12, fontSize: 12, color: "#5a6a7a" }}>
                  {donor.donor_hla_notes && <div>Donor HLA: <span style={{ fontFamily: "'DM Mono', monospace", color: "#6ab4d0" }}>{donor.donor_hla_notes}</span></div>}
                  {recipient.recipient_hla_notes && <div style={{ marginTop: 4 }}>Recipient HLA: <span style={{ fontFamily: "'DM Mono', monospace", color: "#6ad0a0" }}>{recipient.recipient_hla_notes}</span></div>}
                </div>
              )}
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["LOCUS","DONOR","RECIPIENT","MISMATCHES"].map(h => (
                      <th key={h} style={{ textAlign: h === "LOCUS" ? "left" : "center", padding: "6px 10px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#3d5060", fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {["A","B","DR"].map(locus => {
                    const dl = [donor[`donor_hla_${locus.toLowerCase()}1`], donor[`donor_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const rl = [recipient[`recipient_hla_${locus.toLowerCase()}1`], recipient[`recipient_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const mm = dl.filter(a => !rl.includes(a)).length;
                    return (
                      <tr key={locus} style={{ borderTop: "1px solid #141c24" }}>
                        <td style={{ padding: "9px 10px", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#8a9aaa" }}>HLA-{locus}</td>
                        <td style={{ padding: "9px 10px", textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#6ab4d0" }}>{dl.join(" / ") || "—"}</td>
                        <td style={{ padding: "9px 10px", textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#6ad0a0" }}>{rl.join(" / ") || "—"}</td>
                        <td style={{ padding: "9px 10px", textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: mm === 0 ? "#2dd4a0" : mm === 1 ? "#ffd166" : "#ff8a8a" }}>{dl.length ? `${mm} MM` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "12px 16px", borderRadius: 8, background: "#0d1a14", border: "1px solid #1a3028", fontSize: 12, color: "#3d6a50" }}>
              ⚠ PairPath compatibility scores are computational screens only. All potential matches require crossmatch confirmation before any clinical decision. 
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
        select option { background: #111820; color: #c8d4dc; }
        input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.5); }
      `}</style>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, S }) {
  return (
    <div>
      <label style={S.label}>{label.toUpperCase()}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ ...S.input, fontFamily: type === "number" || type === "date" ? "'DM Mono', monospace" : "'DM Sans', sans-serif" }} />
    </div>
  );
}