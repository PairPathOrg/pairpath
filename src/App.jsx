import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500;600&display=swap";
document.head.appendChild(fontLink);

// ── Matching Engine ────────────────────────────────────────────────────────
const ABO_COMPATIBLE = { O:["O","A","B","AB"], A:["A","AB"], B:["B","AB"], AB:["AB"] };
function calcAge(y) { return y ? new Date().getFullYear() - parseInt(y) : null; }
function checkABO(d, r) { return ABO_COMPATIBLE[d]?.includes(r) ?? false; }

function countHLAMismatches(donor, recipient) {
  let mm = 0;
  ["a","b","dr"].forEach(l => {
    const d = [donor[`donor_hla_${l}1`], donor[`donor_hla_${l}2`]].filter(Boolean);
    const r = [recipient[`recipient_hla_${l}1`], recipient[`recipient_hla_${l}2`]].filter(Boolean);
    if (!d.length) return;
    d.forEach(a => { if (!r.includes(a)) mm++; });
  });
  return mm;
}

function calculateCompatibility(donor, recipient) {
  if (!donor?.donor_blood_type || !recipient?.recipient_blood_type) {
    return { compatible: false, score: 0, partial: true, aboOnly: false, reasons: {} };
  }
  const aboOk = checkABO(donor.donor_blood_type, recipient.recipient_blood_type);
  const hasHLA = !!(donor.donor_hla_a1 || donor.donor_hla_notes || recipient.recipient_hla_a1 || recipient.recipient_hla_notes);
  const hlaMismatches = hasHLA ? countHLAMismatches(donor, recipient) : 0;
  const highPRA = (recipient.recipient_pra_percent || 0) > 80;
  const sizeDiff = Math.abs((donor.donor_weight_kg || 70) - (recipient.recipient_weight_kg || 70));
  const sizeOk = sizeDiff < 40;
  const cmvRisk = donor.donor_cmv === "Positive" && recipient.recipient_cmv === "Negative";
  const dAge = calcAge(donor.donor_year_born), rAge = calcAge(recipient.recipient_year_born);
  const ageDiff = dAge && rAge ? Math.abs(dAge - rAge) : 0;
  const ageFlag = ageDiff > 15;
  const bmi = donor.donor_weight_kg && donor.donor_height_cm ? donor.donor_weight_kg / Math.pow(donor.donor_height_cm / 100, 2) : null;
  const bmiFlag = bmi && bmi > 35;
  const score = aboOk
    ? hasHLA
      ? Math.max(0, 100 - hlaMismatches * 10 - (highPRA ? 20 : 0) - (sizeOk ? 0 : 10) - (cmvRisk ? 5 : 0) - (ageFlag ? 8 : 0) - (bmiFlag ? 5 : 0))
      : Math.max(0, 70 - (highPRA ? 20 : 0) - (sizeOk ? 0 : 10) - (cmvRisk ? 5 : 0) - (ageFlag ? 8 : 0))
    : 0;
  return {
    compatible: aboOk && (hasHLA ? hlaMismatches <= 4 : true),
    score, partial: !hasHLA, aboOnly: !hasHLA,
    reasons: { abo: aboOk, hlaMismatches, highSensitization: highPRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff }
  };
}

// ── Chain Engine ───────────────────────────────────────────────────────────
function findChains(pairs) {
  const active = pairs.filter(p => p.status === "active");
  const MAX_RESULTS = 30;
  const MAX_DEPTH = 4;

  const donors = active.filter(p => p.donor_blood_type).map(p => ({
    id: `d-${p.id}`, pairId: p.id, blood: p.donor_blood_type,
    name: p.donor_name || "Altruistic Donor", weight: p.donor_weight_kg,
    cmv: p.donor_cmv, year: p.donor_year_born, pair_type: p.pair_type,
  }));

  const recipients = active.filter(p => p.recipient_blood_type).map(p => ({
    id: `r-${p.id}`, pairId: p.id, blood: p.recipient_blood_type,
    name: p.recipient_name, weight: p.recipient_weight_kg,
    cmv: p.recipient_cmv, pra: p.recipient_pra_percent, year: p.recipient_year_born,
  }));

  function score(donor, recipient) {
    if (!checkABO(donor.blood, recipient.blood)) return 0;
    const highPRA = (recipient.pra || 0) > 80;
    const sizeOk = Math.abs((donor.weight || 70) - (recipient.weight || 70)) < 40;
    const cmvRisk = donor.cmv === "Positive" && recipient.cmv === "Negative";
    return Math.max(0, 70 - (highPRA ? 20 : 0) - (sizeOk ? 0 : 10) - (cmvRisk ? 5 : 0));
  }

  const edges = new Map();
  donors.forEach(donor => {
    const matches = recipients
      .filter(r => r.pairId !== donor.pairId)
      .map(r => ({ recipient: r, score: score(donor, r) }))
      .filter(m => m.score >= 40)
      .sort((a,b) => b.score - a.score)
      .slice(0, 8);
    edges.set(donor.pairId, matches);
  });

  const donorByPair = new Map(donors.map(d => [d.pairId, d]));
  const chains = [];
  const seen = new Set();

  function addChain(chain) {
    if (chain.length < 2) return;
    const key = chain.map(c => `${c.donorPairId}->${c.recipientPairId}`).join('|');
    if (!seen.has(key)) {
      seen.add(key);
      chains.push([...chain]);
    }
  }

  function dfs(donor, usedPairs, chain) {
    if (chains.length >= MAX_RESULTS) return;
    const matches = edges.get(donor.pairId) || [];

    for (const { recipient, score: s } of matches) {
      if (chains.length >= MAX_RESULTS) return;
      if (usedPairs.has(recipient.pairId)) continue;

      const step = {
        donorName: donor.name,
        donorBlood: donor.blood,
        donorPairId: donor.pairId,
        recipientName: recipient.name,
        recipientBlood: recipient.blood,
        recipientPairId: recipient.pairId,
        score: s,
        altruistic: donor.pair_type === "altruistic"
      };

      chain.push(step);
      addChain(chain);

      if (chain.length < MAX_DEPTH) {
        const nextDonor = donorByPair.get(recipient.pairId);
        if (nextDonor) {
          usedPairs.add(recipient.pairId);
          dfs(nextDonor, usedPairs, chain);
          usedPairs.delete(recipient.pairId);
        }
      }

      chain.pop();
    }
  }

  donors.forEach(startDonor => {
    if (chains.length >= MAX_RESULTS) return;
    dfs(startDonor, new Set([startDonor.pairId]), []);
  });

  return chains.sort((a,b) =>
    b.length - a.length ||
    b.reduce((sum,c)=>sum+c.score,0) - a.reduce((sum,c)=>sum+c.score,0)
  ).slice(0, MAX_RESULTS);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function scoreStyle(score, aboOnly) {
  if (score >= 70) return { bg: "#0d6e4a", text: "#6effc6", label: aboOnly ? "ABO Compatible" : "Compatible" };
  if (score >= 40) return { bg: "#6b4a00", text: "#ffd166", label: aboOnly ? "ABO Marginal" : "Marginal" };
  return { bg: "#6e0d0d", text: "#ff8a8a", label: "Incompatible" };
}

const URGENCY_COLORS = { High: "#ff8a8a", Medium: "#ffd166", Low: "#6effc6" };
const URGENCY_DEFS = {
  High: "Needs transplant within weeks to months. Deteriorating on dialysis or medically urgent.",
  Medium: "Stable but needs transplant within the year. Standard priority.",
  Low: "Early evaluation or preemptive. Medically stable with longer window.",
};
const PAIR_TYPES = [
  { value: "paired", label: "Incompatible Pair", desc: "Recipient with a willing but incompatible donor" },
  { value: "altruistic", label: "Altruistic Donor", desc: "Willing donor with no paired recipient" },
  { value: "recipient_only", label: "Recipient Only", desc: "Recipient with no paired donor" },
];
const STATUS_OPTIONS = ["active","matched","surgery_scheduled","completed","withdrawn","on_hold","transferred"];
const statusLabel = s => s.replace(/_/g," ").replace(/\b\w/g, l => l.toUpperCase());
const NUMERIC_FIELDS = ["recipient_pra_percent","recipient_weight_kg","recipient_height_cm","donor_weight_kg","donor_height_cm","donor_egfr","recipient_prior_transplants"];

const emptyForm = {
  pair_type:"paired", recipient_name:"", recipient_blood_type:"A", recipient_pra_percent:"",
  recipient_weight_kg:"", recipient_height_cm:"", recipient_year_born:"",
  recipient_hla_a1:"", recipient_hla_a2:"", recipient_hla_b1:"", recipient_hla_b2:"",
  recipient_hla_dr1:"", recipient_hla_dr2:"", recipient_hla_notes:"",
  recipient_cmv:"Unknown", recipient_dialysis_start:"", recipient_prior_transplants:"",
  recipient_sensitisation_notes:"", recipient_relationship:"", recipient_zip:"",
  recipient_crossmatch_virtual:"", recipient_crossmatch_physical:"",
  donor_name:"", donor_blood_type:"A", donor_weight_kg:"", donor_height_cm:"",
  donor_year_born:"", donor_hla_a1:"", donor_hla_a2:"", donor_hla_b1:"", donor_hla_b2:"",
  donor_hla_dr1:"", donor_hla_dr2:"", donor_hla_notes:"",
  donor_egfr:"", donor_cmv:"Unknown", donor_backup:false, donor_zip:"",
  urgency:"Medium", status:"active", notes:"", centre:"",
};

// ── CSV ────────────────────────────────────────────────────────────────────
function downloadTemplate() {
  const headers = ["pair_type","recipient_name","recipient_dob","recipient_blood_type","recipient_pra_percent","recipient_weight_kg","recipient_height_cm","recipient_hla_notes","recipient_cmv","recipient_dialysis_start","recipient_prior_transplants","recipient_zip","donor_name","donor_dob","donor_blood_type","donor_weight_kg","donor_height_cm","donor_hla_notes","donor_egfr","donor_cmv","urgency","notes","centre"];
  const ex = ["paired","Jane Smith","01/15/1978","A","25","65","163","A*02:01 A*24:02","Negative","2022-03-01","0","94109","John Smith","03/22/1976","B","78","180","A*01 A*03","90","Negative","Medium","","Sutter CPMC"];
  const blob = new Blob([[headers,ex].map(r=>r.join(",")).join("\n")],{type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="pairpath_template.csv"; a.click();
}

function exportRegistry(pairs) {
  if (!pairs.length) return;
  const keys = Object.keys(pairs[0]).filter(k=>!["id","user_id"].includes(k));
  const rows = pairs.map(p=>keys.map(k=>{const v=p[k];return typeof v==="string"&&v.includes(",")?`"${v}"`:(v??'');}).join(","));
  const blob = new Blob([[keys.join(","),...rows].join("\n")],{type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="pairpath_export.csv"; a.click();
}

function parseCSV(text, userId) {
  const [headerLine,...rows] = text.trim().split("\n");
  const headers = headerLine.split(",").map(h=>h.trim());
  return rows.filter(r=>r.trim()).map(row => {
    const vals = row.split(",").map(v=>v.trim().replace(/^"|"$/g,""));
    const obj = {};
    headers.forEach((h,i) => { obj[h] = vals[i]||""; });
    if (obj.recipient_dob) { const p=obj.recipient_dob.split("/"); if(p.length===3) obj.recipient_year_born=p[2].length===4?p[2]:`20${p[2]}`; }
    if (obj.donor_dob) { const p=obj.donor_dob.split("/"); if(p.length===3) obj.donor_year_born=p[2].length===4?p[2]:`20${p[2]}`; }
    obj.status="active"; obj.urgency=obj.urgency||"Medium"; obj.pair_type=obj.pair_type||"paired";
    obj.donor_backup=false; obj.user_id=userId;
    NUMERIC_FIELDS.forEach(k=>{if(obj[k]===""||obj[k]===undefined) obj[k]=null;});
    ["donor_blood_type","recipient_blood_type"].forEach(k=>{if(!["A","B","AB","O"].includes(obj[k])) obj[k]=null;});
    ["donor_cmv","recipient_cmv"].forEach(k=>{if(!["Positive","Negative","Unknown"].includes(obj[k])) obj[k]="Unknown";});
    return obj;
  });
}

// ── Field Mapping ──────────────────────────────────────────────────────────
const PAIRPATH_FIELDS = [
  {key:"recipient_name",label:"Recipient Name",required:true,types:["paired","recipient_only"]},
  {key:"recipient_blood_type",label:"Recipient Blood Type",required:true,types:["paired","recipient_only"]},
  {key:"recipient_year_born",label:"Recipient Year Born",required:false,types:["paired","recipient_only"]},
  {key:"recipient_pra_percent",label:"Recipient PRA %",required:false,types:["paired","recipient_only"]},
  {key:"recipient_weight_kg",label:"Recipient Weight (kg)",required:false,types:["paired","recipient_only"]},
  {key:"recipient_height_cm",label:"Recipient Height (cm)",required:false,types:["paired","recipient_only"]},
  {key:"recipient_cmv",label:"Recipient CMV",required:false,types:["paired","recipient_only"]},
  {key:"recipient_hla_notes",label:"Recipient HLA Notes",required:false,types:["paired","recipient_only"]},
  {key:"recipient_dialysis_start",label:"Recipient Dialysis Start",required:false,types:["paired","recipient_only"]},
  {key:"recipient_zip",label:"Recipient ZIP",required:false,types:["paired","recipient_only"]},
  {key:"donor_name",label:"Donor Name",required:true,types:["paired","altruistic"]},
  {key:"donor_blood_type",label:"Donor Blood Type",required:true,types:["paired","altruistic"]},
  {key:"donor_year_born",label:"Donor Year Born",required:false,types:["paired","altruistic"]},
  {key:"donor_weight_kg",label:"Donor Weight (kg)",required:false,types:["paired","altruistic"]},
  {key:"donor_height_cm",label:"Donor Height (cm)",required:false,types:["paired","altruistic"]},
  {key:"donor_egfr",label:"Donor eGFR",required:false,types:["paired","altruistic"]},
  {key:"donor_cmv",label:"Donor CMV",required:false,types:["paired","altruistic"]},
  {key:"donor_hla_notes",label:"Donor HLA Notes",required:false,types:["paired","altruistic"]},
  {key:"donor_zip",label:"Donor ZIP",required:false,types:["paired","altruistic"]},
  {key:"urgency",label:"Urgency",required:false,types:["paired","altruistic","recipient_only"]},
  {key:"notes",label:"Clinical Notes",required:false,types:["paired","altruistic","recipient_only"]},
  {key:"centre",label:"Centre",required:false,types:["paired","altruistic","recipient_only"]},
];

function autoDetect(headers) {
  const mapping = {};
  const rules = [
    {keys:["recipient_name","patient_name","pt_name","name"],field:"recipient_name"},
    {keys:["recipient_blood_type","recipient_abo","abo","blood_type","blood type","abo type"],field:"recipient_blood_type"},
    {keys:["recipient_pra","pra","pra_percent","pra %"],field:"recipient_pra_percent"},
    {keys:["recipient_weight","weight_kg","weight"],field:"recipient_weight_kg"},
    {keys:["recipient_height","height_cm","height"],field:"recipient_height_cm"},
    {keys:["recipient_dob","dob","date_of_birth","birth_date"],field:"recipient_year_born"},
    {keys:["recipient_cmv","cmv"],field:"recipient_cmv"},
    {keys:["recipient_hla","hla","hla_notes"],field:"recipient_hla_notes"},
    {keys:["dialysis_start","dialysis start","start_date"],field:"recipient_dialysis_start"},
    {keys:["donor_name","living_donor","donor"],field:"donor_name"},
    {keys:["donor_blood_type","donor_abo"],field:"donor_blood_type"},
    {keys:["donor_egfr","egfr","gfr"],field:"donor_egfr"},
    {keys:["donor_weight"],field:"donor_weight_kg"},
    {keys:["donor_height"],field:"donor_height_cm"},
    {keys:["donor_cmv"],field:"donor_cmv"},
    {keys:["urgency","priority"],field:"urgency"},
    {keys:["notes","comments","clinical_notes"],field:"notes"},
    {keys:["centre","center","hospital","facility"],field:"centre"},
  ];
  headers.forEach(h => {
    const hl = h.toLowerCase().replace(/\s+/g,"_");
    for (const rule of rules) {
      if (rule.keys.some(k => hl.includes(k) || k.includes(hl))) {
        if (!Object.values(mapping).includes(rule.field)) { mapping[h] = rule.field; break; }
      }
    }
  });
  return mapping;
}

// ── Styles ─────────────────────────────────────────────────────────────────
const S = {
  app: {minHeight:"100vh",background:"#0a0e14",color:"#e8e4dc",fontFamily:"'DM Sans', sans-serif",fontSize:14},
  header: {borderBottom:"1px solid #1e2530",padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:60,background:"#0d1219",gap:12},
  navBtn: a => ({padding:"6px 14px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:500,background:a?"#1a2e24":"transparent",color:a?"#2dd4a0":"#9aabb8",transition:"all 0.15s"}),
  page: {padding:"24px 28px",maxWidth:1400,margin:"0 auto"},
  pageTitle: {fontFamily:"'DM Serif Display', serif",fontSize:26,fontWeight:400,margin:"0 0 4px",color:"#e8e4dc"},
  subtitle: {margin:"0 0 24px",color:"#8a9aaa",fontSize:13},
  card: {background:"#0d1219",border:"1px solid #1a2530",borderRadius:10,padding:16},
  input: {width:"100%",boxSizing:"border-box",background:"#111820",border:"1px solid #1e2a34",borderRadius:6,padding:"8px 10px",color:"#e8e4dc",fontSize:13,fontFamily:"'DM Sans', sans-serif",outline:"none"},
  select: {width:"100%",background:"#111820",border:"1px solid #1e2a34",borderRadius:6,padding:"8px 10px",color:"#e8e4dc",fontSize:13,fontFamily:"'DM Sans', sans-serif",outline:"none",cursor:"pointer"},
  label: {fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.08em",display:"block",marginBottom:4},
  btn: {padding:"9px 20px",borderRadius:7,border:"none",cursor:"pointer",fontFamily:"'DM Sans', sans-serif",fontWeight:600,fontSize:13,transition:"all 0.15s"},
  tag: c => ({fontSize:10,padding:"2px 8px",borderRadius:4,background:`${c}22`,color:c,fontFamily:"'DM Mono', monospace",letterSpacing:"0.05em"}),
};

function Field({ label, value, onChange, type="text", placeholder }) {
  return (
    <div>
      <label style={S.label}>{label.toUpperCase()}</label>
      <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{...S.input,fontFamily:type==="number"||type==="date"?"'DM Mono', monospace":"'DM Sans', sans-serif"}}/>
    </div>
  );
}

// ── Auth ───────────────────────────────────────────────────────────────────
function AuthScreen() {
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState(""); const [password,setPassword]=useState("");
  const [name,setName]=useState(""); const [centre,setCentre]=useState("");
  const [loading,setLoading]=useState(false); const [error,setError]=useState(""); const [success,setSuccess]=useState("");

  async function handleLogin(){setLoading(true);setError("");const{error}=await supabase.auth.signInWithPassword({email,password});if(error)setError(error.message);setLoading(false);}
  async function handleSignup(){if(!name||!centre){setError("Please enter your name and centre.");return;}setLoading(true);setError("");const{error}=await supabase.auth.signUp({email,password,options:{data:{full_name:name,centre}}});if(error)setError(error.message);else setSuccess("Account created! Check your email to confirm, then sign in.");setLoading(false);}
  async function handleReset(){setLoading(true);setError("");const{error}=await supabase.auth.resetPasswordForEmail(email);if(error)setError(error.message);else setSuccess("Password reset email sent.");setLoading(false);}

  return (
    <div style={{minHeight:"100vh",background:"#0a0e14",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans', sans-serif"}}>
      <div style={{marginBottom:32,textAlign:"center"}}>
        <div style={{fontFamily:"'DM Serif Display', serif",fontSize:36,color:"#e8e4dc",marginBottom:8}}>PairPath</div>
        <div style={{fontSize:13,color:"#3d8c6e"}}>Kidney Paired Donation Registry</div>
      </div>
      <div style={{width:380,background:"#0d1219",border:"1px solid #1a2530",borderRadius:14,padding:32}}>
        <div style={{display:"flex",gap:4,marginBottom:24,background:"#111820",borderRadius:8,padding:4}}>
          {[["login","Sign In"],["signup","Create Account"]].map(([m,l])=>(
            <button key={m} onClick={()=>{setMode(m);setError("");setSuccess("");}} style={{flex:1,padding:"8px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:500,background:mode===m?"#1a2e24":"transparent",color:mode===m?"#2dd4a0":"#9aabb8"}}>{l}</button>
          ))}
        </div>
        {error&&<div style={{marginBottom:16,padding:"10px 14px",borderRadius:8,background:"#2a1010",border:"1px solid #3a1010",color:"#ff8a8a",fontSize:13}}>{error}</div>}
        {success&&<div style={{marginBottom:16,padding:"10px 14px",borderRadius:8,background:"#0d2a1e",border:"1px solid #1a3028",color:"#2dd4a0",fontSize:13}}>{success}</div>}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {mode==="signup"&&<><div><label style={S.label}>FULL NAME</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={S.input}/></div><div><label style={S.label}>TRANSPLANT CENTRE</label><input value={centre} onChange={e=>setCentre(e.target.value)} placeholder="e.g. Sutter CPMC" style={S.input}/></div></>}
          <div><label style={S.label}>EMAIL</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@hospital.org" style={S.input}/></div>
          <div><label style={S.label}>PASSWORD</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" style={S.input}/></div>
          <button onClick={mode==="login"?handleLogin:handleSignup} disabled={loading||!email||!password} style={{...S.btn,background:"#2dd4a0",color:"#0a1a14",width:"100%",marginTop:4,opacity:(!email||!password)?0.5:1}}>
            {loading?"Please wait…":mode==="login"?"Sign In":"Create Account"}
          </button>
          {mode==="login"&&<button onClick={handleReset} disabled={!email||loading} style={{background:"none",border:"none",color:"#3d8c6e",cursor:"pointer",fontSize:12,padding:"4px 0",opacity:!email?0.4:1}}>Forgot password?</button>}
        </div>
      </div>
      <div style={{marginTop:24,fontSize:11,color:"#3a4a5a",textAlign:"center",maxWidth:380,lineHeight:1.6}}>
        PairPath is a coordinator-facing clinical tool. All matches require crossmatch confirmation before any clinical decision.
      </div>
    </div>
  );
}

// ── CSV Field Mapper ───────────────────────────────────────────────────────
function CSVMapper({ headers, pairType, onConfirm, onCancel, preview }) {
  const [mapping, setMapping] = useState(() => autoDetect(headers));
  const relevantFields = PAIRPATH_FIELDS.filter(f => f.types.includes(pairType));
  const requiredFields = relevantFields.filter(f => f.required);
  const missingRequired = requiredFields.filter(f => !Object.values(mapping).includes(f.key));

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      <div style={{...S.card,maxWidth:700,width:"100%",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{fontFamily:"'DM Serif Display', serif",fontSize:22,color:"#e8e4dc",marginBottom:4}}>Map Your Columns</div>
        <p style={{fontSize:13,color:"#8a9aaa",marginBottom:20}}>Match your spreadsheet columns to PairPath fields. Auto-detected matches are pre-filled.</p>

        {/* Preview */}
        {preview.length > 0 && (
          <div style={{marginBottom:20,padding:12,background:"#111820",borderRadius:8,border:"1px solid #1e2a34"}}>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",marginBottom:8}}>FIRST ROW PREVIEW</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {headers.slice(0,6).map(h=>(
                <div key={h} style={{fontSize:11,color:"#8a9aaa"}}>
                  <span style={{color:"#6a7a8a"}}>{h}:</span> <span style={{color:"#e8e4dc"}}>{preview[0][h]||"—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:20}}>
          {headers.map(h => (
            <div key={h} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"#111820",borderRadius:8,border:"1px solid #1e2a34"}}>
              <div style={{flex:1,fontSize:12,color:"#c8d4dc",fontWeight:500}}>{h}</div>
              <div style={{fontSize:12,color:"#6a7a8a"}}>→</div>
              <select value={mapping[h]||""} onChange={e=>setMapping(m=>({...m,[h]:e.target.value||undefined}))}
                style={{...S.select,width:180,fontSize:11,padding:"5px 8px"}}>
                <option value="">Ignore this column</option>
                {relevantFields.map(f=>(
                  <option key={f.key} value={f.key}>{f.label}{f.required?" *":""}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {missingRequired.length > 0 && (
          <div style={{padding:"10px 14px",borderRadius:8,background:"#2a1010",border:"1px solid #3a1010",color:"#ff8a8a",fontSize:12,marginBottom:16}}>
            Required fields not mapped: {missingRequired.map(f=>f.label).join(", ")}
          </div>
        )}

        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>onConfirm(mapping)} disabled={missingRequired.length>0}
            style={{...S.btn,background:"#2dd4a0",color:"#0a1a14",opacity:missingRequired.length>0?0.4:1}}>
            Import with This Mapping
          </button>
          <button onClick={onCancel} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [session,setSession]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [pairs,setPairs]=useState([]);
  const [view,setView]=useState("grid");
  const [selected,setSelected]=useState(null);
  const [form,setForm]=useState(emptyForm);
  const [adding,setAdding]=useState(false);
  const [flash,setFlash]=useState(null);
  const [hoveredCell,setHoveredCell]=useState(null);
  const [search,setSearch]=useState("");
  const [filterStatus,setFilterStatus]=useState("active");
  const [filterUrgency,setFilterUrgency]=useState("all");
  const [filterBlood,setFilterBlood]=useState("all");
  const [filterCentre,setFilterCentre]=useState("all");
  const [filterPairType,setFilterPairType]=useState("all");
  const [sortBy,setSortBy]=useState("date");
  const [sortDir,setSortDir]=useState("desc");
  const [editingPair,setEditingPair]=useState(null);
  const [uploading,setUploading]=useState(false);
  const [uploadResult,setUploadResult]=useState(null);
  const [showHLAAdvanced,setShowHLAAdvanced]=useState(false);
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [selectedIds,setSelectedIds]=useState(new Set());
  const [bulkDeleteConfirm,setBulkDeleteConfirm]=useState(false);
  const [matchDetail,setMatchDetail]=useState(null);
  const [appMode,setAppMode]=useState("solo");
  const [csvMapper,setCsvMapper]=useState(null);
  const [uploadPairType,setUploadPairType]=useState("paired");
  const [showUploadTypeSelect,setShowUploadTypeSelect]=useState(false);
  const fileRef=useRef();
  const pendingFile=useRef(null);

 useEffect(() => {
  let mounted = true;

  async function initAuth() {
    try {
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("Supabase auth error:", error);
      }

      if (mounted) {
        setSession(data?.session || null);
      }
    } catch (err) {
      console.error("Auth init failed:", err);

      if (mounted) {
        setSession(null);
      }
    } finally {
      if (mounted) {
        setAuthLoading(false);
      }
    }
  }

  initAuth();

  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
    setSession(s);
    setAuthLoading(false);
  });

  return () => {
    mounted = false;
    subscription.unsubscribe();
  };
}, []);

  useEffect(()=>{
    if(!session) return;
    supabase.from("pairs").select("*").order("created_at",{ascending:false}).then(({data})=>{if(data)setPairs(data);});
    const ch=supabase.channel("pp").on("postgres_changes",{event:"*",schema:"public",table:"pairs"},p=>{
      if(p.eventType==="INSERT") setPairs(prev=>[p.new,...prev]);
      if(p.eventType==="UPDATE") setPairs(prev=>prev.map(r=>r.id===p.new.id?p.new:r));
      if(p.eventType==="DELETE") setPairs(prev=>prev.filter(r=>r.id!==p.old.id));
    }).subscribe();
    return()=>supabase.removeChannel(ch);
  },[session]);

  if(authLoading) return <div style={{minHeight:"100vh",background:"#0a0e14",display:"flex",alignItems:"center",justifyContent:"center",color:"#3d8c6e",fontFamily:"'DM Mono', monospace",fontSize:13}}>Loading PairPath…</div>;
  if(!session) return <AuthScreen/>;

  const currentUserId=session.user.id;
  const userMeta=session.user.user_metadata||{};
  const isAdmin=userMeta.role==="admin";
  const activePairs=pairs.filter(p=>p.status==="active");
  const centres=[...new Set(pairs.map(p=>p.centre).filter(Boolean))];

  const filteredPairs=pairs.filter(p=>{
    if(filterStatus!=="all"&&p.status!==filterStatus) return false;
    if(filterUrgency!=="all"&&p.urgency!==filterUrgency) return false;
    if(filterBlood!=="all"&&p.recipient_blood_type!==filterBlood) return false;
    if(filterCentre!=="all"&&p.centre!==filterCentre) return false;
    if(filterPairType!=="all"&&p.pair_type!==filterPairType) return false;
    if(search){
      const s=search.toLowerCase();
      if(!p.recipient_name?.toLowerCase().includes(s)&&!p.donor_name?.toLowerCase().includes(s)&&
         !p.recipient_name?.split(" ").pop()?.toLowerCase().includes(s)&&
         !p.donor_name?.split(" ").pop()?.toLowerCase().includes(s)) return false;
    }
    return true;
  }).sort((a,b)=>{
    let va,vb;
    if(sortBy==="date"){va=new Date(a.created_at);vb=new Date(b.created_at);}
    else if(sortBy==="urgency"){const u={High:0,Medium:1,Low:2};va=u[a.urgency]??1;vb=u[b.urgency]??1;}
    else if(sortBy==="lastname"){va=(a.recipient_name||"").split(" ").pop();vb=(b.recipient_name||"").split(" ").pop();}
    else if(sortBy==="pra"){va=parseFloat(a.recipient_pra_percent||0);vb=parseFloat(b.recipient_pra_percent||0);}
    else if(sortBy==="dialysis"){va=new Date(a.recipient_dialysis_start||0);vb=new Date(b.recipient_dialysis_start||0);}
    else{va=a.recipient_name||"";vb=b.recipient_name||"";}
    return sortDir==="desc"?(va>vb?-1:1):(va>vb?1:-1);
  });

  const chains=findChains(pairs);
  const stats={
    total:pairs.length,active:activePairs.length,
    highUrgency:activePairs.filter(p=>p.urgency==="High").length,
    completed:pairs.filter(p=>p.status==="completed").length,
    withdrawn:pairs.filter(p=>p.status==="withdrawn").length,
    withMatch:activePairs.filter(p=>p.recipient_blood_type&&activePairs.some(d=>d.id!==p.id&&d.donor_blood_type&&calculateCompatibility(d,p).score>=60)).length,
    altruistic:pairs.filter(p=>p.pair_type==="altruistic").length,
    recipientOnly:pairs.filter(p=>p.pair_type==="recipient_only").length,
    chains2:chains.filter(c=>c.length===2).length,
    chains3:chains.filter(c=>c.length===3).length,
    chainsLong:chains.filter(c=>c.length>3).length,
  };

  async function handleAdd(){
    const needsR=form.pair_type!=="altruistic",needsD=form.pair_type!=="recipient_only";
    if(needsR&&!form.recipient_name) return;
    if(needsD&&!form.donor_name) return;
    setAdding(true);
    const insertData={...form,status:form.status||"active",user_id:currentUserId,donor_backup:form.donor_backup===true||form.donor_backup==="true"};
    NUMERIC_FIELDS.forEach(k=>{if(insertData[k]===""||insertData[k]===undefined)insertData[k]=null;});
    if(editingPair){await supabase.from("pairs").update(insertData).eq("id",editingPair);setEditingPair(null);}
    else{const{data,error}=await supabase.from("pairs").insert([insertData]).select();if(!error&&data){setFlash(data[0].id);setTimeout(()=>setFlash(null),2500);}}
    setForm(emptyForm);setView("grid");setAdding(false);
  }

  async function handleDelete(id){await supabase.from("pairs").delete().eq("id",id);setDeleteConfirm(null);}

  async function handleBulkDelete(){
    await Promise.all([...selectedIds].map(id=>supabase.from("pairs").delete().eq("id",id)));
    setSelectedIds(new Set());setBulkDeleteConfirm(false);
  }

  async function handleStatusChange(id,status){await supabase.from("pairs").update({status}).eq("id",id);}

  function openDetail(donor,recipient){const result=calculateCompatibility(donor,recipient);setSelected({donor,recipient,result});setView("detail");}

  function startEdit(pair){setForm({...emptyForm,...pair});setEditingPair(pair.id);setView("add");}

  function toggleSelect(id){setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});}
  function toggleSelectAll(){if(selectedIds.size===filteredPairs.length)setSelectedIds(new Set());else setSelectedIds(new Set(filteredPairs.map(p=>p.id)));}

  function handleFileSelect(e){
    const file=e.target.files[0];if(!file) return;
    pendingFile.current=file;
    setShowUploadTypeSelect(true);
    e.target.value="";
  }

  async function processFileWithType(pairType){
    const file=pendingFile.current;if(!file) return;
    setShowUploadTypeSelect(false);setUploading(true);
    const text=await file.text();
    const[headerLine,...rows]=text.trim().split("\n");
    const headers=headerLine.split(",").map(h=>h.trim());
    const preview=rows.slice(0,3).map(row=>{
      const vals=row.split(",").map(v=>v.trim());
      const obj={};headers.forEach((h,i)=>{obj[h]=vals[i]||"";});return obj;
    });
    setCsvMapper({headers,pairType,preview,text});
    setUploadPairType(pairType);
    setUploading(false);
  }

  async function handleMappingConfirm(mapping){
    setUploading(true);
    const[headerLine,...rows]=csvMapper.text.trim().split("\n");
    const headers=headerLine.split(",").map(h=>h.trim());
    try{
      const records=rows.filter(r=>r.trim()).map(row=>{
        const vals=row.split(",").map(v=>v.trim().replace(/^"|"$/g,""));
        const obj={pair_type:csvMapper.pairType,status:"active",urgency:"Medium",donor_backup:false,user_id:currentUserId};
        headers.forEach((h,i)=>{
          const field=mapping[h];
          if(field) obj[field]=vals[i]||"";
        });
        if(obj.recipient_year_born&&obj.recipient_year_born.includes("/")){const p=obj.recipient_year_born.split("/");obj.recipient_year_born=p[2]?.length===4?p[2]:`20${p[2]}`;}
        if(obj.donor_year_born&&obj.donor_year_born.includes("/")){const p=obj.donor_year_born.split("/");obj.donor_year_born=p[2]?.length===4?p[2]:`20${p[2]}`;}
        NUMERIC_FIELDS.forEach(k=>{if(obj[k]===""||obj[k]===undefined)obj[k]=null;});
        if(!["A","B","AB","O"].includes(obj.donor_blood_type))obj.donor_blood_type=null;
        if(!["A","B","AB","O"].includes(obj.recipient_blood_type))obj.recipient_blood_type=null;
        if(!["Positive","Negative","Unknown"].includes(obj.donor_cmv))obj.donor_cmv="Unknown";
        if(!["Positive","Negative","Unknown"].includes(obj.recipient_cmv))obj.recipient_cmv="Unknown";
        return obj;
      });
      const{data,error}=await supabase.from("pairs").insert(records).select();
      if(error)setUploadResult({success:false,message:error.message});
      else setUploadResult({success:true,message:`${data.length} entries imported successfully`});
    }catch(err){setUploadResult({success:false,message:"Import error — "+err.message});}
    setCsvMapper(null);setUploading(false);
  }

  const pairTypeLabel=t=>PAIR_TYPES.find(p=>p.value===t)?.label||"Pair";

  return (
    <div style={S.app}>

      {/* Modals */}
      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:400,width:"90%",textAlign:"center"}}>
            <div style={{fontSize:16,color:"#e8e4dc",marginBottom:8}}>Delete this entry?</div>
            <div style={{fontSize:13,color:"#8a9aaa",marginBottom:24}}>{deleteConfirm.recipient_name||deleteConfirm.donor_name} — this cannot be undone.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={()=>handleDelete(deleteConfirm.id)} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a"}}>Delete</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {bulkDeleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:400,width:"90%",textAlign:"center"}}>
            <div style={{fontSize:16,color:"#e8e4dc",marginBottom:8}}>Delete {selectedIds.size} entries?</div>
            <div style={{fontSize:13,color:"#8a9aaa",marginBottom:24}}>This cannot be undone.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={handleBulkDelete} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a"}}>Delete All {selectedIds.size}</button>
              <button onClick={()=>setBulkDeleteConfirm(false)} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {showUploadTypeSelect&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:500,width:"90%"}}>
            <div style={{fontFamily:"'DM Serif Display', serif",fontSize:22,color:"#e8e4dc",marginBottom:8}}>What are you uploading?</div>
            <p style={{fontSize:13,color:"#8a9aaa",marginBottom:20}}>Select the type so PairPath shows the right field mapping options.</p>
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
              {PAIR_TYPES.map(t=>(
                <button key={t.value} onClick={()=>processFileWithType(t.value)}
                  style={{padding:"14px 16px",borderRadius:10,border:"1px solid #1a2530",background:"#111820",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                  <div style={{fontSize:14,fontWeight:600,color:"#e8e4dc",marginBottom:3}}>{t.label}</div>
                  <div style={{fontSize:12,color:"#8a9aaa"}}>{t.desc}</div>
                </button>
              ))}
            </div>
            <button onClick={()=>setShowUploadTypeSelect(false)} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Cancel</button>
          </div>
        </div>
      )}
      {csvMapper&&<CSVMapper headers={csvMapper.headers} pairType={csvMapper.pairType} preview={csvMapper.preview} onConfirm={handleMappingConfirm} onCancel={()=>setCsvMapper(null)}/>}
      {matchDetail&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setMatchDetail(null)}>
          <div style={{...S.card,maxWidth:480,width:"90%"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.1em",marginBottom:14}}>BEST MATCH</div>
            <div style={{fontSize:14,color:"#e8e4dc",marginBottom:4}}>Recipient: <strong>{matchDetail.recipient.recipient_name}</strong></div>
            <div style={{fontSize:14,color:"#e8e4dc",marginBottom:20}}>Best Donor: <strong>{matchDetail.donor.donor_name||"Altruistic Donor"}</strong></div>
            {[
              {label:"Compatibility Score",value:matchDetail.result.score,color:scoreStyle(matchDetail.result.score,matchDetail.result.aboOnly).text},
              {label:"ABO",value:matchDetail.result.reasons.abo?"Compatible":"Incompatible",color:matchDetail.result.reasons.abo?"#2dd4a0":"#ff8a8a"},
              {label:"HLA Mismatches",value:matchDetail.result.aboOnly?"HLA not yet entered":matchDetail.result.reasons.hlaMismatches,color:"#ffd166"},
              {label:"PRA",value:`${matchDetail.recipient.recipient_pra_percent||"?"}%`,color:matchDetail.result.reasons.highSensitization?"#ff8a8a":"#2dd4a0"},
              {label:"Score basis",value:matchDetail.result.aboOnly?"ABO only — add HLA for full score":"Full HLA score",color:"#6ab4d0"},
            ].map(({label,value,color})=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid #141c24"}}>
                <span style={{fontSize:12,color:"#8a9aaa"}}>{label}</span>
                <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color}}>{value}</span>
              </div>
            ))}
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>{setMatchDetail(null);openDetail(matchDetail.donor,matchDetail.recipient);}} style={{...S.btn,background:"#1a2e24",color:"#2dd4a0",flex:1}}>Full Compatibility Report</button>
              <button onClick={()=>setMatchDetail(null)} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={S.header}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <span style={{fontFamily:"'DM Serif Display', serif",fontSize:20,color:"#e8e4dc"}}>PairPath</span>
          <button onClick={()=>setAppMode(m=>m==="solo"?"national":"solo")}
            style={{...S.tag(appMode==="national"?"#6ab4d0":"#3d8c6e"),cursor:"pointer",border:"none",background:appMode==="national"?"#6ab4d022":"#3d8c6e22"}}>
            {appMode.toUpperCase()}
          </button>
          {stats.highUrgency>0&&<span style={S.tag("#ff8a8a")}>{stats.highUrgency} HIGH URGENCY</span>}
        </div>
        <nav style={{display:"flex",gap:2}}>
          {[["grid","Grid"],["registry","Registry"],["chains","Chains"],["dashboard","Dashboard"],["add","+ Add"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setView(v);setEditingPair(null);if(v==="add")setForm(emptyForm);}} style={S.navBtn(view===v)}>{l}</button>
          ))}
        </nav>
        <div style={{display:"flex",gap:10,alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:12,color:"#8a9aaa"}}>{userMeta.full_name||session.user.email}</span>
          {isAdmin&&<span style={S.tag("#ffd166")}>Admin</span>}
          {userMeta.centre&&<span style={S.tag("#3d5060")}>{userMeta.centre}</span>}
          <div style={{width:7,height:7,borderRadius:"50%",background:"#2dd4a0"}}/>
          <span style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:"#3d8c6e"}}>{activePairs.length} ACTIVE</span>
          <button onClick={()=>supabase.auth.signOut()} style={{...S.btn,padding:"5px 12px",background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa",fontSize:12}}>Sign Out</button>
        </div>
      </header>

      {/* Grid */}
      {view==="grid"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Compatibility Grid</h1>
          <p style={S.subtitle}>Click any cell for a full breakdown. ABO scores are blood-type only — add HLA data for full scoring.</p>
          <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
            <select value={filterBlood} onChange={e=>setFilterBlood(e.target.value)} style={{...S.select,width:140}}>
              <option value="all">All Blood Types</option>
              {["A","B","AB","O"].map(b=><option key={b}>{b}</option>)}
            </select>
            <select value={filterUrgency} onChange={e=>setFilterUrgency(e.target.value)} style={{...S.select,width:130}}>
              <option value="all">All Urgency</option>
              {["High","Medium","Low"].map(u=><option key={u}>{u}</option>)}
            </select>
            <div style={{marginLeft:"auto",display:"flex",gap:16,flexWrap:"wrap"}}>
              {[["Compatible","70+",80,false],["ABO Only","50-69",60,true],["Marginal","40-49",44,false],["Incompatible","<40",10,false]].map(([l,r,sc,ao])=>(
                <span key={l} style={{fontSize:11,color:"#8a9aaa",display:"flex",alignItems:"center",gap:5}}>
                  <span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:scoreStyle(sc,ao).bg}}/>
                  {l} ({r})
                </span>
              ))}
            </div>
          </div>
          {activePairs.filter(p=>p.donor_blood_type).length===0?(
            <div style={{textAlign:"center",padding:80,color:"#5a6a7a"}}>
              <div style={{fontSize:13,marginBottom:16}}>No active pairs with donors yet</div>
              <button onClick={()=>setView("add")} style={{...S.btn,background:"#2dd4a0",color:"#0a1a14"}}>Register First Pair</button>
            </div>
          ):(
            <div style={{overflowX:"auto",borderRadius:12,border:"1px solid #1a2530"}}>
              <table style={{borderCollapse:"collapse",width:"100%"}}>
                <thead>
                  <tr style={{background:"#0d1219"}}>
                    <th style={{padding:"12px 16px",textAlign:"left",fontSize:10,color:"#6a7a8a",fontFamily:"'DM Mono', monospace",letterSpacing:"0.08em",fontWeight:400,borderBottom:"1px solid #1a2530",borderRight:"1px solid #1a2530",minWidth:190}}>
                      RECIPIENT ↓ / DONOR →
                    </th>
                    {activePairs.filter(p=>p.donor_blood_type).map(p=>(
                      <th key={p.id} style={{padding:"10px 12px",textAlign:"center",borderBottom:"1px solid #1a2530",borderRight:"1px solid #1a2530",minWidth:90}}>
                        <div style={{fontSize:12,fontWeight:600,color:"#e8e4dc"}}>{(p.donor_name||"Altruistic").split(" ")[0]}</div>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#3d8c6e",marginTop:2}}>{p.donor_blood_type}</div>
                        {p.pair_type==="altruistic"&&<div style={{fontSize:9,color:"#ffd166",marginTop:1}}>ALT</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activePairs.filter(p=>p.recipient_blood_type)
                    .filter(p=>filterBlood==="all"||p.recipient_blood_type===filterBlood)
                    .filter(p=>filterUrgency==="all"||p.urgency===filterUrgency)
                    .map((recipient,ri)=>(
                    <tr key={recipient.id} style={{background:recipient.id===flash?"#0d2a1e":ri%2===0?"#0a0e14":"#0c1018",transition:"background 0.5s"}}>
                      <td style={{padding:"10px 16px",borderBottom:"1px solid #141c24",borderRight:"1px solid #1a2530"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <div style={{width:10,height:10,borderRadius:"50%",background:URGENCY_COLORS[recipient.urgency]||"#5a6a7a",flexShrink:0}} title={URGENCY_DEFS[recipient.urgency]}/>
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:"#e8e4dc"}}>{recipient.recipient_name}</div>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:"#8a9aaa",marginTop:2}}>
                              {recipient.recipient_blood_type} · PRA {recipient.recipient_pra_percent||"?"}%
                              {recipient.recipient_pra_percent>80&&<span style={{color:"#ff8a8a",marginLeft:4}}>HIGH</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      {activePairs.filter(p=>p.donor_blood_type).map(donor=>{
                        if(donor.id===recipient.id) return <td key={donor.id} style={{textAlign:"center",borderBottom:"1px solid #141c24",borderRight:"1px solid #141c24",background:"#0d1219",color:"#2a3a4a"}}>—</td>;
                        const result=calculateCompatibility(donor,recipient);
                        const s=scoreStyle(result.score,result.aboOnly);
                        const cellKey=`${donor.id}-${recipient.id}`;
                        return (
                          <td key={donor.id}
                            onMouseEnter={()=>setHoveredCell(cellKey)}
                            onMouseLeave={()=>setHoveredCell(null)}
                            onClick={()=>openDetail(donor,recipient)}
                            title={`ABO: ${result.reasons.abo?"✓":"✗"} | ${result.aboOnly?"ABO-only":"HLA MM: "+result.reasons.hlaMismatches} | ${s.label}`}
                            style={{textAlign:"center",cursor:"pointer",borderBottom:"1px solid #141c24",borderRight:"1px solid #141c24",background:hoveredCell===cellKey?s.bg:`${s.bg}99`,transition:"background 0.15s",padding:"10px 6px"}}>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:16,fontWeight:500,color:s.text,lineHeight:1}}>{result.score}</div>
                            <div style={{fontSize:9,color:`${s.text}99`,marginTop:3}}>{result.aboOnly?"ABO":`${result.reasons.hlaMismatches}MM`}</div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{marginTop:10,fontSize:11,color:"#3a4a5a",fontFamily:"'DM Mono', monospace"}}>
            MM = HLA mismatches · ABO = blood type only · ALT = altruistic donor · All matches require crossmatch confirmation
          </p>
        </div>
      )}

      {/* Registry */}
      {view==="registry"&&(
        <div style={S.page}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}>
            <div>
              <h1 style={S.pageTitle}>Registry</h1>
              <p style={{...S.subtitle,marginBottom:0}}>All entries — manage, edit, and export.</p>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={downloadTemplate} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Download Template</button>
              <label style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa",cursor:"pointer",display:"inline-flex",alignItems:"center"}}>
                {uploading?"Uploading…":"Bulk Upload CSV"}
                <input ref={fileRef} type="file" accept=".csv" onChange={handleFileSelect} style={{display:"none"}}/>
              </label>
              <button onClick={()=>exportRegistry(filteredPairs)} style={{...S.btn,background:"#1a2e24",color:"#2dd4a0"}}>Export CSV</button>
            </div>
          </div>

          {uploadResult&&(
            <div style={{marginBottom:16,padding:"10px 16px",borderRadius:8,background:uploadResult.success?"#0d2a1e":"#2a1010",border:`1px solid ${uploadResult.success?"#1a3028":"#3a1010"}`,color:uploadResult.success?"#2dd4a0":"#ff8a8a",fontSize:13}}>
              {uploadResult.message}
              <button onClick={()=>setUploadResult(null)} style={{marginLeft:12,background:"none",border:"none",color:"inherit",cursor:"pointer",fontSize:16}}>×</button>
            </div>
          )}

          {/* Filters */}
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            <input placeholder="Search by name…" value={search} onChange={e=>setSearch(e.target.value)} style={{...S.input,width:180}}/>
            <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{...S.select,width:150}}>
              <option value="all">All Status</option>
              {STATUS_OPTIONS.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
            <select value={filterUrgency} onChange={e=>setFilterUrgency(e.target.value)} style={{...S.select,width:120}}>
              <option value="all">All Urgency</option>
              {["High","Medium","Low"].map(u=><option key={u}>{u}</option>)}
            </select>
            <select value={filterBlood} onChange={e=>setFilterBlood(e.target.value)} style={{...S.select,width:130}}>
              <option value="all">All Blood Types</option>
              {["A","B","AB","O"].map(b=><option key={b}>{b}</option>)}
            </select>
            <select value={filterPairType} onChange={e=>setFilterPairType(e.target.value)} style={{...S.select,width:160}}>
              <option value="all">All Types</option>
              {PAIR_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {centres.length>0&&(
              <select value={filterCentre} onChange={e=>setFilterCentre(e.target.value)} style={{...S.select,width:150}}>
                <option value="all">All Centres</option>
                {centres.map(c=><option key={c}>{c}</option>)}
              </select>
            )}
            <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={{...S.select,width:180}}>
              <option value="date">Sort: Date Added</option>
              <option value="lastname">Sort: Last Name</option>
              <option value="urgency">Sort: Urgency</option>
              <option value="pra">Sort: PRA % (High First)</option>
              <option value="dialysis">Sort: Dialysis Date</option>
            </select>
            <button onClick={()=>setSortDir(d=>d==="desc"?"asc":"desc")} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa",padding:"9px 12px"}}>
              {sortDir==="desc"?"↓":"↑"}
            </button>
          </div>

          {/* Select all bar */}
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"#0d1219",borderRadius:8,marginBottom:8,border:"1px solid #1a2530"}}>
            <input type="checkbox" checked={selectedIds.size===filteredPairs.length&&filteredPairs.length>0} onChange={toggleSelectAll} style={{cursor:"pointer",width:16,height:16}}/>
            <span style={{fontSize:13,color:"#8a9aaa"}}>
              {selectedIds.size>0?`${selectedIds.size} of ${filteredPairs.length} selected`:`${filteredPairs.length} entries shown`}
            </span>
            {selectedIds.size>0&&(
              <button onClick={()=>setBulkDeleteConfirm(true)} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a",padding:"5px 14px",fontSize:12,marginLeft:"auto"}}>
                Delete Selected ({selectedIds.size})
              </button>
            )}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {filteredPairs.length===0&&<div style={{textAlign:"center",padding:40,color:"#5a6a7a",fontSize:13}}>No entries match your filters</div>}
            {filteredPairs.map(pair=>{
              const canEdit=pair.user_id===currentUserId||isAdmin;
              const donorPairs=activePairs.filter(p=>p.donor_blood_type);
              const matches=pair.recipient_blood_type?donorPairs.filter(d=>d.id!==pair.id).map(d=>({donor:d,result:calculateCompatibility(d,pair)})).sort((a,b)=>b.result.score-a.result.score):[];
              const best=matches[0]||null;
              const bs=best?scoreStyle(best.result.score,best.result.aboOnly):null;
              const dAge=calcAge(pair.donor_year_born),rAge=calcAge(pair.recipient_year_born);
              const isSelected=selectedIds.has(pair.id);
              return (
                <div key={pair.id} style={{...S.card,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",borderColor:isSelected?"#2dd4a066":"#1a2530",background:isSelected?"#0d1a14":"#0d1219"}}>
                  <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(pair.id)} style={{cursor:"pointer",width:16,height:16,flexShrink:0}}/>
                  <div style={{width:6,height:44,borderRadius:3,background:URGENCY_COLORS[pair.urgency]||"#3a4a5a",flexShrink:0}} title={pair.urgency}/>
                  <span style={S.tag("#4a5a6a")}>{pairTypeLabel(pair.pair_type)}</span>
                  <div style={{flex:1,minWidth:180}}>
                    {pair.recipient_name&&(
                      <>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontSize:14,fontWeight:600,color:"#e8e4dc"}}>{pair.recipient_name}</span>
                          {pair.recipient_blood_type&&<span style={S.tag("#3d8c6e")}>{pair.recipient_blood_type}</span>}
                          {pair.urgency==="High"&&<span style={S.tag("#ff8a8a")}>URGENT</span>}
                          {pair.recipient_pra_percent>80&&<span style={S.tag("#ff8a8a")}>HIGH PRA</span>}
                        </div>
                        <div style={{fontSize:12,color:"#8a9aaa"}}>
                          Recipient{rAge?` · Age ${rAge}`:""}
                          {pair.recipient_pra_percent?` · PRA ${pair.recipient_pra_percent}%`:""}
                          {pair.recipient_dialysis_start?` · Dialysis ${new Date(pair.recipient_dialysis_start).toLocaleDateString("en-US",{month:"short",year:"numeric"})}`:""}
                        </div>
                      </>
                    )}
                    {pair.donor_name&&(
                      <div style={{fontSize:12,color:"#6a7a8a",marginTop:pair.recipient_name?4:0}}>
                        Donor: <strong style={{color:"#c8d4dc"}}>{pair.donor_name}</strong>
                        {pair.donor_blood_type?` · ${pair.donor_blood_type}`:""}
                        {dAge?` · Age ${dAge}`:""}
                        {pair.donor_egfr?` · eGFR ${pair.donor_egfr}`:""}
                      </div>
                    )}
                    {(appMode==="national"||pair.centre)&&pair.centre&&(
                      <div style={{fontSize:11,color:"#4a5a6a",marginTop:3}}>{pair.centre}</div>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0,flexWrap:"wrap"}}>
                    {bs&&(
                      <button onClick={()=>setMatchDetail({donor:best.donor,recipient:pair,result:best.result})}
                        style={{textAlign:"center",padding:"6px 12px",borderRadius:8,background:`${bs.bg}99`,border:"none",cursor:"pointer"}}>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:18,color:bs.text,lineHeight:1}}>{best.result.score}</div>
                        <div style={{fontSize:9,color:`${bs.text}88`,marginTop:2}}>BEST MATCH</div>
                      </button>
                    )}
                    <select value={pair.status} onChange={e=>handleStatusChange(pair.id,e.target.value)} disabled={!canEdit}
                      style={{...S.select,width:170,fontSize:12,opacity:canEdit?1:0.4}}>
                      {STATUS_OPTIONS.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select>
                    {canEdit&&(
                      <>
                        <button onClick={()=>startEdit(pair)} style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa",padding:"6px 12px"}}>Edit</button>
                        <button onClick={()=>setDeleteConfirm(pair)} style={{...S.btn,background:"transparent",border:"1px solid #3a1010",color:"#ff8a8a",padding:"6px 12px"}}>Delete</button>
                      </>
                    )}
                  </div>
                  {pair.notes&&<div style={{width:"100%",fontSize:12,color:"#5a6a7a",borderTop:"1px solid #141c24",paddingTop:8,marginTop:4}}>📝 {pair.notes}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chains */}
      {view==="chains"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Chain Identification</h1>
          <p style={S.subtitle}>Compatible exchange chains across all active pairs. No length cap — updates automatically as new pairs are added.</p>
          {chains.length===0?(
            <div style={{textAlign:"center",padding:60,color:"#5a6a7a",fontSize:13}}>
              No compatible chains found yet — add incompatible pairs to identify exchange opportunities
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {chains.map((chain,ci)=>(
                <div key={ci} style={{...S.card,borderColor:chain.length>=4?"#2d6e8c":chain.length>=3?"#3d8c6e":"#1a2530"}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14,flexWrap:"wrap"}}>
                    <span style={S.tag(chain.length>=4?"#6ab4d0":chain.length>=3?"#2dd4a0":"#8a9aaa")}>{chain.length}-WAY CHAIN</span>
                    {chain.length>=4&&<span style={S.tag("#ffd166")}>COMPLEX EXCHANGE</span>}
                    {chain.some(c=>c.altruistic)&&<span style={S.tag("#ffd166")}>ALTRUISTIC TRIGGERED</span>}
                    <span style={{marginLeft:"auto",fontSize:11,color:"#8a9aaa",fontFamily:"'DM Mono', monospace"}}>
                      AVG SCORE: {Math.round(chain.reduce((s,c)=>s+c.score,0)/chain.length)}
                    </span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:6}}>
                    {chain.map((link,li)=>{
                      const s=scoreStyle(link.score,false);
                      return (
                        <div key={li} style={{display:"flex",alignItems:"center"}}>
                          <div style={{padding:"10px 14px",borderRadius:8,background:"#111820",border:"1px solid #1e2a34",minWidth:100}}>
                            <div style={{fontSize:12,fontWeight:600,color:"#6ab4d0"}}>
                              {link.donorName.split(" ")[0]}
                              <span style={{fontSize:10,color:"#3d8c6e",marginLeft:4}}>({link.donorBlood})</span>
                              {link.altruistic&&<span style={{fontSize:9,color:"#ffd166",marginLeft:4}}>ALT</span>}
                            </div>
                            <div style={{fontSize:10,color:"#5a6a7a",margin:"4px 0",textAlign:"center"}}>donates to</div>
                            <div style={{fontSize:12,fontWeight:600,color:"#6ad0a0"}}>
                              {link.recipientName?.split(" ")[0]||"—"}
                              <span style={{fontSize:10,color:"#3d8c6e",marginLeft:4}}>({link.recipientBlood})</span>
                            </div>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:s.text,marginTop:5,textAlign:"center"}}>
                              {link.score}
                            </div>
                          </div>
                          {li<chain.length-1&&<div style={{padding:"0 8px",color:"#2dd4a0",fontSize:20}}>→</div>}
                        </div>
                      );
                    })}
                    <div style={{padding:"0 8px",color:"#3d5060",fontSize:20}}>↩</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Dashboard */}
      {view==="dashboard"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Dashboard</h1>
          <p style={S.subtitle}>Registry overview and summary statistics</p>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:24}}>
            {[
              {label:"Total Entries",value:stats.total,color:"#8a9aaa"},
              {label:"Active",value:stats.active,color:"#2dd4a0"},
              {label:"High Urgency",value:stats.highUrgency,color:"#ff8a8a"},
              {label:"With Match",value:stats.withMatch,color:"#6effc6"},
              {label:"Altruistic Donors",value:stats.altruistic,color:"#ffd166"},
              {label:"Recipient Only",value:stats.recipientOnly,color:"#6ab4d0"},
              {label:"Completed",value:stats.completed,color:"#6ab4d0"},
              {label:"Withdrawn",value:stats.withdrawn,color:"#5a6a7a"},
              {label:"2-Way Chains",value:stats.chains2,color:"#2dd4a0"},
              {label:"3-Way Chains",value:stats.chains3,color:"#6ab4d0"},
              {label:"4+ Way Chains",value:stats.chainsLong,color:"#ffd166"},
            ].map(({label,value,color})=>(
              <div key={label} style={{...S.card,textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:30,fontWeight:500,color,lineHeight:1}}>{value}</div>
                <div style={{fontSize:11,color:"#6a7a8a",marginTop:6}}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div style={S.card}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.1em",marginBottom:14}}>RECIPIENT BLOOD TYPE — ACTIVE</div>
              {["A","B","AB","O"].map(bt=>{
                const count=activePairs.filter(p=>p.recipient_blood_type===bt).length;
                const pct=activePairs.length?Math.round((count/activePairs.length)*100):0;
                return (
                  <div key={bt} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:12}}>
                      <span style={{color:"#8a9aaa"}}>Type {bt}</span>
                      <span style={{fontFamily:"'DM Mono', monospace",color:"#e8e4dc"}}>{count} <span style={{color:"#5a6a7a"}}>({pct}%)</span></span>
                    </div>
                    <div style={{height:5,background:"#1a2530",borderRadius:2}}>
                      <div style={{height:"100%",width:`${pct}%`,background:"#2dd4a0",borderRadius:2}}/>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={S.card}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.1em",marginBottom:14}}>HIGH URGENCY — NO MATCH YET</div>
              {activePairs.filter(p=>p.urgency==="High"&&p.recipient_blood_type&&!activePairs.some(d=>d.id!==p.id&&d.donor_blood_type&&calculateCompatibility(d,p).score>=60)).length===0?(
                <div style={{fontSize:13,color:"#2dd4a0"}}>All high urgency recipients have at least one compatible match ✓</div>
              ):(
                activePairs.filter(p=>p.urgency==="High"&&p.recipient_blood_type&&!activePairs.some(d=>d.id!==p.id&&d.donor_blood_type&&calculateCompatibility(d,p).score>=60)).map(p=>(
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,fontSize:12}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:"#ff8a8a",flexShrink:0}}/>
                    <span style={{color:"#e8e4dc"}}>{p.recipient_name}</span>
                    <span style={{color:"#8a9aaa"}}>· {p.recipient_blood_type} · PRA {p.recipient_pra_percent||"?"}%</span>
                  </div>
                ))
              )}
            </div>
            {appMode==="national"&&centres.length>0&&(
              <div style={S.card}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.1em",marginBottom:14}}>ENTRIES BY CENTRE</div>
                {centres.map(c=>{
                  const count=pairs.filter(p=>p.centre===c).length;
                  const pct=pairs.length?Math.round((count/pairs.length)*100):0;
                  return (
                    <div key={c} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:12}}>
                        <span style={{color:"#8a9aaa"}}>{c}</span>
                        <span style={{fontFamily:"'DM Mono', monospace",color:"#e8e4dc"}}>{count}</span>
                      </div>
                      <div style={{height:5,background:"#1a2530",borderRadius:2}}>
                        <div style={{height:"100%",width:`${pct}%`,background:"#6ab4d0",borderRadius:2}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={S.card}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.1em",marginBottom:14}}>RECENT ENTRIES</div>
              {pairs.slice(0,6).map(p=>(
                <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,fontSize:12}}>
                  <span style={{color:"#c8d4dc"}}>{p.recipient_name||p.donor_name}</span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={S.tag(URGENCY_COLORS[p.urgency]||"#5a6a7a")}>{p.urgency}</span>
                    <span style={{color:"#3a4a5a",fontFamily:"'DM Mono', monospace",fontSize:11}}>
                      {p.created_at?new Date(p.created_at).toLocaleDateString():""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit */}
      {view==="add"&&(
        <div style={{...S.page,maxWidth:960}}>
          <h1 style={S.pageTitle}>{editingPair?"Edit Entry":"Register New Entry"}</h1>
          <p style={S.subtitle}>All entries are made by transplant coordinators on behalf of patients.</p>

          {!editingPair&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:24}}>
              {PAIR_TYPES.map(({value,label,desc})=>(
                <button key={value} onClick={()=>setForm(f=>({...f,pair_type:value}))}
                  style={{padding:16,borderRadius:10,border:`2px solid ${form.pair_type===value?"#2dd4a0":"#1a2530"}`,background:form.pair_type===value?"#0d2a1e":"#0d1219",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                  <div style={{fontSize:14,fontWeight:600,color:form.pair_type===value?"#2dd4a0":"#e8e4dc",marginBottom:4}}>{label}</div>
                  <div style={{fontSize:12,color:"#8a9aaa"}}>{desc}</div>
                </button>
              ))}
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:form.pair_type==="paired"?"1fr 1fr":"1fr",gap:20,marginBottom:20}}>
            {(form.pair_type==="paired"||form.pair_type==="recipient_only")&&(
              <div style={S.card}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
                  <div style={{width:3,height:18,borderRadius:2,background:"#3d8c6e"}}/>
                  <span style={{fontFamily:"'DM Serif Display', serif",fontSize:18,color:"#e8e4dc"}}>Recipient</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <Field label="Full Name *" value={form.recipient_name} onChange={v=>setForm(f=>({...f,recipient_name:v}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><label style={S.label}>BLOOD TYPE *</label>
                      <select value={form.recipient_blood_type} onChange={e=>setForm(f=>({...f,recipient_blood_type:e.target.value}))} style={S.select}>
                        {["A","B","AB","O"].map(o=><option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <Field label="Year Born *" type="number" placeholder="e.g. 1975" value={form.recipient_year_born} onChange={v=>setForm(f=>({...f,recipient_year_born:v}))}/>
                  </div>
                  <Field label="PRA %" type="number" placeholder="0–100" value={form.recipient_pra_percent} onChange={v=>setForm(f=>({...f,recipient_pra_percent:v}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <Field label="Weight (kg)" type="number" value={form.recipient_weight_kg} onChange={v=>setForm(f=>({...f,recipient_weight_kg:v}))}/>
                    <Field label="Height (cm)" type="number" value={form.recipient_height_cm} onChange={v=>setForm(f=>({...f,recipient_height_cm:v}))}/>
                  </div>
                  <div><label style={S.label}>CMV STATUS</label>
                    <select value={form.recipient_cmv} onChange={e=>setForm(f=>({...f,recipient_cmv:e.target.value}))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o=><option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div style={{borderTop:"1px solid #1a2530",paddingTop:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <label style={{...S.label,marginBottom:0}}>HLA TYPING <span style={{color:"#3a4a5a"}}>(optional)</span></label>
                      <button onClick={()=>setShowHLAAdvanced(v=>!v)} style={{background:"none",border:"none",color:"#3d8c6e",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace"}}>
                        {showHLAAdvanced?"▲ hide":"▼ individual fields"}
                      </button>
                    </div>
                    <Field label="HLA Notes (paste Epic output)" placeholder="e.g. A*02:01 A*24:02 B*07:02..." value={form.recipient_hla_notes} onChange={v=>setForm(f=>({...f,recipient_hla_notes:v}))}/>
                    {showHLAAdvanced&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:8}}>
                        {["A1","A2","B1","B2","DR1","DR2"].map(h=>(
                          <div key={h}><label style={{...S.label,fontSize:9}}>HLA-{h}</label>
                            <input value={form[`recipient_hla_${h.toLowerCase()}`]||""} onChange={e=>setForm(f=>({...f,[`recipient_hla_${h.toLowerCase()}`]:e.target.value}))}
                              style={{...S.input,padding:"6px 8px",fontSize:12,fontFamily:"'DM Mono', monospace"}}/>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <Field label="Dialysis Start Date" type="date" value={form.recipient_dialysis_start} onChange={v=>setForm(f=>({...f,recipient_dialysis_start:v}))}/>
                  <Field label="Prior Transplants" type="number" placeholder="0" value={form.recipient_prior_transplants} onChange={v=>setForm(f=>({...f,recipient_prior_transplants:v}))}/>
                  <Field label="Sensitisation History Notes" placeholder="Prior transplants, pregnancies, transfusions…" value={form.recipient_sensitisation_notes} onChange={v=>setForm(f=>({...f,recipient_sensitisation_notes:v}))}/>
                  <Field label="Crossmatch Virtual" placeholder="Negative / Positive / Pending" value={form.recipient_crossmatch_virtual} onChange={v=>setForm(f=>({...f,recipient_crossmatch_virtual:v}))}/>
                  <Field label="Crossmatch Physical/Lab" placeholder="Negative / Positive / Pending" value={form.recipient_crossmatch_physical} onChange={v=>setForm(f=>({...f,recipient_crossmatch_physical:v}))}/>
                  <Field label="ZIP Code" placeholder="e.g. 94109" value={form.recipient_zip} onChange={v=>setForm(f=>({...f,recipient_zip:v}))}/>
                </div>
              </div>
            )}
            {(form.pair_type==="paired"||form.pair_type==="altruistic")&&(
              <div style={S.card}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
                  <div style={{width:3,height:18,borderRadius:2,background:"#2d6e8c"}}/>
                  <span style={{fontFamily:"'DM Serif Display', serif",fontSize:18,color:"#e8e4dc"}}>{form.pair_type==="altruistic"?"Altruistic Donor":"Donor"}</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <Field label="Full Name *" value={form.donor_name} onChange={v=>setForm(f=>({...f,donor_name:v}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><label style={S.label}>BLOOD TYPE *</label>
                      <select value={form.donor_blood_type} onChange={e=>setForm(f=>({...f,donor_blood_type:e.target.value}))} style={S.select}>
                        {["A","B","AB","O"].map(o=><option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <Field label="Year Born *" type="number" placeholder="e.g. 1975" value={form.donor_year_born} onChange={v=>setForm(f=>({...f,donor_year_born:v}))}/>
                  </div>
                  <Field label="eGFR (mL/min)" type="number" value={form.donor_egfr} onChange={v=>setForm(f=>({...f,donor_egfr:v}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <Field label="Weight (kg)" type="number" value={form.donor_weight_kg} onChange={v=>setForm(f=>({...f,donor_weight_kg:v}))}/>
                    <Field label="Height (cm)" type="number" value={form.donor_height_cm} onChange={v=>setForm(f=>({...f,donor_height_cm:v}))}/>
                  </div>
                  <div><label style={S.label}>CMV STATUS</label>
                    <select value={form.donor_cmv} onChange={e=>setForm(f=>({...f,donor_cmv:e.target.value}))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o=><option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div style={{borderTop:"1px solid #1a2530",paddingTop:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <label style={{...S.label,marginBottom:0}}>HLA TYPING <span style={{color:"#3a4a5a"}}>(optional)</span></label>
                      <button onClick={()=>setShowHLAAdvanced(v=>!v)} style={{background:"none",border:"none",color:"#3d8c6e",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace"}}>
                        {showHLAAdvanced?"▲ hide":"▼ individual fields"}
                      </button>
                    </div>
                    <Field label="HLA Notes (paste Epic output)" placeholder="e.g. A*01 A*03 B*08 B*35..." value={form.donor_hla_notes} onChange={v=>setForm(f=>({...f,donor_hla_notes:v}))}/>
                    {showHLAAdvanced&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:8}}>
                        {["A1","A2","B1","B2","DR1","DR2"].map(h=>(
                          <div key={h}><label style={{...S.label,fontSize:9}}>HLA-{h}</label>
                            <input value={form[`donor_hla_${h.toLowerCase()}`]||""} onChange={e=>setForm(f=>({...f,[`donor_hla_${h.toLowerCase()}`]:e.target.value}))}
                              style={{...S.input,padding:"6px 8px",fontSize:12,fontFamily:"'DM Mono', monospace"}}/>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <input type="checkbox" id="backup" checked={form.donor_backup||false} onChange={e=>setForm(f=>({...f,donor_backup:e.target.checked}))}/>
                    <label htmlFor="backup" style={{fontSize:12,color:"#8a9aaa",cursor:"pointer"}}>Designated backup donor</label>
                  </div>
                  <Field label="ZIP Code" placeholder="e.g. 94109" value={form.donor_zip} onChange={v=>setForm(f=>({...f,donor_zip:v}))}/>
                </div>
              </div>
            )}
          </div>

          <div style={{...S.card,marginBottom:20}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              <div><label style={S.label}>URGENCY *</label>
                <select value={form.urgency} onChange={e=>setForm(f=>({...f,urgency:e.target.value}))} style={S.select}>
                  {["High","Medium","Low"].map(u=><option key={u} value={u}>{u} — {URGENCY_DEFS[u].split(".")[0]}</option>)}
                </select>
              </div>
              {form.pair_type==="paired"&&(
                <div><label style={S.label}>DONOR-RECIPIENT RELATIONSHIP</label>
                  <select value={form.recipient_relationship} onChange={e=>setForm(f=>({...f,recipient_relationship:e.target.value}))} style={S.select}>
                    {["","Spouse/Partner","Parent","Sibling","Child","Friend","Other"].map(r=><option key={r} value={r}>{r||"Select…"}</option>)}
                  </select>
                </div>
              )}
              <div><label style={S.label}>TRANSPLANT CENTRE</label>
                <input value={form.centre||userMeta.centre||""} onChange={e=>setForm(f=>({...f,centre:e.target.value}))} style={S.input} placeholder={userMeta.centre||"Your centre"}/>
              </div>
            </div>
            <div style={{marginTop:12}}>
              <label style={S.label}>CLINICAL NOTES</label>
              <textarea value={form.notes||""} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Any clinical context, flags, or coordinator notes…"
                style={{...S.input,minHeight:70,resize:"vertical"}}/>
            </div>
          </div>

          <div style={{display:"flex",gap:12}}>
            <button onClick={handleAdd} disabled={adding} style={{...S.btn,background:"#2dd4a0",color:"#0a1a14"}}>
              {adding?(editingPair?"Saving…":"Registering…"):(editingPair?"Save Changes":"Register")}
            </button>
            <button onClick={()=>{setView("grid");setEditingPair(null);setForm(emptyForm);}}
              style={{...S.btn,background:"transparent",border:"1px solid #1e2a34",color:"#8a9aaa"}}>Cancel</button>
          </div>
        </div>
      )}

      {/* Detail */}
      {view==="detail"&&selected&&(()=>{
        const{donor,recipient,result}=selected;
        const s=scoreStyle(result.score,result.aboOnly);
        const dAge=calcAge(donor.donor_year_born),rAge=calcAge(recipient.recipient_year_born);
        return (
          <div style={{...S.page,maxWidth:860}}>
            <button onClick={()=>setView("grid")} style={{background:"none",border:"none",color:"#3d8c6e",cursor:"pointer",fontFamily:"'DM Mono', monospace",fontSize:12,padding:0,marginBottom:24,letterSpacing:"0.05em"}}>← BACK TO GRID</button>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:28,flexWrap:"wrap",gap:16}}>
              <div>
                <h1 style={S.pageTitle}>Compatibility Report</h1>
                <p style={{margin:"4px 0 0",color:"#8a9aaa",fontSize:13}}>{donor.donor_name} → {recipient.recipient_name}</p>
                {result.aboOnly&&<p style={{margin:"4px 0 0",color:"#ffd166",fontSize:12}}>⚠ ABO-based score — add HLA data for full scoring</p>}
              </div>
              <div style={{textAlign:"center",padding:"14px 22px",borderRadius:12,background:s.bg,border:`1px solid ${s.text}33`}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:40,fontWeight:500,color:s.text,lineHeight:1}}>{result.score}</div>
                <div style={{fontSize:11,color:`${s.text}cc`,marginTop:4,letterSpacing:"0.1em"}}>{s.label.toUpperCase()}</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
              {[
                {label:"ABO Compatibility",value:result.reasons.abo?"Compatible":"Incompatible",ok:result.reasons.abo,detail:`${donor.donor_blood_type} → ${recipient.recipient_blood_type}`},
                {label:"HLA Mismatches",value:result.aboOnly?"Not entered":result.reasons.hlaMismatches+" / 6",ok:!result.aboOnly&&result.reasons.hlaMismatches<=2,warn:!result.aboOnly&&result.reasons.hlaMismatches<=4,detail:result.aboOnly?"Enter HLA data for full scoring":"0 = perfect · 6 = full mismatch"},
                {label:"PRA Sensitization",value:`${recipient.recipient_pra_percent||"?"}%`,ok:!result.reasons.highSensitization,detail:result.reasons.highSensitization?"Highly sensitized":"Acceptable level"},
                {label:"Size Compatibility",value:result.reasons.sizeMatch?"Acceptable":"Flag",ok:result.reasons.sizeMatch,detail:`Donor ${donor.donor_weight_kg||"?"}kg → Recipient ${recipient.recipient_weight_kg||"?"}kg`},
                {label:"CMV Risk",value:result.reasons.cmvRisk?"Risk Flagged":"Acceptable",ok:!result.reasons.cmvRisk,detail:`Donor ${donor.donor_cmv} / Recipient ${recipient.recipient_cmv}`},
                {label:"Age Gap",value:dAge&&rAge?`${result.reasons.ageDiff} yrs`:"Unknown",ok:!result.reasons.ageFlag,detail:`Donor ${dAge||"?"}y · Recipient ${rAge||"?"}y · >15yr gap flagged`},
                {label:"Donor eGFR",value:donor.donor_egfr?`${donor.donor_egfr} mL/min`:"Not recorded",ok:(donor.donor_egfr||0)>=60,detail:(donor.donor_egfr||0)>=60?"Adequate renal function":"Below 60 — review required"},
                {label:"Virtual Crossmatch",value:recipient.recipient_crossmatch_virtual||"Not recorded",ok:recipient.recipient_crossmatch_virtual==="Negative",detail:"Negative = compatible"},
              ].map(({label,value,ok,warn,detail})=>(
                <div key={label} style={{...S.card,borderColor:ok?"#1a3028":warn?"#2a2010":"#2a1010"}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:12,color:"#8a9aaa"}}>{label}</span>
                    <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:ok?"#2dd4a0":warn?"#ffd166":"#ff8a8a"}}>{value}</span>
                  </div>
                  <div style={{fontSize:11,color:"#5a6a7a",marginTop:5}}>{detail}</div>
                </div>
              ))}
            </div>
            <div style={{...S.card,marginBottom:16}}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.1em",marginBottom:12}}>HLA ALLELE COMPARISON</div>
              {(donor.donor_hla_notes||recipient.recipient_hla_notes)&&(
                <div style={{marginBottom:12,fontSize:12,color:"#8a9aaa"}}>
                  {donor.donor_hla_notes&&<div>Donor: <span style={{fontFamily:"'DM Mono', monospace",color:"#6ab4d0"}}>{donor.donor_hla_notes}</span></div>}
                  {recipient.recipient_hla_notes&&<div style={{marginTop:4}}>Recipient: <span style={{fontFamily:"'DM Mono', monospace",color:"#6ad0a0"}}>{recipient.recipient_hla_notes}</span></div>}
                </div>
              )}
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr>{["LOCUS","DONOR","RECIPIENT","MM"].map(h=><th key={h} style={{textAlign:h==="LOCUS"?"left":"center",padding:"6px 10px",fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",fontWeight:400}}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {["A","B","DR"].map(locus=>{
                    const dl=[donor[`donor_hla_${locus.toLowerCase()}1`],donor[`donor_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const rl=[recipient[`recipient_hla_${locus.toLowerCase()}1`],recipient[`recipient_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const mm=dl.filter(a=>!rl.includes(a)).length;
                    return (
                      <tr key={locus} style={{borderTop:"1px solid #141c24"}}>
                        <td style={{padding:"9px 10px",fontFamily:"'DM Mono', monospace",fontSize:12,color:"#8a9aaa"}}>HLA-{locus}</td>
                        <td style={{padding:"9px 10px",textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:12,color:"#6ab4d0"}}>{dl.join(" / ")||"—"}</td>
                        <td style={{padding:"9px 10px",textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:12,color:"#6ad0a0"}}>{rl.join(" / ")||"—"}</td>
                        <td style={{padding:"9px 10px",textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:12,color:mm===0?"#2dd4a0":mm===1?"#ffd166":"#ff8a8a"}}>{dl.length?`${mm} MM`:"—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:10,marginBottom:16}}>
              <button onClick={()=>window.print()} style={{...S.btn,background:"#1a2e24",color:"#2dd4a0"}}>Print Report</button>
            </div>
            <div style={{padding:"12px 16px",borderRadius:8,background:"#0d1a14",border:"1px solid #1a3028",fontSize:12,color:"#3d6a50"}}>
              ⚠ Compatibility scores are computational screens only. All matches require crossmatch confirmation before any clinical decision.
            </div>
          </div>
        );
      })()}
      <style>{`select option{background:#111820;color:#e8e4dc;}input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5);}@media print{header,nav{display:none!important;}}`}</style>
    </div>
  );
}