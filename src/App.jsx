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

// ── Pair Score Engine ──────────────────────────────────────────────────────
// PairPath "Pair Score" — a computational screening tool, NOT a validated
// clinical index. Score is 0–100 when full HLA data is present.
// When HLA data is missing, no numeric score is shown — only ABO status.
//
// Weighting rationale (⚠ REVISIT WITH TRANSPLANT PROFESSIONALS before clinical use):
//   Primary (60pts)  : HLA mismatches — 0MM=60, each MM costs 10pts, floor 0
//   Secondary (25pts): PRA sensitization — high PRA recipient who IS matched
//                      gets a BONUS (hardest match to find = most valuable).
//                      Unmatched high PRA costs 15pts vs low PRA baseline.
//   Modifiers (15pts): CMV D+/R- risk (-8), size mismatch >40kg (-4), age gap >15yr (-3)
//
// TODO: Validate weights against published KPD outcomes data.
// TODO: Consider dialysis vintage (time on dialysis) as a prioritization factor.
// TODO: Crossmatch result should override score entirely if available.
function calculateCompatibility(donor, recipient) {
  if (!donor?.donor_blood_type || !recipient?.recipient_blood_type) {
    return { compatible: false, score: null, aboOnly: true, reasons: {} };
  }

  const aboOk = checkABO(donor.donor_blood_type, recipient.recipient_blood_type);
  const hasHLA = !!(donor.donor_hla_a1 || donor.donor_hla_notes || recipient.recipient_hla_a1 || recipient.recipient_hla_notes);

  const hlaMismatches = hasHLA ? countHLAMismatches(donor, recipient) : 0;
  const pra = recipient.recipient_pra_percent || 0;
  const highPRA = pra > 80;
  const moderatePRA = pra > 50 && pra <= 80;
  const sizeDiff = Math.abs((cleanWeight(donor.donor_weight_kg) || 70) - (cleanWeight(recipient.recipient_weight_kg) || 70));
  const sizeOk = sizeDiff < 20;
  const cmvRisk = donor.donor_cmv === "Positive" && recipient.recipient_cmv === "Negative";
  const dAge = calcAge(donor.donor_year_born), rAge = calcAge(recipient.recipient_year_born);
  const ageDiff = dAge && rAge ? Math.abs(dAge - rAge) : 0;
  const ageFlag = ageDiff > 15;
  const bmi = donor.donor_weight_kg && donor.donor_height_cm
    ? donor.donor_weight_kg / Math.pow(donor.donor_height_cm / 100, 2) : null;
  const bmiFlag = bmi && bmi > 35;

  // No number shown without HLA — only ABO status
  if (!aboOk) {
    return {
      compatible: false, score: 0, aboOnly: !hasHLA,
      reasons: { abo: false, hlaMismatches: 0, highSensitization: highPRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff, pra }
    };
  }
  if (!hasHLA) {
    // ABO compatible but no HLA — return a capped score so grid stays colorful
    const aboScore = Math.max(0, 70 - (highPRA ? 15 : 0) - (sizeOk ? 0 : 4) - (cmvRisk ? 8 : 0) - (ageFlag ? 3 : 0));
    return {
      compatible: true, score: aboScore, aboOnly: true,
      reasons: { abo: true, hlaMismatches: 0, highSensitization: highPRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff, pra }
    };
  }

  // Full scored path — 0 to 100
  const hlaPoints = Math.max(0, 60 - hlaMismatches * 10);

  // PRA: high PRA recipient successfully matched = clinical win, award points
  const praPoints = highPRA ? 25 : moderatePRA ? 18 : 15;

  // O donor optimization:
  // O donors are universal but scarce — preserve them for O recipients who have no other options.
  // O→O: bonus (+5) — ideal use of an O donor
  // O→AB: penalty (-8) — AB recipients can receive from anyone, wasteful use of O donor
  // O→A or O→B: slight penalty (-3) — A/B recipients have other options (A→A, B→B etc.)
  // ⚠ TODO: revisit with transplant professionals — some programs use O donors freely
  const dBlood = donor.donor_blood_type;
  const rBlood = recipient.recipient_blood_type;
  const oDonorBonus  = dBlood==="O"&&rBlood==="O" ?  5 : 0;
  const oDonorPenalty= dBlood==="O"&&rBlood==="AB" ? -8 : dBlood==="O"&&(rBlood==="A"||rBlood==="B") ? -3 : 0;

  // Modifiers (deductions only)
  const cmvPenalty  = cmvRisk  ?  8 : 0;
  const sizePenalty = sizeOk   ?  0 : 4;
  const agePenalty  = ageFlag  ?  3 : 0;
  const bmiPenalty  = bmiFlag  ?  2 : 0;

  const score = Math.min(100, Math.max(0,
    hlaPoints + praPoints + oDonorBonus + oDonorPenalty - cmvPenalty - sizePenalty - agePenalty - bmiPenalty
  ));

  return {
    compatible: hlaMismatches <= 4,
    score,
    aboOnly: false,
    oDonorOptimized: dBlood==="O",
    oDonorIdeal: dBlood==="O"&&rBlood==="O",
    reasons: { abo: true, hlaMismatches, highSensitization: highPRA, moderatePRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff, pra, oDonorBonus, oDonorPenalty }
  };
}

// ── Chain Engine ───────────────────────────────────────────────────────────
function findChains(pairs) {
  const active = pairs.filter(p => p.status === "active");
  const MAX_RESULTS = 20;
  const MAX_DEPTH = 6;

  const donors = active.filter(p => p.donor_blood_type).map(p => ({
    id: `d-${p.id}`, pairId: p.id, blood: p.donor_blood_type,
    name: p.donor_name || "Altruistic Donor", weight: p.donor_weight_kg,
    cmv: p.donor_cmv, year: p.donor_year_born, pair_type: p.pair_type,
    // Altruistic = explicitly typed, or a donor with no paired recipient of their own
    isAltruistic: p.pair_type === "altruistic" || (!!p.donor_blood_type && !p.recipient_blood_type),
  }));

  const recipients = active.filter(p => p.recipient_blood_type).map(p => ({
    id: `r-${p.id}`, pairId: p.id, blood: p.recipient_blood_type,
    name: p.recipient_name, weight: p.recipient_weight_kg,
    cmv: p.recipient_cmv, pra: p.recipient_pra_percent, year: p.recipient_year_born,
  }));

  function score(donor, recipient) {
    if (!checkABO(donor.blood, recipient.blood)) return 0;
    const pra = recipient.pra || 0;
    const praPoints = pra > 80 ? 25 : pra > 50 ? 18 : 15;
    const sizeOk = Math.abs((donor.weight || 70) - (recipient.weight || 70)) < 20;
    const cmvRisk = donor.cmv === "Positive" && recipient.cmv === "Negative";
    return Math.max(0, Math.min(70, praPoints + 45 - (sizeOk ? 0 : 4) - (cmvRisk ? 8 : 0)));
  }

  const edges = new Map();
  donors.forEach(donor => {
    const matches = recipients
      .filter(r => r.pairId !== donor.pairId)
      .map(r => ({ recipient: r, score: score(donor, r) }))
      .filter(m => m.score >= 40)
      .sort((a,b) => b.score - a.score)
      .slice(0, 6);
    edges.set(donor.pairId, matches);
  });

  const donorByPair = new Map(donors.map(d => [d.pairId, d]));
  const allChains = [];

  function dfs(donor, usedPairs, chain) {
    if (allChains.length >= 200) return;
    const matches = edges.get(donor.pairId) || [];

    for (const { recipient, score: s } of matches) {
      if (allChains.length >= 200) return;
      if (usedPairs.has(recipient.pairId)) continue;

      const step = {
        donorName: donor.name,
        donorBlood: donor.blood,
        donorPairId: donor.pairId,
        recipientName: recipient.name,
        recipientBlood: recipient.blood,
        recipientPairId: recipient.pairId,
        score: s,
        altruistic: donor.isAltruistic
      };

      chain.push(step);

      // Altruistic-started chains are valid from a single edge (altruistic donor →
      // compatible recipient, e.g. a standalone recipient-only entry that ends the chain).
      // Paired-started chains still require ≥2 edges to be a meaningful exchange (existing logic).
      const minLen = chain[0].altruistic ? 1 : 2;
      if (chain.length >= minLen) {
        allChains.push([...chain]);
      }

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
    if (allChains.length >= 200) return;
    dfs(startDonor, new Set([startDonor.pairId]), []);
  });

  // Remove chains whose full donor sequence is a prefix of a longer chain —
  // i.e. suppress "Marcus→Patrick→Brigid→Carmen→David" if
  // "Marcus→Patrick→Brigid→Carmen→Sinead→X" already exists with the same 4 starts.
  // Key each chain by its ordered donor pair IDs.
  const donorSequence = chain => chain.map(c => c.donorPairId).join(',');
  // A chain is "terminal" (a complete exchange) when its last recipient has no onward
  // donor — i.e. a standalone recipient-only entry ends it. Terminal chains are never
  // truncations of a longer chain, so they must not be suppressed by the prefix filter.
  const isTerminal = chain => !donorByPair.has(chain[chain.length - 1].recipientPairId);

  // Keep only chains where no longer chain starts with the same donor sequence —
  // except terminal chains, which are complete and always kept.
  const filtered = allChains.filter(chain => {
    if (isTerminal(chain)) return true;
    const seq = donorSequence(chain);
    return !allChains.some(other =>
      other.length > chain.length &&
      donorSequence(other).startsWith(seq)
    );
  });

  // Deduplicate by donor sequence; terminal chains also key on their end recipient so
  // distinct standalone-recipient endings (e.g. an altruistic donor's options) aren't collapsed.
  const chainKey = chain => isTerminal(chain)
    ? donorSequence(chain) + '|end:' + chain[chain.length - 1].recipientPairId
    : donorSequence(chain);
  const seenSeqs = new Set();
  const deduped = filtered.filter(chain => {
    const seq = chainKey(chain);
    if (seenSeqs.has(seq)) return false;
    seenSeqs.add(seq);
    return true;
  });

  return deduped.sort((a,b) =>
    b.length - a.length ||
    b.reduce((sum,c)=>sum+c.score,0) - a.reduce((sum,c)=>sum+c.score,0)
  ).slice(0, MAX_RESULTS);
}

// ── Swap Engine ────────────────────────────────────────────────────────────
// A swap is a 2-way exchange between two incompatible pairs:
//   Leg 1: Pair A's donor → Pair B's recipient
//   Leg 2: Pair B's donor → Pair A's recipient
// Both legs must be ABO compatible. Only paired entries (donor + recipient in
// the same entry) participate. Combined score = average of the two leg scores.
const SWAP_STATUS_CYCLE = ["proposed","accepted","scheduled","completed"];
const SWAP_STATUS_COLORS = { proposed:"#6ab4d0", accepted:"#4db882", scheduled:"#ffd166", completed:"#90a4b4" };

// Confidence flags for a single leg, derived from a calculateCompatibility result.
function swapLegFlags(result){
  const r = result?.reasons || {};
  const flags = [];
  if(r.cmvRisk) flags.push("CMV D+/R-");
  if(r.sizeMatch===false) flags.push("Size gap");
  if(r.highSensitization) flags.push("High PRA");
  return flags;
}

function findSwaps(pairs) {
  // Eligible = active entries that are a true pair (have BOTH a donor and a recipient).
  const eligible = pairs.filter(p =>
    p.status === "active" &&
    (p.pair_type === "paired" || (p.donor_blood_type && p.recipient_blood_type)) &&
    p.donor_blood_type && p.recipient_blood_type
  );

  const swaps = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i], b = eligible[j];
      // Both legs must be ABO compatible to be a valid swap.
      if (!checkABO(a.donor_blood_type, b.recipient_blood_type)) continue; // Leg 1: A donor → B recip
      if (!checkABO(b.donor_blood_type, a.recipient_blood_type)) continue; // Leg 2: B donor → A recip
      const leg1 = calculateCompatibility(a, b); // A's donor vs B's recipient
      const leg2 = calculateCompatibility(b, a); // B's donor vs A's recipient
      const leg1Score = leg1.score ?? 0;
      const leg2Score = leg2.score ?? 0;
      swaps.push({
        id: `${a.id}_${b.id}`,
        pairA: a, pairB: b,
        leg1, leg2, leg1Score, leg2Score,
        combined: Math.round((leg1Score + leg2Score) / 2),
      });
    }
  }
  // Dedup is inherent (j starts at i+1, so A↔B is considered once). Sort by combined score.
  return swaps.sort((x, y) => y.combined - x.combined);
}

function exportSwaps(swaps, swapStatuses={}) {
  const flagStr = result => swapLegFlags(result).join("; ") || "None";
  const csvCell = v => { const s=String(v??""); return s.includes(",")?`"${s}"`:s; };
  const header = "Combined Score,Status,Pair A Donor,Pair A Donor Blood Type,Pair A Recipient,Pair A Recipient Blood Type,Leg 1 Score,Leg 1 Flags,Pair B Donor,Pair B Donor Blood Type,Pair B Recipient,Pair B Recipient Blood Type,Leg 2 Score,Leg 2 Flags";
  const lines = swaps.map(w => [
    w.combined,
    swapStatuses[w.id] || "none",
    w.pairA.donor_name || w.pairA.id,
    w.pairA.donor_blood_type,
    w.pairA.recipient_name || w.pairA.id,
    w.pairA.recipient_blood_type,
    w.leg1Score,
    flagStr(w.leg1),
    w.pairB.donor_name || w.pairB.id,
    w.pairB.donor_blood_type,
    w.pairB.recipient_name || w.pairB.id,
    w.pairB.recipient_blood_type,
    w.leg2Score,
    flagStr(w.leg2),
  ].map(csvCell).join(","));
  const disclaimer = [
    `PairPath Swap Analysis Export — Generated ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}`,
    `Combined Score = average of both leg Pair Scores (0-100). Each leg requires ABO compatibility. HLA mismatches drive 60% of each leg score (0MM=best). High PRA recipients score higher when matched — hardest to find, greatest clinical value. Size >20kg gap and CMV D+/R- flagged.`,
    `Flags columns: clinical risk factors worth discussing before crossmatch. All scores are computational screens — not clinically validated. All matches require crossmatch confirmation.`,
    ``,
  ].map(r=>`"${r}"`).join("\n");
  const blob = new Blob([[disclaimer,header,...lines].join("\n")],{type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="pairpath_swaps.csv"; a.click();
}

// ── Pair Score display helpers ─────────────────────────────────────────────
// Colors only. The five categories below are visually distinct; thresholds
// mirror the grid legend (75 / 55 / 35). No scoring logic or ceilings change here.
function scoreStyle(score, aboOnly) {
  if (aboOnly)     return { bg: "#0d2040", text: "#6ab4d0", label: "ABO Compatible" }; // ABO ok, no HLA — blue
  if (score >= 75) return { bg: "#0a4a32", text: "#4db882", label: "Strong" };         // green
  if (score >= 55) return { bg: "#3d3000", text: "#ffd166", label: "Good" };           // gold
  if (score >= 35) return { bg: "#2a2000", text: "#c8a84b", label: "Marginal" };       // amber
  if (score > 0)   return { bg: "#3a0808", text: "#ff6b6b", label: "Poor" };           // red
  return { bg: "#3a0808", text: "#ff6b6b", label: "Incompatible" };                    // ABO ✗ — red
}

const PAIR_TYPES = [
  { value: "paired", label: "Incompatible Pair", desc: "Recipient with a willing but incompatible donor" },
  { value: "altruistic", label: "Altruistic Donor", desc: "Willing donor with no paired recipient" },
  { value: "recipient_only", label: "Recipient Only", desc: "Recipient with no paired donor" },
];
const STATUS_OPTIONS = ["active","matched","surgery_scheduled","completed","withdrawn","on_hold","transferred"];
const statusLabel = s => s.replace(/_/g," ").replace(/\b\w/g, l => l.toUpperCase());
const NUMERIC_FIELDS = ["recipient_pra_percent","recipient_weight_kg","recipient_height_cm","donor_weight_kg","donor_height_cm","donor_egfr","recipient_prior_transplants"];
const DONOR_PRIORITIES = ["Primary","Secondary","Tertiary"];

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
  donor_priority:"Primary",
  status:"active", notes:"", centre:"",
};

// ── De-ID lookup workbook (.xlsx) ────────────────────────────────────────────
// Ensure SheetJS (XLSX) is loaded — reuses the same CDN build the xlsx import uses.
async function ensureXLSX(){
  if(!window.XLSX){
    await new Promise((res,rej)=>{
      const s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload=res;s.onerror=rej;document.head.appendChild(s);
    });
  }
  return window.XLSX;
}

const LOOKUP_INSTRUCTIONS = `HOW TO RE-IDENTIFY YOUR PAIRPATH MATCH EXPORT

You exported a match report from PairPath. The names show as D1, R1, etc.
This workbook tells you who each ID belongs to.

WHAT YOU NEED
- This workbook (PairPath_ID_Lookup.xlsx)
- Your match export file (pairpath_matches.csv)
- Microsoft Excel

STEP 1
Open your match export file (pairpath_matches.csv) in Excel.
You will see columns like Recipient, Donor with IDs like R1, D3.

STEP 2
Open this workbook. You are on the Instructions sheet.
Click the tab at the bottom that says "Lookup Table" to see all the names.

STEP 3
Go back to your match export. Click on the first empty column header
after your last column. Type "Recipient Name" as the header.

STEP 4
Click the cell below that header (first data row).
Type this formula exactly — replace B2 with the cell that contains your
first Recipient ID:

=VLOOKUP(B2,'[PairPath_ID_Lookup.xlsx]Lookup Table'!$A:$B,2,FALSE)

Press Enter. You will see the real name appear.

STEP 5
Click that cell again. Copy it (Ctrl+C).
Select all the cells below it in the same column (one per row of data).
Paste (Ctrl+V). All recipient names will fill in.

STEP 6
Repeat Steps 3-5 for the Donor column. Create a new column called
"Donor Name" and use the same VLOOKUP formula pointing to your Donor ID column.

STEP 7
Once all names are filled in, select BOTH new name columns.
Right-click → Copy. Then right-click again → Paste Special → Values.
This locks in the names so they no longer depend on the formula.

STEP 8
Save your file with a new name.
IMPORTANT: Never upload this re-identified file back into PairPath.
Real names must never enter the PairPath database.

NEED HELP?
If a cell shows #N/A it means that ID was not found in the lookup table.
Check that both files are open in Excel at the same time.`;

// Generate + download the PairPath ID lookup workbook (.xlsx) with two sheets:
//   "Lookup Table" — ID, Full Name, Role, populated with all anonymized names
//   "Instructions" — re-identification walkthrough (exact text above)
// entries: [{id, name, role}]. An empty list yields a blank lookup template.
async function generateLookupWorkbook(entries=[]){
  const XLSX=await ensureXLSX();
  const wb=XLSX.utils.book_new();
  const lookupAoa=[["ID","Full Name","Role"],...entries.map(e=>[e.id,e.name,e.role])];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(lookupAoa),"Lookup Table");
  const instrAoa=LOOKUP_INSTRUCTIONS.split("\n").map(line=>[line]);
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(instrAoa),"Instructions");
  XLSX.writeFile(wb,"PairPath_ID_Lookup.xlsx");
}

// "Download De-ID Template" button — blank lookup workbook (no names yet) + instructions.
function downloadDeIDTemplate(){ generateLookupWorkbook([]); }

function exportMatchCards(pairs) {
  const donors = pairs.filter(p=>p.donor_blood_type&&p.status!=="inactive");
  const recipients = pairs.filter(p=>p.recipient_blood_type&&p.status!=="inactive");

  const cards = recipients.map(recip=>{
    const matches = donors
      .filter(d=>d.id!==recip.id)
      .map(d=>({donor:d,result:calculateCompatibility(d,recip)}))
      .filter(m=>m.result.reasons.abo)
      .sort((a,b)=>(b.result.score||0)-(a.result.score||0));
    const best=matches[0]||null;
    const waitlistDays=recip.recipient_dialysis_start
      ?Math.floor((Date.now()-new Date(recip.recipient_dialysis_start))/86400000):null;
    const waitlistStr=waitlistDays
      ?(waitlistDays>365?`${Math.floor(waitlistDays/365)}yr ${Math.floor((waitlistDays%365)/30)}mo`:`${waitlistDays} days`)
      :"—";
    const pra=parseFloat(recip.recipient_pra_percent||0);
    const weightDiff=best&&best.donor.donor_weight_kg&&recip.recipient_weight_kg
      ?Math.abs((cleanWeight(best.donor.donor_weight_kg)||0)-(cleanWeight(recip.recipient_weight_kg)||0)):null;
    const score=best?.result.score;
    const scoreColor=score>=75?"#0a6e40":score>=55?"#1a5a1a":score>=35?"#6b4a00":"#6e0d0d";
    const scoreLabel=score>=75?"Strong":score>=55?"Good":score>=35?"Marginal":score!=null?"Poor":"ABO only";

    return `
      <div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:12px;page-break-inside:avoid;background:#fff">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:15px;font-weight:700;color:#111;margin-bottom:3px">${recip.recipient_name||"Unnamed"} <span style="font-size:12px;font-weight:400;color:#666">· ${recip.recipient_blood_type||"?"}</span></div>
            <div style="font-size:12px;color:#555;display:flex;gap:12px;flex-wrap:wrap">
              ${recip.recipient_pra_percent?`<span>PRA ${recip.recipient_pra_percent}%${pra>80?" ⚠":""}` :"<span>PRA —"}  </span>
              <span>Waitlist: ${waitlistStr}</span>
              ${recip.recipient_weight_kg?`<span>Weight: ${cleanWeight(recip.recipient_weight_kg)}kg</span>`:""}
            </div>
          </div>
          ${best?`<div style="text-align:center;padding:8px 16px;border-radius:6px;background:${scoreColor}22;border:1px solid ${scoreColor}44">
            <div style="font-size:24px;font-weight:700;color:${scoreColor};line-height:1">${score??"ABO"}</div>
            <div style="font-size:9px;color:${scoreColor};margin-top:2px">${scoreLabel.toUpperCase()}</div>
          </div>`:`<div style="padding:8px 14px;border-radius:6px;background:#fff0f0;border:1px solid #ffcccc;font-size:12px;color:#cc0000">No Match Found</div>`}
        </div>
        <div style="border-top:1px solid #eee;margin:10px 0"></div>
        ${best?`
          <div style="font-size:10px;color:#888;letter-spacing:0.05em;margin-bottom:5px">BEST COMPATIBLE DONOR</div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div>
              <span style="font-size:14px;font-weight:600;color:#222">${best.donor.donor_name||"—"}</span>
              <span style="font-size:12px;color:#666;margin-left:8px">· ${best.donor.donor_blood_type||"?"}${best.donor.donor_egfr?` · eGFR ${best.donor.donor_egfr}`:""}${weightDiff!=null?` · ${weightDiff}kg size diff`:""}</span>
            </div>
            ${matches.length>1?`<span style="font-size:11px;color:#888">+${matches.length-1} other compatible donor${matches.length>2?"s":""}</span>`:""}
          </div>
          ${pra>80?`<div style="margin-top:8px;font-size:11px;color:#c05000;font-style:italic">⚠ Highly sensitized recipient — this is a rare compatible match</div>`:""}
          ${best.result.aboOnly?`<div style="margin-top:6px;font-size:11px;color:#888">ABO compatible · HLA data not yet entered</div>`:""}
        `:`<div style="font-size:12px;color:#999;font-style:italic">No ABO-compatible donor currently in the registry.</div>`}
      </div>`;
  }).join("");

  const html=`<!DOCTYPE html><html><head><title>PairPath — Best Match Cards</title>
    <style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin-bottom:4px}p{color:#666;font-size:13px;margin-bottom:16px}@media print{body{margin:12px}}</style>
    </head><body>
    <h1>PairPath — Best Match Cards</h1>
    <p>Generated ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})} · ${recipients.length} recipients · Sorted by Pair Score, PRA, then waitlist time · All matches require crossmatch confirmation before any clinical decision.</p>
    ${cards}
    </body></html>`;

  const w=window.open("","_blank");
  w.document.write(html);
  w.document.close();
  w.print();
}

function exportRegistry(pairs) {
  if (!pairs.length) return;
  const UNIT_LABELS = {
    recipient_weight_kg:"recipient_weight_kg",donor_weight_kg:"donor_weight_kg",
    recipient_height_cm:"recipient_height_cm",donor_height_cm:"donor_height_cm",
    donor_egfr:"donor_egfr_ml_min",recipient_pra_percent:"recipient_pra_percent",
  };
  const keys = Object.keys(pairs[0]).filter(k=>!["id","user_id"].includes(k));
  const labeledKeys = keys.map(k=>UNIT_LABELS[k]||k);
  const rows = pairs.map(p=>keys.map(k=>{const v=p[k];return typeof v==="string"&&v.includes(",")?`"${v}"`:(v??'');}).join(","));
  const blob = new Blob([[labeledKeys.join(","),...rows].join("\n")],{type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="pairpath_export.csv"; a.click();
}

function exportMatches(pairs, level="standard") {
  const donors    = pairs.filter(p=>p.donor_blood_type&&p.status!=="inactive");
  const recipients= pairs.filter(p=>p.recipient_blood_type&&p.status!=="inactive");

  // Pre-compute waitlist rank across all recipients with a waitlist date
  const recipientsWithWaitlist = recipients
    .filter(p=>p.recipient_dialysis_start)
    .sort((a,b)=>new Date(a.recipient_dialysis_start)-new Date(b.recipient_dialysis_start));

  function waitlistDays(r){
    if(!r.recipient_dialysis_start) return null;
    return Math.floor((Date.now()-new Date(r.recipient_dialysis_start))/86400000);
  }
  function waitlistStr(r){
    const d=waitlistDays(r);
    if(!d) return "";
    if(d>365) return `${Math.floor(d/365)}yr ${Math.floor((d%365)/30)}mo`;
    return `${d} days`;
  }
  function waitlistRank(r){
    const idx=recipientsWithWaitlist.findIndex(p=>p.id===r.id);
    return idx>=0?`#${idx+1} of ${recipientsWithWaitlist.length}`:""
  }

  const rows = [];
  donors.forEach(donor=>{
    recipients.forEach(recipient=>{
      if(donor.id===recipient.id) return;
      const result = calculateCompatibility(donor, recipient);
      if(!result.reasons.abo) return;
      const cleanWt = v => { const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,""))); return (!isNaN(n)&&n>0&&n<400)?n:""; };
      const donorWt  = cleanWt(donor.donor_weight_kg);
      const recipWt  = cleanWt(recipient.recipient_weight_kg);
      const waitlist = recipient.recipient_dialysis_start
        ? new Date(recipient.recipient_dialysis_start).toLocaleDateString("en-US",{month:"2-digit",day:"2-digit",year:"numeric"}) : "";

      // CMV confidence flag
      const cmvFlag = donor.donor_cmv==="Positive"&&recipient.recipient_cmv==="Negative"?"⚠ CMV D+/R-":"";
      const sizeFlag = donorWt&&recipWt&&Math.abs(donorWt-recipWt)>20?"⚠ Size gap":"";
      const flags=[cmvFlag,sizeFlag].filter(Boolean).join("; ")||"None";

      rows.push({
        pair_score:       result.score ?? "ABO only",
        recipient:        recipient.recipient_name || recipient.id,
        recipient_blood:  recipient.recipient_blood_type,
        recipient_age:    calcAge(recipient.recipient_year_born)||"",
        pra:              recipient.recipient_pra_percent ?? "",
        waitlist_date:    waitlist,
        waitlist_duration:waitlistStr(recipient),
        waitlist_rank:    waitlistRank(recipient),
        recipient_weight: recipWt,
        donor:            donor.donor_name || donor.id,
        donor_blood:      donor.donor_blood_type,
        donor_age:        calcAge(donor.donor_year_born)||"",
        donor_weight:     donorWt,
        donor_height:     donor.donor_height_cm||"",
        recipient_height: recipient.recipient_height_cm||"",
        weight_gap_kg:    donorWt&&recipWt?Math.abs(donorWt-recipWt):"",
        flags,
        donor_egfr:       donor.donor_egfr||"",
        donor_cmv:        donor.donor_cmv||"",
        recipient_cmv:    recipient.recipient_cmv||"",
        hla_notes:        recipient.recipient_hla_notes||donor.donor_hla_notes||"",
      });
    });
  });
  rows.sort((a,b)=>(b.pair_score==="ABO only"?0:b.pair_score)-(a.pair_score==="ABO only"?0:a.pair_score));

  // Donor information always comes before recipient information (left to right).
  let header, lines;
  if(level==="quick"){
    header = "Pair Score,Donor,Donor Blood Type,Recipient,Recipient Blood Type,Recipient PRA%";
    lines  = rows.map(r=>[r.pair_score,r.donor,r.donor_blood,r.recipient,r.recipient_blood,r.pra].join(","));
  } else if(level==="full"){
    header = "Pair Score,Donor,Donor Blood Type,Donor Age,Donor Weight (kg),Donor Height (cm),Donor eGFR,Donor CMV,Recipient,Recipient Blood Type,Recipient Age,Recipient Weight (kg),Recipient Height (cm),Recipient PRA%,Waitlist Date,Recipient CMV,Weight Gap (kg),Flags,HLA Notes";
    lines  = rows.map(r=>[r.pair_score,r.donor,r.donor_blood,r.donor_age,r.donor_weight,r.donor_height,r.donor_egfr,r.donor_cmv,r.recipient,r.recipient_blood,r.recipient_age,r.recipient_weight,r.recipient_height,r.pra,r.waitlist_date,r.recipient_cmv,r.weight_gap_kg,r.flags,r.hla_notes].join(","));
  } else {
    header = "Pair Score,Donor,Donor Blood Type,Donor Age,Recipient,Recipient Blood Type,Recipient Age,Recipient PRA%,Waitlist Date,Weight Gap (kg),Flags";
    lines  = rows.map(r=>[r.pair_score,r.donor,r.donor_blood,r.donor_age,r.recipient,r.recipient_blood,r.recipient_age,r.pra,r.waitlist_date,r.weight_gap_kg,r.flags].join(","));
  }
  const disclaimer = [
    `PairPath Match Export — Generated ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}`,
    `Pair Score (0-100): ABO compatibility required. HLA mismatches drive 60% of score (0MM=best). High PRA recipients score higher when matched — hardest to find, greatest clinical value. Size >20kg gap and CMV D+/R- flagged. Waitlist rank = position among recipients with known waitlist dates in this registry.`,
    `Flags column: clinical risk factors worth discussing before crossmatch. All scores are computational screens — not clinically validated. All matches require crossmatch confirmation.`,
    ``,
  ].map(r=>`"${r}"`).join("\n");
  const blob = new Blob([[disclaimer,header,...lines].join("\n")],{type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`pairpath_matches_${level}.csv`; a.click();
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
    obj.status="active"; obj.pair_type=obj.pair_type||"paired";
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
  {key:"_recip_first",label:"Recipient First Name",required:false,types:["paired","recipient_only"]},
  {key:"_recip_last",label:"Recipient Last Name",required:false,types:["paired","recipient_only"]},
  {key:"recipient_blood_type",label:"Recipient Blood Type",required:true,types:["paired","recipient_only"]},
  {key:"recipient_year_born",label:"Recipient Year Born",required:false,types:["paired","recipient_only"]},
  {key:"recipient_pra_percent",label:"Recipient PRA %",required:false,types:["paired","recipient_only"]},
  {key:"recipient_weight_kg",label:"Recipient Weight (kg)",required:true,types:["paired","recipient_only"]},
  {key:"recipient_height_cm",label:"Recipient Height (cm)",required:true,types:["paired","recipient_only"]},
  {key:"recipient_cmv",label:"Recipient CMV",required:false,types:["paired","recipient_only"]},
  {key:"recipient_hla_notes",label:"Recipient HLA Notes",required:false,types:["paired","recipient_only"]},
  {key:"recipient_dialysis_start",label:"Recipient Waitlist Date",required:false,types:["paired","recipient_only"]},
  {key:"recipient_zip",label:"Recipient ZIP",required:false,types:["paired","recipient_only"]},
  {key:"donor_name",label:"Donor Name",required:true,types:["paired","altruistic"]},
  {key:"_donor_first",label:"Donor First Name",required:false,types:["paired","altruistic"]},
  {key:"_donor_last",label:"Donor Last Name",required:false,types:["paired","altruistic"]},
  {key:"donor_blood_type",label:"Donor Blood Type",required:true,types:["paired","altruistic"]},
  {key:"donor_year_born",label:"Donor Year Born",required:false,types:["paired","altruistic"]},
  {key:"donor_weight_kg",label:"Donor Weight (kg)",required:true,types:["paired","altruistic"]},
  {key:"donor_height_cm",label:"Donor Height (cm)",required:true,types:["paired","altruistic"]},
  {key:"donor_egfr",label:"Donor eGFR",required:false,types:["paired","altruistic"]},
  {key:"donor_cmv",label:"Donor CMV",required:false,types:["paired","altruistic"]},
  {key:"donor_hla_notes",label:"Donor HLA Notes",required:false,types:["paired","altruistic"]},
  {key:"donor_zip",label:"Donor ZIP",required:false,types:["paired","altruistic"]},
  {key:"notes",label:"Clinical Notes",required:false,types:["paired","altruistic","recipient_only"]},
  {key:"centre",label:"Centre",required:false,types:["paired","altruistic","recipient_only"]},
];

function autoDetect(headers, pairType="paired") {
  const mapping = {};
  const isDonorOnly = pairType === "altruistic";
  const isRecipOnly = pairType === "recipient_only";

  const rules = [
    // Recipient fields — skip if altruistic-only upload
    ...(!isDonorOnly?[
      {keys:["recipient_name","patient_name","pt_name"],field:"recipient_name"},
      {keys:["recipient_first","recip_first","patient_first","pt_first","first_name","firstname","r_first"],field:"_recip_first"},
      {keys:["recipient_last","recip_last","patient_last","pt_last","last_name","lastname","surname","r_last"],field:"_recip_last"},
      {keys:["recipient_blood_type","recipient_abo"],field:"recipient_blood_type"},
      {keys:["recipient_pra","pra","pra_percent","pra %"],field:"recipient_pra_percent"},
      {keys:["recipient_weight","weight_kg"],field:"recipient_weight_kg"},
      {keys:["recipient_height","height_cm"],field:"recipient_height_cm"},
      {keys:["recipient_dob","dob","date_of_birth","birth_date"],field:"recipient_year_born"},
      {keys:["recipient_cmv"],field:"recipient_cmv"},
      {keys:["recipient_hla","hla_notes"],field:"recipient_hla_notes"},
      {keys:["dialysis_start","dialysis start","unos","listing_date","waitlist_date"],field:"recipient_dialysis_start"},
    ]:[]),
    // Donor fields — skip if recipient-only upload
    ...(!isRecipOnly?[
      {keys:["donor_name","living_donor"],field:"donor_name"},
      {keys:["donor_first","ld_first","living_donor_first","d_first"],field:"_donor_first"},
      {keys:["donor_last","ld_last","living_donor_last","d_last"],field:"_donor_last"},
      {keys:["donor_blood_type","donor_abo"],field:"donor_blood_type"},
      {keys:["donor_egfr","egfr","gfr"],field:"donor_egfr"},
      {keys:["donor_weight"],field:"donor_weight_kg"},
      {keys:["donor_height"],field:"donor_height_cm"},
      {keys:["donor_cmv"],field:"donor_cmv"},
      {keys:["donor_dob"],field:"donor_year_born"},
    ]:[]),
    // Generic fields that could be either — map based on pairType
    {keys:["name","patient name","full name","pt name","ld patient name","ld name","living donor name"],field:isDonorOnly?"donor_name":"recipient_name"},
    {keys:["r patient name","recipient patient name","r name","waitlist patient name"],field:"recipient_name"},
    {keys:["abo","blood_type","blood type","abo type","blood group"],field:isDonorOnly?"donor_blood_type":"recipient_blood_type"},
    {keys:["weight"],field:isDonorOnly?"donor_weight_kg":"recipient_weight_kg"},
    {keys:["height"],field:isDonorOnly?"donor_height_cm":"recipient_height_cm"},
    {keys:["cmv"],field:isDonorOnly?"donor_cmv":"recipient_cmv"},
    {keys:["dob","date of birth","birth date","date_of_birth"],field:isDonorOnly?"donor_year_born":"recipient_year_born"},
    // Shared fields
    {keys:["notes","clinical_notes","comments"],field:"notes"},
    {keys:["centre","center","hospital","program"],field:"centre"},
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

// ── Weight display helper — always rounds to 1 decimal, handles floating point artifacts ──
function cleanWeight(v) {
  if(!v&&v!==0) return null;
  const n=parseFloat(String(v).replace(/[^\d.]/g,""));
  if(isNaN(n)||n<=0||n>400) return null;
  return Math.round(n*10)/10;
}
const S = {
  app: {minHeight:"100vh",width:"100%",background:"#131c26",color:"#ffffff",fontFamily:"'DM Sans', sans-serif",fontSize:14},
  header: {borderBottom:"1px solid #1e2d3d",padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:64,background:"#0a0f18",gap:12,width:"100%",boxSizing:"border-box"},
  navBtn: a => ({padding:"8px 16px",borderRadius:6,border:"none",cursor:"pointer",fontSize:14,fontWeight:600,background:a?"#0f2d1e":"transparent",color:a?"#4db882":"#c0cdd8",transition:"all 0.15s"}),
  page: {padding:"28px 32px",maxWidth:1400,margin:"0 auto"},
  pageTitle: {fontFamily:"'DM Sans', sans-serif",fontSize:28,fontWeight:700,margin:"0 0 6px",color:"#ffffff"},
  subtitle: {margin:"0 0 24px",color:"#c4d0d9",fontSize:14},
  card: {background:"#131c26",border:"1px solid #1e2d3d",borderRadius:12,padding:18},
  input: {width:"100%",boxSizing:"border-box",background:"#1a2535",border:"1px solid #2a3d52",borderRadius:6,padding:"10px 12px",color:"#ffffff",fontSize:14,fontFamily:"'DM Sans', sans-serif",outline:"none"},
  select: {width:"100%",background:"#1a2535",border:"1px solid #2a3d52",borderRadius:6,padding:"10px 12px",color:"#ffffff",fontSize:14,fontFamily:"'DM Sans', sans-serif",outline:"none",cursor:"pointer"},
  label: {fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",display:"block",marginBottom:5},
  btn: {padding:"10px 22px",borderRadius:7,border:"none",cursor:"pointer",fontFamily:"'DM Sans', sans-serif",fontWeight:600,fontSize:14,transition:"all 0.15s"},
  tag: c => ({fontSize:13,padding:"3px 9px",borderRadius:4,background:`${c}22`,color:c,fontFamily:"'DM Mono', monospace",letterSpacing:"0.05em"}),
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
function AuthScreen({onDemoMode}) {
  const [mode,setMode]=useState("login"); // login | signup | reset_sent | locked
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [name,setName]=useState("");
  const [centre,setCentre]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [locked,setLocked]=useState(false);
  const [agreed,setAgreed]=useState(false);

  const ConfidentialityBox=()=>(
    <div style={{padding:"12px 14px",borderRadius:8,background:"#f7f8fa",border:`1px solid ${agreed?"#a8d5b5":"#d0d8e4"}`,marginBottom:4,transition:"border-color 0.2s"}}>
      <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer"}}>
        <input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)}
          style={{marginTop:2,flexShrink:0,accentColor:"#1a6b45",width:15,height:15}}/>
        <span style={{fontSize:13,color:"#3a4f66",lineHeight:1.55}}>
          By accessing this demo, you agree that everything you see is confidential and proprietary to PairPath LLC.
        </span>
      </label>
    </div>
  );
  const [demoEntry,setDemoEntry]=useState(false);

  async function handleLogin(){
    setLoading(true);setError("");
    const{error}=await supabase.auth.signInWithPassword({email,password});
    if(error){
      if(error.message.toLowerCase().includes("locked")||error.message.toLowerCase().includes("too many")){setLocked(true);}
      else setError(error.message);
    }
    setLoading(false);
  }
  async function handleSignup(){
    if(!name||!centre){setError("Please enter your name and transplant center.");return;}
    setLoading(true);setError("");
    const{error}=await supabase.auth.signUp({email,password,options:{data:{full_name:name,centre}}});
    if(error)setError(error.message);
    else setSuccess("Account created! Check your email to confirm, then sign in.");
    setLoading(false);
  }
  async function handleReset(){
    if(!email){setError("Enter your email address first.");return;}
    setLoading(true);setError("");
    const{error}=await supabase.auth.resetPasswordForEmail(email);
    if(error)setError(error.message);
    else setMode("reset_sent");
    setLoading(false);
  }

  const LogoMark=({size=48,variant="dark"})=>(
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      {variant==="dark"?(
        <>
          <path d="M40 4 L4 40 L40 76 Z" fill="#4db882"/>
          <path d="M40 4 L76 40 L40 76 Z" fill="rgba(255,255,255,0.2)"/>
          <circle cx="40" cy="40" r="7" fill="#0f1c2e"/>
        </>
      ):(
        <>
          <path d="M40 4 L4 40 L40 76 Z" fill="#1a6b45"/>
          <path d="M40 4 L76 40 L40 76 Z" fill="#1e3448"/>
          <circle cx="40" cy="40" r="7" fill="white"/>
        </>
      )}
    </svg>
  );

  const inputStyle={width:"100%",boxSizing:"border-box",background:"#f7f8fa",border:`1px solid ${error&&!success?"#c0392b":"#d0d8e4"}`,borderRadius:7,padding:"11px 14px",color:"#1e3448",fontSize:14,fontFamily:"'DM Sans', sans-serif",outline:"none",marginBottom:2};
  const disabledInput={...inputStyle,opacity:0.5,cursor:"not-allowed"};

  return (
    <div style={{minHeight:"100vh",display:"flex",fontFamily:"'DM Sans', sans-serif"}}>
      {/* Left brand panel */}
      <div style={{flex:"0 0 45%",background:"#0f1c2e",display:"flex",flexDirection:"column",justifyContent:"space-between",padding:"48px 52px",minHeight:"100vh",boxSizing:"border-box"}}>
        {/* Logo */}
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <LogoMark size={40} variant="dark"/>
          <span style={{fontFamily:"'DM Sans', sans-serif",fontSize:22,letterSpacing:"-0.3px"}}>
            <span style={{fontWeight:700,color:"#ffffff"}}>Pair</span><span style={{fontWeight:300,color:"#4db882"}}>Path</span>
          </span>
        </div>

        {/* Hero copy */}
        <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",maxWidth:420}}>
          <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:36,lineHeight:1.25,color:"#ffffff",marginBottom:20}}>
            The match your{" "}
            <span style={{fontStyle:"italic",fontWeight:300,color:"#4db882"}}>EHR couldn't make.</span>
          </div>
          <div style={{fontSize:15,color:"#c4d0d9",lineHeight:1.7,marginBottom:40}}>
            Every willing donor. Every Listed Active recipient. Scored, ranked, and matched — across the exchanges your current workflow was never built to find.
          </div>

          {/* Stats */}
          <div style={{display:"flex",gap:32,marginBottom:48}}>
            {[["6-WAY","Max chain depth"],["0–100","Pair Score range"],["<1 min","Time to match"]].map(([val,label])=>(
              <div key={label}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:26,fontWeight:500,color:"#4db882",lineHeight:1}}>{val}</div>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",marginTop:4,letterSpacing:"0.08em"}}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom tagline */}
        <div style={{fontSize:13,color:"#c4d0d9",lineHeight:1.6,maxWidth:380,fontStyle:"italic"}}>
          Built independently, outside of institutional affiliation, by someone inside the transplant field — because this infrastructure should exist.
        </div>
      </div>

      {/* Right form panel */}
      <div style={{flex:1,background:"#ffffff",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"48px 40px",minHeight:"100vh",boxSizing:"border-box"}}>
        <div style={{width:"100%",maxWidth:400}}>
          {/* Visually hidden h1 for screen readers */}
          <h1 style={{position:"absolute",width:1,height:1,padding:0,margin:-1,overflow:"hidden",clip:"rect(0,0,0,0)",whiteSpace:"nowrap",border:0}}>PairPath — Kidney Paired Donation Registry</h1>
          {/* Logo */}
          <div style={{textAlign:"center",marginBottom:32}}>
            <LogoMark size={52} variant="light"/>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:28,fontWeight:700,letterSpacing:"-0.5px",marginTop:12,marginBottom:4}}>
              <span style={{color:"#1e3448"}}>Pair</span><span style={{color:"#4db882",fontWeight:300}}>Path</span>
            </div>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:14,fontWeight:400,color:"#1e3448"}}>
              Every exchange starts here.
            </div>
          </div>

          {/* Mode tabs — login vs signup */}
          {mode!=="reset_sent"&&(
            <div style={{display:"flex",gap:4,marginBottom:24,background:"#f2f0eb",borderRadius:8,padding:4}}>
              {[["login","Sign In"],["signup","Create Account"]].map(([m,l])=>(
                <button key={m} onClick={()=>{setMode(m);setError("");setSuccess("");setLocked(false);}} style={{flex:1,padding:"8px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:600,background:mode===m?"#ffffff":"transparent",color:mode===m?"#1e3448":"#3d5060",boxShadow:mode===m?"0 1px 4px rgba(0,0,0,0.08)":"none",transition:"all 0.15s"}}>{l}</button>
              ))}
            </div>
          )}

          {/* Banners */}
          {error&&!locked&&(
            <div style={{marginBottom:16,padding:"12px 14px",borderRadius:8,background:"#fef3cd",border:"1px solid #f0c040",color:"#7a5a00",fontSize:13}}>
              ⚠ {error}
            </div>
          )}
          {locked&&(
            <div style={{marginBottom:16,padding:"12px 14px",borderRadius:8,background:"#fef3cd",border:"1px solid #f0c040",color:"#7a5a00",fontSize:13}}>
              ⚠ Account temporarily locked due to too many attempts. Reset your password to regain access.
            </div>
          )}
          {success&&(
            <div style={{marginBottom:16,padding:"12px 14px",borderRadius:8,background:"#eafaf1",border:"1px solid #a8d5b5",color:"#4db882",fontSize:13}}>
              ✓ {success}
            </div>
          )}

          {/* Reset sent state */}
          {mode==="reset_sent"?(
            <div style={{textAlign:"center",padding:"24px 0"}}>
              <div style={{fontSize:40,marginBottom:12}}>✉️</div>
              <div style={{fontSize:16,fontWeight:600,color:"#1e3448",marginBottom:8}}>Reset email sent</div>
              <div style={{fontSize:13,color:"#b0bec8",lineHeight:1.6,marginBottom:24}}>
                We sent a reset link to <strong style={{color:"#1e3448"}}>{email}</strong>. The link expires in 30 minutes.
              </div>
              <button onClick={handleReset} disabled={loading} style={{background:"none",border:"1px solid #1a6b45",borderRadius:7,padding:"9px 20px",color:"#4db882",fontSize:13,cursor:"pointer",marginBottom:12,width:"100%"}}>
                {loading?"Sending…":"Resend reset email"}
              </button>
              <button onClick={()=>{setMode("login");setSuccess("");}} style={{background:"none",border:"none",color:"#b0bec8",fontSize:13,cursor:"pointer"}}>
                Back to sign in
              </button>
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {mode==="signup"&&(
                <>
                  <div><label htmlFor="signup-name" style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",display:"block",marginBottom:5}}>FULL NAME</label>
                  <input id="signup-name" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={locked?disabledInput:inputStyle} disabled={locked}/></div>
                  <div><label htmlFor="signup-center" style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",display:"block",marginBottom:5}}>TRANSPLANT CENTER</label>
                  <input id="signup-center" value={centre} onChange={e=>setCentre(e.target.value)} placeholder="Your transplant center" style={locked?disabledInput:inputStyle} disabled={locked}/></div>
                </>
              )}
              <div>
                <label htmlFor="login-email" style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",display:"block",marginBottom:5}}>EMAIL</label>
                <input id="login-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@hospital.org" style={locked||loading?disabledInput:inputStyle} disabled={locked||loading}/>
              </div>
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                  <label htmlFor="login-password" style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em"}}>PASSWORD</label>
                  {mode==="login"&&<button onClick={handleReset} disabled={loading||locked} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontSize:13,padding:0}}>Forgot password?</button>}
                </div>
                <input id="login-password" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" style={locked||loading?disabledInput:inputStyle} disabled={locked||loading}/>
              </div>

              {/* Confidentiality checkbox — required for signup and demo */}
              {(mode==="signup")&&<ConfidentialityBox/>}

              {/* Primary button */}
              <button
                onClick={mode==="login"?handleLogin:handleSignup}
                disabled={loading||locked||!email||!password||(mode==="signup"&&!agreed)}
                style={{background:locked?"#d0d8e4":"#1a6b45",color:locked?"#6a7a8a":"#ffffff",border:"none",borderRadius:7,padding:"12px",fontSize:14,fontWeight:600,cursor:(locked||(mode==="signup"&&!agreed))?"not-allowed":"pointer",width:"100%",marginTop:4,fontFamily:"'DM Sans', sans-serif",display:"flex",alignItems:"center",justifyContent:"center",gap:8,opacity:((!email||!password)||(mode==="signup"&&!agreed))&&!locked?0.5:1,transition:"all 0.15s"}}>
                {loading?(
                  <><span style={{display:"inline-block",width:14,height:14,border:"2px solid rgba(255,255,255,0.4)",borderTopColor:"#ffffff",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>Signing in…</>
                ):locked?"Account temporarily locked":error?"Try again":mode==="login"?"Sign in to PairPath":"Create Account"}
              </button>
              {locked&&(
                <button onClick={handleReset} style={{background:"none",border:"1px solid #1a6b45",borderRadius:7,padding:"10px",color:"#4db882",fontSize:13,fontWeight:600,cursor:"pointer",width:"100%",fontFamily:"'DM Sans', sans-serif"}}>
                  Reset my password
                </button>
              )}

              {/* Demo divider */}
              {mode==="login"&&!locked&&(
                <>
                  <div style={{display:"flex",alignItems:"center",gap:12,margin:"4px 0"}}>
                    <div style={{flex:1,height:1,background:"#e8ecf0"}}/>
                    <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#6a8899",letterSpacing:"0.08em"}}>NO ACCOUNT?</span>
                    <div style={{flex:1,height:1,background:"#e8ecf0"}}/>
                  </div>
                  <ConfidentialityBox/>
                  <button onClick={agreed?onDemoMode:null} style={{background:agreed?"#1e3448":"#e8ecf0",border:"2px solid #1e3448",borderRadius:7,padding:"11px",color:agreed?"#ffffff":"#5a6a7a",fontSize:13,fontWeight:600,cursor:agreed?"pointer":"not-allowed",width:"100%",fontFamily:"'DM Sans', sans-serif",transition:"all 0.2s"}}>
                    Explore Demo Mode
                  </button>
                </>
              )}
            </div>
          )}

          {/* Footer */}
          <div style={{marginTop:32,textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:13,color:"#6a8899",letterSpacing:"0.06em",lineHeight:1.8}}>
            pairpath.org · Independent clinical tool · Not yet clinically validated
          </div>
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:768px){.pp-left{display:none!important}}`}</style>
    </div>
  );
}

// ── CSV Field Mapper ───────────────────────────────────────────────────────
function CSVMapper({ headers, pairType, onConfirm, onCancel, preview, initialMapping, cancelLabel, inline=false }) {
  const [mapping, setMapping] = useState(() => initialMapping || autoDetect(headers, pairType));
  
  // Reset mapping when pairType changes so donor fields don't bleed into recipient-only
  useEffect(()=>{
    setMapping(initialMapping || autoDetect(headers, pairType));
  },[pairType]);

  const relevantFields = PAIRPATH_FIELDS.filter(f => f.types.includes(pairType));
  const requiredFields = relevantFields.filter(f => f.required);
  
  // Only count a required field as missing if it's relevant to this pair type.
  // Also drop cross-type fields by key prefix: recipient_only hides donor_*, altruistic hides recipient_*.
  const missingRequired = requiredFields.filter(f => {
    if(pairType==="recipient_only" && f.key.startsWith("donor_")) return false;
    if(pairType==="altruistic" && f.key.startsWith("recipient_")) return false;
    return !Object.values(mapping).includes(f.key);
  });
  
  // Clean mapping — remove any mapped fields not relevant to current pairType
  const cleanedMapping = Object.fromEntries(
    Object.entries(mapping).filter(([,v]) => !v || relevantFields.some(f=>f.key===v))
  );

  const inner = (
    <div style={inline?{}:{...S.card,maxWidth:700,width:"100%",maxHeight:"90vh",overflowY:"auto"}}>
      {!inline&&<div style={{fontFamily:"'DM Sans', sans-serif",fontSize:22,color:"#ffffff",marginBottom:4}}>Map Your Columns</div>}
      {!inline&&<p style={{fontSize:13,color:"#b0bec5",marginBottom:20}}>Match your spreadsheet columns to PairPath fields. Auto-detected matches are pre-filled.</p>}

      {preview?.length > 0 && (
        <div style={{marginBottom:20,padding:12,background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
          <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",marginBottom:8}}>FIRST ROW PREVIEW</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {headers.slice(0,6).map(h=>(
              <div key={h} style={{fontSize:13,color:"#b0bec5"}}>
                <span style={{color:"#c4d0d9"}}>{h}:</span> <span style={{color:"#ffffff"}}>{preview[0][h]||"—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:20}}>
        {headers.map(h => (
          <div key={h} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
            <div style={{flex:1,fontSize:13,color:"#c8d4dc",fontWeight:500}}>{h}</div>
            <div style={{fontSize:13,color:"#c4d0d9"}}>→</div>
            <select value={mapping[h]||""} onChange={e=>setMapping(m=>({...m,[h]:e.target.value||undefined}))}
              style={{...S.select,width:180,fontSize:13,padding:"5px 8px"}}>
              <option value="">Ignore this column</option>
              {relevantFields.map(f=>(
                <option key={f.key} value={f.key}>{f.label}{f.required?" *":""}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {missingRequired.length > 0 && (
        <div style={{padding:"10px 14px",borderRadius:8,background:"#1a2010",border:"1px solid #2a3010",color:"#ffd166",fontSize:13,marginBottom:16}}>
          ⚠ Heads up: {missingRequired.map(f=>f.label).join(", ")} not mapped — you can still import, those fields will be blank.
        </div>
      )}

      <div style={{display:"flex",gap:10}}>
        <button onClick={()=>onConfirm(cleanedMapping)}
          style={{...S.btn,background:"#1a6b45",color:"#ffffff"}}>
          Import with This Mapping
        </button>
        <button onClick={onCancel} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>
          {cancelLabel||"Cancel"}
        </button>
      </div>
    </div>
  );

  if(inline) return inner;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      {inner}
    </div>
  );
}

// ── Demo Data ──────────────────────────────────────────────────────────────
const DEMO_PAIRS = [
  {id:"d1",pair_type:"paired",status:"active",recipient_name:"R1",recipient_blood_type:"B",recipient_pra_percent:85,recipient_weight_kg:58,recipient_year_born:"1968",donor_name:"D1",donor_blood_type:"A",donor_weight_kg:82,donor_year_born:"1966",donor_egfr:72,centre:"Sutter CPMC",created_at:new Date(Date.now()-86400000*2).toISOString(),user_id:"demo"},
  {id:"d2",pair_type:"paired",status:"active",recipient_name:"R2",recipient_blood_type:"O",recipient_pra_percent:92,recipient_weight_kg:74,recipient_year_born:"1972",donor_name:"D2",donor_blood_type:"A",donor_weight_kg:68,donor_year_born:"1974",centre:"UCSF Medical Center",created_at:new Date(Date.now()-86400000*5).toISOString(),user_id:"demo"},
  {id:"d3",pair_type:"paired",status:"active",recipient_name:"R3",recipient_blood_type:"A",recipient_pra_percent:30,recipient_weight_kg:54,recipient_year_born:"1980",donor_name:"D3",donor_blood_type:"B",donor_weight_kg:79,donor_year_born:"1978",donor_egfr:88,centre:"Stanford Health",created_at:new Date(Date.now()-86400000*8).toISOString(),user_id:"demo"},
  {id:"d4",pair_type:"altruistic",status:"active",donor_name:"D4",donor_blood_type:"O",donor_weight_kg:77,donor_year_born:"1975",donor_egfr:95,donor_cmv:"Negative",centre:"Sutter CPMC",created_at:new Date(Date.now()-86400000*10).toISOString(),user_id:"demo"},
  {id:"d5",pair_type:"paired",status:"active",recipient_name:"R4",recipient_blood_type:"AB",recipient_pra_percent:15,recipient_weight_kg:61,recipient_year_born:"1985",donor_name:"D5",donor_blood_type:"O",donor_weight_kg:88,donor_year_born:"1983",donor_egfr:91,centre:"Kaiser Oakland",created_at:new Date(Date.now()-86400000*12).toISOString(),user_id:"demo"},
  {id:"d6",pair_type:"recipient_only",status:"active",recipient_name:"R5",recipient_blood_type:"O",recipient_pra_percent:98,recipient_weight_kg:52,recipient_year_born:"1965",centre:"UCSF Medical Center",created_at:new Date(Date.now()-86400000*14).toISOString(),user_id:"demo"},
  {id:"d7",pair_type:"paired",status:"active",recipient_name:"R6",recipient_blood_type:"A",recipient_pra_percent:10,recipient_weight_kg:83,recipient_year_born:"1990",donor_name:"D6",donor_blood_type:"A",donor_weight_kg:65,donor_year_born:"1988",donor_egfr:82,centre:"Stanford Health",created_at:new Date(Date.now()-86400000*18).toISOString(),user_id:"demo"},
  {id:"d8",pair_type:"paired",status:"matched",recipient_name:"R7",recipient_blood_type:"B",recipient_pra_percent:45,recipient_weight_kg:57,recipient_year_born:"1970",donor_name:"D7",donor_blood_type:"O",donor_weight_kg:81,donor_year_born:"1968",centre:"Kaiser Oakland",created_at:new Date(Date.now()-86400000*20).toISOString(),user_id:"demo"},
  // Paired entries tuned to form clean 2-way swaps in demo mode (D/R IDs only — anonymized).
  {id:"d9",pair_type:"paired",status:"active",recipient_name:"R8",recipient_blood_type:"A",recipient_pra_percent:62,recipient_weight_kg:55,recipient_year_born:"1976",recipient_cmv:"Negative",donor_name:"D8",donor_blood_type:"B",donor_weight_kg:78,donor_year_born:"1974",donor_egfr:84,donor_cmv:"Positive",centre:"Stanford Health",created_at:new Date(Date.now()-86400000*22).toISOString(),user_id:"demo"},
  {id:"d10",pair_type:"paired",status:"active",recipient_name:"R9",recipient_blood_type:"B",recipient_pra_percent:18,recipient_weight_kg:71,recipient_year_born:"1982",recipient_cmv:"Positive",donor_name:"D9",donor_blood_type:"A",donor_weight_kg:74,donor_year_born:"1980",donor_egfr:90,donor_cmv:"Negative",centre:"Sutter CPMC",created_at:new Date(Date.now()-86400000*24).toISOString(),user_id:"demo"},
  {id:"d11",pair_type:"paired",status:"active",recipient_name:"R10",recipient_blood_type:"O",recipient_pra_percent:88,recipient_weight_kg:60,recipient_year_born:"1969",recipient_cmv:"Negative",donor_name:"D10",donor_blood_type:"A",donor_weight_kg:65,donor_year_born:"1971",donor_egfr:79,donor_cmv:"Positive",centre:"UCSF Medical Center",created_at:new Date(Date.now()-86400000*26).toISOString(),user_id:"demo"},
  {id:"d12",pair_type:"paired",status:"active",recipient_name:"R11",recipient_blood_type:"A",recipient_pra_percent:40,recipient_weight_kg:95,recipient_year_born:"1987",recipient_cmv:"Negative",donor_name:"D11",donor_blood_type:"O",donor_weight_kg:70,donor_year_born:"1985",donor_egfr:93,donor_cmv:"Negative",centre:"Kaiser Oakland",created_at:new Date(Date.now()-86400000*28).toISOString(),user_id:"demo"},
];

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
  const [filterBlood,setFilterBlood]=useState("all");
  const [filterDonorBlood,setFilterDonorBlood]=useState("all");
  const [filterCentre,setFilterCentre]=useState("all");
  const [filterPairType,setFilterPairType]=useState("all");
  const [sortStack,setSortStack]=useState([{key:"date",dir:"desc"}]);
  const [unitSystem,setUnitSystem]=useState("metric");
  const [savedMappings,setSavedMappings]=useState(()=>{try{return JSON.parse(localStorage.getItem("pairpath_mappings")||"{}");}catch{return {};}});
  const [xlsxSheets,setXlsxSheets]=useState([]);
  const [xlsxResults,setXlsxResults]=useState([]);
  const [xlsxSummaryVisible,setXlsxSummaryVisible]=useState(false);
  const [showMatchExport,setShowMatchExport]=useState(false);
  const [nameWarning,setNameWarning]=useState(null);
  const [whatIfDonor,setWhatIfDonor]=useState(null);
  const [importHeightUnit,setImportHeightUnit]=useState("meters");
  const [importWeightUnit,setImportWeightUnit]=useState("kg"); // "metric" | "imperial"
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
  const [duplicateWarning,setDuplicateWarning]=useState(null);
  const [pendingInsert,setPendingInsert]=useState(null);
  const [demoMode,setDemoMode]=useState(false);
  const [auditLog,setAuditLog]=useState([]);
  const [showAudit,setShowAudit]=useState(false);
  const [chainsLoading,setChainsLoading]=useState(false);
  const [computedChains,setComputedChains]=useState([]);
  const [swapStatuses,setSwapStatuses]=useState(()=>{try{return JSON.parse(localStorage.getItem("pairpath_swap_statuses")||"{}");}catch{return {};}});
  const [swapFilter,setSwapFilter]=useState("");
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

  // ── Async chain computation (off main thread via setTimeout yield) ─────────
  useEffect(()=>{
    if(view!=="chains") return;
    setChainsLoading(true);
    const timeout=setTimeout(()=>{
      try{
        const vp=demoMode?DEMO_PAIRS:(pairs);
        const result=findChains(vp);
        setComputedChains(result);
      }catch(e){setComputedChains([]);}
      setChainsLoading(false);
    },0);
    return()=>clearTimeout(timeout);
  },[view,pairs,demoMode]);

  // Persist swap statuses across sessions.
  useEffect(()=>{try{localStorage.setItem("pairpath_swap_statuses",JSON.stringify(swapStatuses));}catch{}},[swapStatuses]);

  // Advance a swap through its lifecycle: none → proposed → accepted → scheduled → completed → none.
  function cycleSwapStatus(swapId){
    setSwapStatuses(prev=>{
      const idx=SWAP_STATUS_CYCLE.indexOf(prev[swapId]);
      const next=idx<0?SWAP_STATUS_CYCLE[0]:(idx>=SWAP_STATUS_CYCLE.length-1?null:SWAP_STATUS_CYCLE[idx+1]);
      const updated={...prev};
      if(next===null) delete updated[swapId]; else updated[swapId]=next;
      return updated;
    });
  }

  // Clear a swap's status back to unproposed.
  function resetSwapStatus(swapId){
    setSwapStatuses(prev=>{const updated={...prev};delete updated[swapId];return updated;});
  }

  if(authLoading) return <div style={{minHeight:"100vh",background:"#0d1219",display:"flex",alignItems:"center",justifyContent:"center",color:"#4db882",fontFamily:"'DM Mono', monospace",fontSize:13}}>Loading PairPath…</div>;
  if(!session&&!demoMode) return <AuthScreen onDemoMode={()=>setDemoMode(true)}/>;

  // Safety guard — if session exists but user data is malformed
  if(session&&!session.user) {
    supabase.auth.signOut();
    return <div style={{minHeight:"100vh",background:"#0d1219",display:"flex",alignItems:"center",justifyContent:"center",color:"#ff8a8a",fontFamily:"'DM Mono', monospace",fontSize:13}}>Session error — please sign in again</div>;
  }

  const currentUserId=session?.user?.id||"demo";
  const userMeta=session?.user?.user_metadata||{};
  const isAdmin=userMeta.role==="admin";
  const userEmail=session?.user?.email||"";
  const userDomain=userEmail.includes("@")?userEmail.split("@")[1].toLowerCase():"";
  // Special domains that shouldn't be used for grouping (personal emails)
  const PERSONAL_DOMAINS=["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","me.com","aol.com","protonmail.com","mail.com"];
  const hasCentreDomain=userDomain&&!PERSONAL_DOMAINS.includes(userDomain);
  // Centre grouping: if user has institutional email, show all data from same domain
  // If personal email, fall back to own data only
  const sameDomainPairs=hasCentreDomain
    ?pairs.filter(p=>{
        if(!p.user_email) return p.user_id===currentUserId; // legacy entries without email
        return p.user_email.toLowerCase().endsWith("@"+userDomain);
      })
    :pairs.filter(p=>p.user_id===currentUserId);
  // Demo mode overlays fake data. National shows everything (hidden for now).
  const visiblePairs=demoMode?DEMO_PAIRS:(appMode==="national"?pairs:(isAdmin?pairs:sameDomainPairs));
  const activePairs=visiblePairs.filter(p=>p.status==="active"||p.status==="active");

  function addAudit(action,detail){
    if(demoMode) return;
    setAuditLog(prev=>[{action,detail,user:userMeta.full_name||session?.user?.email||"Demo",time:new Date().toLocaleString(),id:Date.now()},...prev].slice(0,100));
  }
  const centres=[...new Set(visiblePairs.map(p=>p.centre).filter(Boolean))];

  const filteredPairs=visiblePairs.filter(p=>{
    if(filterStatus!=="all"&&p.status!==filterStatus) return false;
    if(filterBlood!=="all"&&p.recipient_blood_type!==filterBlood&&p.donor_blood_type!==filterBlood) return false;
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
    const donors=activePairs.filter(p=>p.donor_blood_type);
    function getVal(p,key){
      if(key==="date") return new Date(p.created_at).getTime();
      if(key==="lastname") return (p.recipient_name||p.donor_name||"").split(" ").pop().toLowerCase();
      if(key==="pra") return parseFloat(p.recipient_pra_percent||0);
      if(key==="dialysis") return new Date(p.recipient_dialysis_start||0).getTime();
      if(key==="score") return p.recipient_blood_type?Math.max(0,...donors.filter(d=>d.id!==p.id).map(d=>calculateCompatibility(d,p).score||0)):0;
      return 0;
    }
    for(const {key,dir} of sortStack){
      const va=getVal(a,key),vb=getVal(b,key);
      if(va===vb) continue;
      const cmp=typeof va==="string"?va.localeCompare(vb):(va>vb?1:-1);
      return dir==="desc"?-cmp:cmp;
    }
    return 0;
  });

  const chains=computedChains;
  // Swaps recompute inline (O(n²)) — consistent with stats/filteredPairs below.
  const swaps=findSwaps(visiblePairs);
  const filteredSwaps=swapFilter?swaps.filter(w=>swapStatuses[w.id]===swapFilter):swaps;
  const eligibleSwapPairs=visiblePairs.filter(p=>p.status==="active"&&(p.pair_type==="paired"||(p.donor_blood_type&&p.recipient_blood_type))&&p.donor_blood_type&&p.recipient_blood_type).length;
  const swapStats={
    total:swaps.length,
    avg:swaps.length?Math.round(swaps.reduce((s,w)=>s+w.combined,0)/swaps.length):0,
    proposed:swaps.filter(w=>swapStatuses[w.id]==="proposed").length,
    accepted:swaps.filter(w=>swapStatuses[w.id]==="accepted").length,
  };
  const stats={
    total:visiblePairs.length,active:activePairs.length,
    completed:visiblePairs.filter(p=>p.status==="completed").length,
    withdrawn:visiblePairs.filter(p=>p.status==="withdrawn").length,
    withMatch:activePairs.filter(p=>p.recipient_blood_type&&activePairs.some(d=>d.id!==p.id&&d.donor_blood_type&&calculateCompatibility(d,p).score>=60)).length,
    altruistic:visiblePairs.filter(p=>p.pair_type==="altruistic").length,
    recipientOnly:visiblePairs.filter(p=>p.pair_type==="recipient_only").length,
    chains2:chains.filter(c=>c.length===2).length,
    chains3:chains.filter(c=>c.length===3).length,
    chainsLong:chains.filter(c=>c.length>=4).length,
  };

  // ── Biometric identity matching ────────────────────────────────────────────
  // A patient is the same person if their clinical fingerprint matches:
  // blood type + birth year + weight (±2kg) + height (±2cm) + PRA (recipients)
  // Name/ID is NOT the identifier — two entries named D1 and D3 with same stats = same patient
  function biometricMatch(a, b, role="donor"){
    const prefix = role==="donor" ? "donor_" : "recipient_";
    // Blood type must match exactly
    const btA=a[`${prefix}blood_type`], btB=b[`${prefix}blood_type`];
    if(btA&&btB&&btA!==btB) return false;
    // Birth year must match if both present
    const yrA=String(a[`${prefix}year_born`]||"").trim();
    const yrB=String(b[`${prefix}year_born`]||"").trim();
    if(yrA&&yrB&&yrA!==yrB) return false;
    // Weight within 2kg tolerance
    const wtA=parseFloat(a[`${prefix}weight_kg`]||0);
    const wtB=parseFloat(b[`${prefix}weight_kg`]||0);
    if(wtA>0&&wtB>0&&Math.abs(wtA-wtB)>2) return false;
    // Height within 2cm tolerance
    const htA=parseFloat(a[`${prefix}height_cm`]||0);
    const htB=parseFloat(b[`${prefix}height_cm`]||0);
    if(htA>0&&htB>0&&Math.abs(htA-htB)>2) return false;
    // PRA within 2% for recipients
    if(role==="recipient"){
      const praA=parseFloat(a.recipient_pra_percent||"-1");
      const praB=parseFloat(b.recipient_pra_percent||"-1");
      if(praA>=0&&praB>=0&&Math.abs(praA-praB)>2) return false;
    }
    // Must have at least blood type OR year to make a match — avoid false positives on empty data
    const hasEnoughDataA=(btA||yrA||wtA||htA);
    const hasEnoughDataB=(btB||yrB||wtB||htB);
    return !!(hasEnoughDataA&&hasEnoughDataB);
  }

  function isDuplicate(f, excludeId=null){
    return pairs.some(p=>{
      if(excludeId&&p.id===excludeId) return false;
      const dName=(p.donor_name||"").trim().toLowerCase();
      const rName=(p.recipient_name||"").trim().toLowerCase();
      const fDName=(f.donor_name||"").trim().toLowerCase();
      const fRName=(f.recipient_name||"").trim().toLowerCase();

      if(f.pair_type==="altruistic"){
        // Same name → duplicate (name check)
        const sameName=dName&&dName===fDName;
        // OR same biometric fingerprint → duplicate even if different ID
        const sameBiometric=biometricMatch(p,f,"donor");
        return sameName||sameBiometric;
      }
      if(f.pair_type==="recipient_only"){
        const sameName=rName&&rName===fRName;
        const sameBiometric=biometricMatch(p,f,"recipient");
        return sameName||sameBiometric;
      }
      // Paired: check donor AND recipient independently
      const donorSame=(dName&&dName===fDName)||biometricMatch(p,f,"donor");
      const recipSame=(rName&&rName===fRName)||biometricMatch(p,f,"recipient");
      // Both must be the same for the pair to be a duplicate
      return donorSame&&recipSame;
    });
  }

  async function doInsert(insertData){
    if(editingPair){
      await supabase.from("pairs").update(insertData).eq("id",editingPair);
      addAudit("EDIT",`Edited ${insertData.recipient_name||insertData.donor_name}`);
      setEditingPair(null);
    } else {
      const{data,error}=await supabase.from("pairs").insert([insertData]).select();
      if(!error&&data){
        setFlash(data[0].id);setTimeout(()=>setFlash(null),2500);
        addAudit("ADD",`Added ${insertData.recipient_name||insertData.donor_name} (${insertData.pair_type})`);
      }
    }
    setForm(emptyForm);setView("grid");setAdding(false);setPendingInsert(null);
  }

  async function handleAdd(){
    if(demoMode){setFlash(null);alert("Demo mode is active — disable it to save real entries.");return;}
    const needsR=form.pair_type!=="altruistic",needsD=form.pair_type!=="recipient_only";
    if(needsR&&!form.recipient_name) return;
    if(needsD&&!form.donor_name) return;
    if(needsR&&!form.recipient_weight_kg){setFlash(null);alert("Recipient weight is required.");setAdding(false);return;}
    if(needsR&&!form.recipient_height_cm){setFlash(null);alert("Recipient height is required.");setAdding(false);return;}
    if(needsD&&!form.donor_weight_kg){setFlash(null);alert("Donor weight is required.");setAdding(false);return;}
    if(needsD&&!form.donor_height_cm){setFlash(null);alert("Donor height is required.");setAdding(false);return;}
    setAdding(true);
    const insertData={...form,status:form.status||"active",user_id:currentUserId,user_email:userEmail,donor_backup:form.donor_backup===true||form.donor_backup==="true"};
    NUMERIC_FIELDS.forEach(k=>{if(insertData[k]===""||insertData[k]===undefined)insertData[k]=null;});
    if(isDuplicate(form,editingPair||undefined)){
      setPendingInsert(insertData);setDuplicateWarning(form);setAdding(false);return;
    }
    await doInsert(insertData);
  }

  async function handleDelete(id){
    if(demoMode) return;
    const pair=pairs.find(p=>p.id===id);
    if(!pair) return;
    const pairDomain=pair.user_email?pair.user_email.split("@")[1]?.toLowerCase():"";
    const canDelete=isAdmin||(hasCentreDomain&&pairDomain===userDomain)||pair.user_id===currentUserId;
    if(!canDelete) return;
    await supabase.from("pairs").delete().eq("id",id);
    addAudit("DELETE",`Deleted ${pair.recipient_name||pair.donor_name}`);
    setDeleteConfirm(null);
  }

  async function handleBulkDelete(){
    if(demoMode) return;
    const idsToDelete=isAdmin
      ?[...selectedIds]
      :[...selectedIds].filter(id=>{
          const p=pairs.find(r=>r.id===id);
          if(!p) return false;
          const pairDomain=p.user_email?p.user_email.split("@")[1]?.toLowerCase():"";
          return (hasCentreDomain&&pairDomain===userDomain)||p.user_id===currentUserId;
        });
    const names=idsToDelete.map(id=>{const p=pairs.find(r=>r.id===id);return p?.recipient_name||p?.donor_name||id;});
    await Promise.all(idsToDelete.map(id=>supabase.from("pairs").delete().eq("id",id)));
    addAudit("BULK DELETE",`Deleted ${idsToDelete.length} entries: ${names.join(", ")}`);
    setSelectedIds(new Set());setBulkDeleteConfirm(false);
  }

  async function handleStatusChange(id,status){
    if(demoMode) return;
    const pair=pairs.find(p=>p.id===id);
    await supabase.from("pairs").update({status}).eq("id",id);
    addAudit("STATUS",`${pair?.recipient_name||pair?.donor_name} → ${status}`);
  }

  function openDetail(donor,recipient){const result=calculateCompatibility(donor,recipient);setSelected({donor,recipient,result});setView("detail");}

  function startEdit(pair){setForm({...emptyForm,...pair});setEditingPair(pair.id);setView("add");}

  function toggleSelect(id){setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});}
  function toggleSelectAll(){if(selectedIds.size===filteredPairs.length)setSelectedIds(new Set());else setSelectedIds(new Set(filteredPairs.map(p=>p.id)));}

  function handleFileSelect(e){
    const file=e.target.files[0];if(!file) return;
    e.target.value="";
    if(file.name.endsWith(".xlsx")||file.name.endsWith(".xls")){
      handleXlsxFile(file);
    } else {
      pendingFile.current=file;
      setShowUploadTypeSelect(true);
    }
  }

  async function handleXlsxFile(file){
    setUploading(true);
    try{
      // Dynamically load SheetJS
      if(!window.XLSX){
        await new Promise((res,rej)=>{
          const s=document.createElement("script");
          s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
          s.onload=res;s.onerror=rej;document.head.appendChild(s);
        });
      }
      const buf=await file.arrayBuffer();
      const wb=window.XLSX.read(buf,{type:"array"});
      const sheets=wb.SheetNames.map(name=>{
        const ws=wb.Sheets[name];
        const json=window.XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
        if(!json.length) return null;
        const headers=json[0].map(h=>String(h).trim()).filter(Boolean);
        if(!headers.length) return null;
        const dataRows=json.slice(1).filter(r=>r.some(c=>c!==""));
        const preview=dataRows.slice(0,3).map(row=>{
          const obj={};headers.forEach((h,i)=>{obj[h]=String(row[i]??"");});return obj;
        });
        const fingerprint=headers.slice().sort().join("|");
        return {name,headers,preview,dataRows,fingerprint};
      }).filter(Boolean);
      if(!sheets.length){setUploadResult({success:false,message:"No data found in workbook."});setUploading(false);return;}
      // Auto-anonymize EVERY sheet into ONE shared lookup before opening the mapper (no modal/choice).
      // Infer each sheet's type from its name so D/R prefixes are correct and the mapper defaults right:
      //   "Donors" sheet → altruistic (D prefix), "Recipients" sheet → recipient_only (R prefix).
      const anonCtx=makeAnonContext();
      const cleanedSheets=sheets.map(sheet=>{
        const sn=String(sheet.name).toLowerCase();
        const pairType = sn.includes("donor") ? "altruistic"
          : sn.includes("recipient") ? "recipient_only"
          : (sheet.pairType||"paired");
        const dataRows=anonymizeInto(sheet.headers, sheet.dataRows, pairType, anonCtx);
        const preview=dataRows.slice(0,3).map(row=>{
          const obj={};sheet.headers.forEach((h,i)=>{obj[h]=String(row[i]??"");});return obj;
        });
        return {...sheet, pairType, dataRows, preview};
      });
      const totalIds=anonCtx.donorNames.size+anonCtx.recipNames.size;
      if(totalIds>0){
        downloadCombinedLookup(anonCtx); // single combined file for the whole workbook
        setUploadResult({success:true, message:`⚠ ${totalIds} name${totalIds!==1?"s":""} detected and auto-anonymized into one combined lookup table — downloaded. Keep it private.`});
      }
      setXlsxSheets(cleanedSheets);
      setXlsxResults([]);
    }catch(err){setUploadResult({success:false,message:"Could not read Excel file: "+err.message});}
    setUploading(false);
  }

  // ── Name Detection ─────────────────────────────────────────────────────────
  const CLINICAL_VALUES=new Set(["positive","negative","unknown","active","inactive","matched","withdrawn","high","medium","low","pending","altruistic","paired","male","female","other","yes","no","true","false"]);

  function looksLikeRealName(val, columnHeader=""){
    if(!val) return false;
    const s=String(val).trim();
    if(s.length<3) return false;
    if(/\d/.test(s)) return false;
    if(CLINICAL_VALUES.has(s.toLowerCase())) return false;
    if(/^[A-Z]{1,2}$/.test(s)) return false; // blood types A, B, AB, O
    if(/^[A-Z]{1,3}\d*$/i.test(s)) return false; // D1, R23, AB style
    if(/[-_]/.test(s)&&s.length<8) return false;
    // Check column header suggests name field
    const hLower=columnHeader.toLowerCase();
    const isNameColumn=
      hLower.includes("name")||
      hLower.includes("patient")||
      hLower.includes("donor")||
      hLower.includes("living donor")||
      hLower.includes("living")||
      hLower.includes("recipient")||
      hLower.includes("subject")||
      hLower.includes("ld ")||
      hLower.startsWith("ld")||
      hLower.startsWith("r ") ||
      hLower==="r";
    if(!isNameColumn) return false;
    const hasSpace=/\s/.test(s);
    const isTitleCase=/^[A-Z][a-z]{2,}/.test(s);
    const isAllCapsName=/^[A-Z]{2,}(,\s*[A-Z]+|\s+[A-Z]{2,})/.test(s);
    return hasSpace||isTitleCase||isAllCapsName;
  }

  function detectRealNames(headers, rows){
    const flagged=new Set();
    rows.forEach(row=>{
      headers.forEach((h,i)=>{
        const val=Array.isArray(row)?row[i]:row[h];
        if(looksLikeRealName(val, h)) flagged.add(String(val).trim());
      });
    });
    return [...flagged];
  }

  // Shared anonymization context — lets one combined lookup span multiple sheets.
  function makeAnonContext(){ return {donorNames:new Map(), recipNames:new Map()}; }
  // Sequential per-role IDs (D1,D2… / R1,R2…) that continue across every sheet sharing the ctx.
  function anonIdFor(ctx, role, key){
    const map=role==="donor"?ctx.donorNames:ctx.recipNames;
    if(!map.has(key)) map.set(key,(role==="donor"?"D":"R")+(map.size+1));
    return map.get(key);
  }
  // Build + download ONE combined lookup workbook (.xlsx) for the whole context:
  // Sheet "Lookup Table" (ID, Full Name, Role) + Sheet "Instructions".
  function downloadCombinedLookup(ctx){
    const entries=[];
    ctx.donorNames.forEach((id,name)=>entries.push({id,name,role:"Donor"}));
    ctx.recipNames.forEach((id,name)=>entries.push({id,name,role:"Recipient"}));
    generateLookupWorkbook(entries);
  }
  // Anonymize one sheet's RAW header+row arrays into the shared ctx. Returns new rows; NO download.
  // Role is driven by pairType: altruistic→donor (D), recipient_only→recipient (R),
  // paired→decided per column from its header. Split first/last columns combine into ONE id per person.
  function anonymizeInto(headers, rows, pairType, ctx){
    const roleOf=(hl)=>{
      if(pairType==="altruistic") return "donor";
      if(pairType==="recipient_only") return "recipient";
      const isDonor=hl.includes("donor")||hl.includes("ld ")||hl.startsWith("ld")||
        hl.startsWith("d ")||hl.startsWith("d_");
      return isDonor?"donor":"recipient";
    };
    // Identify name columns by header — same predicate looksLikeRealName uses, plus first/last/surname
    const cols=headers.map((h,i)=>{
      const hl=String(h).toLowerCase();
      const isName=hl.includes("name")||hl.includes("patient")||hl.includes("donor")||
        hl.includes("recipient")||hl.includes("subject")||hl.includes("ld ")||
        hl.startsWith("ld")||hl.startsWith("r ")||hl==="r"||
        hl.includes("first")||hl.includes("last")||hl.includes("surname");
      if(!isName) return null;
      const part=hl.includes("first")?"first":(hl.includes("last")||hl.includes("surname")?"last":"full");
      return {index:i, header:h, role:roleOf(hl), part};
    }).filter(Boolean);
    const fullCols=cols.filter(c=>c.part==="full");
    const splitCols=cols.filter(c=>c.part!=="full");
    const getVal=(row,i,h)=>Array.isArray(row)?row[i]:row[h];
    const setVal=(row,i,h,v)=>{if(Array.isArray(row)){if(i>=0)row[i]=v;}else row[h]=v;};
    return rows.map(row=>{
      const newRow=Array.isArray(row)?[...row]:{...row};
      // Full-name columns — one ID per value
      fullCols.forEach(({index,header,role})=>{
        const val=getVal(row,index,header);
        if(!looksLikeRealName(val, header)) return;
        setVal(newRow,index,header, anonIdFor(ctx, role, String(val).trim()));
      });
      // Split first/last columns — combine per role into ONE ID, then blank the extra cells
      ["donor","recipient"].forEach(role=>{
        const fCols=splitCols.filter(c=>c.role===role&&c.part==="first");
        const lCols=splitCols.filter(c=>c.role===role&&c.part==="last");
        if(!fCols.length&&!lCols.length) return;
        const firstVal=fCols.map(c=>String(getVal(row,c.index,c.header)??"").trim()).filter(Boolean).join(" ");
        const lastVal=lCols.map(c=>String(getVal(row,c.index,c.header)??"").trim()).filter(Boolean).join(" ");
        const combined=[firstVal,lastVal].filter(Boolean).join(" ").trim();
        // Synthetic header guarantees the name-column gate; value checks do the real work
        if(!combined||!looksLikeRealName(combined, role==="donor"?"donor_name":"recipient_name")) return;
        const id=anonIdFor(ctx, role, combined);
        // Put the ID in the first column, blank the rest so concatenation yields just the ID
        [...fCols,...lCols].forEach((c,k)=> setVal(newRow,c.index,c.header, k===0?id:""));
      });
      return newRow;
    });
  }
  // CSV single-sheet path — anonymize one sheet and download its lookup immediately.
  function autoAnonymize(headers, rows, pairType){
    const ctx=makeAnonContext();
    const out=anonymizeInto(headers, rows, pairType, ctx);
    downloadCombinedLookup(ctx);
    return out;
  }

  async function processFileWithType(pairType){
    const file=pendingFile.current;if(!file) return;
    setShowUploadTypeSelect(false);setUploading(true);
    const text=await file.text();
    const[headerLine,...rows]=text.trim().split("\n");
    const headers=headerLine.split(",").map(h=>h.trim());

    // Pre-convert Excel serial dates in preview and data rows
    // Expanded range to catch all Excel date serials (1940-2100)
    function preConvertSerials(val){
      if(!val) return val;
      const s=String(val).trim();
      const n=parseFloat(s);
      if(!isNaN(n)&&n>14000&&n<80000&&Number.isInteger(n)&&!s.includes("/")){
        const date=new Date((n-25569)*86400000);
        return date.toISOString().split("T")[0];
      }
      return val;
    }

    const dataRows=rows.filter(r=>r.trim()).map(row=>
      row.split(",").map(v=>preConvertSerials(v.trim().replace(/^"|"$/g,"")))
    );
    const preview=dataRows.slice(0,3).map(row=>{
      const obj={};headers.forEach((h,i)=>{obj[h]=row[i]||"";});return obj;
    });

    // Rebuild text with converted values for downstream processing
    const convertedText=[headerLine,...dataRows.map(r=>r.join(","))].join("\n");

    // Name detection — auto-anonymize immediately, no option to proceed with real names
    const flagged=detectRealNames(headers,dataRows);
    if(flagged.length>0){
      // Silently auto-anonymize and download lookup table
      const anonymized=autoAnonymize(headers,dataRows,pairType);
      const newText=[headerLine,...anonymized.map(r=>r.join(","))].join("\n");
      const preview=anonymized.slice(0,3).map(row=>{
        const obj={};headers.forEach((h,i)=>{obj[h]=row[i]||"";});return obj;
      });
      // Show a non-blocking toast instead of a blocking modal
      setUploadResult({success:true,message:`⚠ ${flagged.length} name${flagged.length!==1?"s":""} detected and auto-anonymized. Your lookup table has been downloaded — keep it private.`});
      setCsvMapper({headers,pairType,preview,text:newText});
      setUploadPairType(pairType);
      setUploading(false);
      return;
    }

    setCsvMapper({headers,pairType,preview,text:convertedText});
    setUploadPairType(pairType);
    setUploading(false);
  }

  // ── Shared import row cleaner — applies to ALL import paths (CSV + xlsx) ──
  function cleanImportRow(obj, importHeightUnit="meters", importWeightUnit="kg") {
    // Strip unit characters from numeric fields — handles "75kg", "75 kg", "1.9m", "180 cm", "165 lbs"
    ["recipient_height_cm","donor_height_cm","recipient_weight_kg","donor_weight_kg",
     "donor_egfr","recipient_pra_percent","recipient_prior_transplants"].forEach(k=>{
      if(obj[k]!=null) obj[k]=String(obj[k]).replace(/[^\d.]/g,"").trim()||null;
    });
    NUMERIC_FIELDS.forEach(k=>{if(obj[k]===""||obj[k]===undefined)obj[k]=null;});
    // Height conversion
    ["recipient_height_cm","donor_height_cm"].forEach(k=>{
      if(!obj[k]) return;
      const val=parseFloat(obj[k]);
      if(isNaN(val)) return;
      if(importHeightUnit==="inches"){ obj[k]=Math.round(val*2.54); return; }
      const shouldConvert = importHeightUnit==="meters" || (importHeightUnit==="auto" && val < 3);
      if(shouldConvert) obj[k]=Math.round(val*100);
      else obj[k]=Math.round(val);
    });
    // Weight conversion — lbs to kg if needed
    ["recipient_weight_kg","donor_weight_kg"].forEach(k=>{
      if(!obj[k]) return;
      const val=parseFloat(obj[k]);
      if(isNaN(val)) return;
      if(importWeightUnit==="lbs") obj[k]=Math.round(val*0.453592*10)/10;
      else obj[k]=Math.round(val*10)/10;
    });
    // Validate blood types — strip Rh factor (+/-) first so AB+, A-, B+, O- become AB, A, B, O
    ["donor_blood_type","recipient_blood_type"].forEach(k=>{
      if(obj[k]!=null) obj[k]=String(obj[k]).toUpperCase().replace(/\s+/g,"").replace(/[+−-]|POS(?:ITIVE)?|NEG(?:ATIVE)?/g,"").trim();
    });
    if(!["A","B","AB","O"].includes(obj.donor_blood_type)) obj.donor_blood_type=null;
    if(!["A","B","AB","O"].includes(obj.recipient_blood_type)) obj.recipient_blood_type=null;
    // Validate CMV
    if(!["Positive","Negative","Unknown"].includes(obj.donor_cmv)) obj.donor_cmv="Unknown";
    if(!["Positive","Negative","Unknown"].includes(obj.recipient_cmv)) obj.recipient_cmv="Unknown";
    // ── Bulletproof year extractor ─────────────────────────────────────────
    // Handles: Excel serial (45950), ISO (1975-03-14), slash (03/14/1975),
    // plain year (1975), text with year, any format Epic might export
    function extractYearFromAnything(val){
      if(!val&&val!==0) return val;
      const s=String(val).trim();
      if(!s) return val;
      const n=parseFloat(s);
      // Excel serial date (days since 1900) — between 1900 and 2100 as serials
      if(!isNaN(n)&&n>20000&&n<80000){
        const date=new Date((n-25569)*86400000);
        return String(date.getUTCFullYear());
      }
      // Already a 4-digit year
      if(/^\d{4}$/.test(s)&&parseInt(s)>1900&&parseInt(s)<2100) return s;
      // ISO: 1975-03-14 or 2025-10-25
      if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,4);
      // MM/DD/YYYY or DD/MM/YYYY — take the 4-digit part
      const slashParts=s.split("/");
      const fourDigitPart=slashParts.find(p=>p.length===4&&parseInt(p)>1900);
      if(fourDigitPart) return fourDigitPart;
      // DD-Mon-YYYY like 14-Mar-1975
      const dashParts=s.split("-");
      const yearPart=dashParts.find(p=>p.length===4&&parseInt(p)>1900);
      if(yearPart) return yearPart;
      // Last resort — extract any 4-digit number that looks like a year
      const match=s.match(/\b(19|20)\d{2}\b/);
      if(match) return match[0];
      return val; // give up, return as-is
    }

    function extractISODate(val){
      if(!val&&val!==0) return val;
      const s=String(val).trim();
      if(!s) return val;
      const n=parseFloat(s);
      // Excel serial → ISO date
      if(!isNaN(n)&&n>20000&&n<80000){
        const date=new Date((n-25569)*86400000);
        return date.toISOString().split("T")[0];
      }
      // Already ISO
      if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
      // MM/DD/YYYY
      const slashParts=s.split("/");
      if(slashParts.length===3){
        const [m,d,y]=slashParts;
        if(y?.length===4) return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
      }
      return val;
    }
    obj.recipient_dialysis_start=extractISODate(obj.recipient_dialysis_start);
    obj.recipient_year_born=extractYearFromAnything(obj.recipient_year_born);
    obj.donor_year_born=extractYearFromAnything(obj.donor_year_born);
    return obj;
  }

  async function handleMappingConfirm(mapping, sheetContext=null){
    setUploading(true);

    // Save mapping keyed by column fingerprint for future reuse
    if(sheetContext?.fingerprint){
      const updated={...savedMappings,[sheetContext.fingerprint]:{mapping,pairType:sheetContext.pairType}};
      setSavedMappings(updated);
      try{localStorage.setItem("pairpath_mappings",JSON.stringify(updated));}catch{}
    }

    const source=sheetContext||csvMapper;
    const pairType=source.pairType;

    function processRows(headers, dataRows){
      return dataRows.filter(r=>r.some?.(c=>c!=="")).map(row=>{
        const vals=Array.isArray(row)?row:headers.map(h=>row[h]??"");
        const obj={pair_type:pairType,status:"active",donor_backup:false,user_id:currentUserId,user_email:userEmail};
        headers.forEach((h,i)=>{
          const field=mapping[h];
          if(field) obj[field]=String(vals[i]??"").trim();
        });
        // Concatenate split first/last names if the full name field wasn't mapped
        const mapped=Object.values(mapping);
        if(!mapped.includes("recipient_name")){
          const rn=[obj._recip_first,obj._recip_last].filter(Boolean).join(" ").trim();
          if(rn) obj.recipient_name=rn;
        }
        if(!mapped.includes("donor_name")){
          const dn=[obj._donor_first,obj._donor_last].filter(Boolean).join(" ").trim();
          if(dn) obj.donor_name=dn;
        }
        delete obj._recip_first; delete obj._recip_last;
        delete obj._donor_first; delete obj._donor_last;
        return cleanImportRow(obj, importHeightUnit, importWeightUnit);
      });
    }

    try{
      let headers, dataRows;
      if(sheetContext){
        headers=sheetContext.headers;
        dataRows=sheetContext.dataRows;
      } else {
        const[headerLine,...rows]=csvMapper.text.trim().split("\n");
        headers=headerLine.split(",").map(h=>h.trim());
        dataRows=rows.filter(r=>r.trim()).map(row=>row.split(",").map(v=>v.trim().replace(/^"|"$/g,"")));
      }

      const records=processRows(headers,dataRows);
      const dupes=records.filter(r=>isDuplicate(r));
      const clean=records.filter(r=>!isDuplicate(r));
      const{data,error}=await supabase.from("pairs").insert(clean).select();

      if(sheetContext){
        // Sheet queue mode — record result and advance to next sheet
        const result={sheetName:sheetContext.name,imported:data?.length??0,dupes:dupes.length,error:error?.message||null};
        setXlsxResults(prev=>{
          const updated=[...prev,result];
          return updated;
        });
        addAudit("BULK IMPORT",`Sheet "${sheetContext.name}": imported ${data?.length??0} entries`);
        // Advance queue — remove first sheet
        setXlsxSheets(prev=>{
          const remaining=prev.slice(1);
          if(!remaining.length) setXlsxSummaryVisible(true);
          return remaining;
        });
      } else {
        // CSV mode
        if(error)setUploadResult({success:false,message:error.message});
        else{
          addAudit("BULK IMPORT",`Imported ${data.length} entries via CSV`);
          setUploadResult({success:true,message:`${data.length} entries imported.${dupes.length>0?` ${dupes.length} duplicate(s) skipped.`:""}`});
        }
        setCsvMapper(null);
      }
    }catch(err){
      if(sheetContext){
        setXlsxResults(prev=>[...prev,{sheetName:sheetContext.name,imported:0,dupes:0,error:err.message}]);
        setXlsxSheets(prev=>{const remaining=prev.slice(1);if(!remaining.length)setXlsxSummaryVisible(true);return remaining;});
      } else {
        setUploadResult({success:false,message:"Import error — "+err.message});
        setCsvMapper(null);
      }
    }
    setUploading(false);
  }

  const pairTypeLabel=t=>PAIR_TYPES.find(p=>p.value===t)?.label||"Pair";

  return (
    <div style={S.app}>

      {/* Modals */}
      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:400,width:"90%",textAlign:"center"}}>
            <div style={{fontSize:16,color:"#ffffff",marginBottom:8}}>Delete this entry?</div>
            <div style={{fontSize:13,color:"#b0bec5",marginBottom:24}}>{deleteConfirm.recipient_name||deleteConfirm.donor_name} — this cannot be undone.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={()=>handleDelete(deleteConfirm.id)} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a"}}>Delete</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {bulkDeleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:400,width:"90%",textAlign:"center"}}>
            <div style={{fontSize:16,color:"#ffffff",marginBottom:8}}>Delete {selectedIds.size} entries?</div>
            <div style={{fontSize:13,color:"#b0bec5",marginBottom:24}}>This cannot be undone.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={handleBulkDelete} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a"}}>Delete All {selectedIds.size}</button>
              <button onClick={()=>setBulkDeleteConfirm(false)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {showUploadTypeSelect&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:500,width:"90%"}}>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:22,color:"#ffffff",marginBottom:8}}>What are you uploading?</div>
            <p style={{fontSize:13,color:"#b0bec5",marginBottom:20}}>Select the type so PairPath shows the right field mapping options.</p>
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
              {PAIR_TYPES.map(t=>(
                <button key={t.value} onClick={()=>processFileWithType(t.value)}
                  style={{padding:"14px 16px",borderRadius:10,border:"1px solid #1e2d3d",background:"#1a2535",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                  <div style={{fontSize:14,fontWeight:600,color:"#ffffff",marginBottom:3}}>{t.label}</div>
                  <div style={{fontSize:13,color:"#b0bec5"}}>{t.desc}</div>
                </button>
              ))}
            </div>
            {/* Height and weight unit toggles */}
            <div style={{marginBottom:16,padding:"12px 14px",background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
              <div style={{fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace",marginBottom:8}}>HEIGHT UNIT IN YOUR FILE</div>
              <div style={{display:"flex",gap:8,marginBottom:12}}>
                {[["meters","Meters (Epic default)"],["cm","Centimeters"],["inches","Inches"],["auto","Auto-detect"]].map(([val,label])=>(
                  <button key={val} onClick={()=>setImportHeightUnit(val)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,border:`1.5px solid ${importHeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                      background:importHeightUnit===val?"#0d2030":"transparent",
                      color:importHeightUnit===val?"#6ab4d0":"#90a4b4",
                      cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace"}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace",marginBottom:8}}>WEIGHT UNIT IN YOUR FILE</div>
              <div style={{display:"flex",gap:8}}>
                {[["kg","Kilograms (Epic default)"],["lbs","Pounds"]].map(([val,label])=>(
                  <button key={val} onClick={()=>setImportWeightUnit(val)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,border:`1.5px solid ${importWeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                      background:importWeightUnit===val?"#0d2030":"transparent",
                      color:importWeightUnit===val?"#6ab4d0":"#90a4b4",
                      cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace"}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{fontSize:13,color:"#b0bec8",marginTop:6}}>
                {importWeightUnit==="lbs"&&"Pounds will be converted to kg automatically"}
                {importWeightUnit==="kg"&&"Epic exports weight in kg — no conversion needed"}
              </div>
            </div>
            <button onClick={()=>setShowUploadTypeSelect(false)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Cancel</button>
          </div>
        </div>
      )}
      {csvMapper&&<CSVMapper headers={csvMapper.headers} pairType={csvMapper.pairType} preview={csvMapper.preview} onConfirm={handleMappingConfirm} onCancel={()=>setCsvMapper(null)}/>}

      {/* XLSX sheet-by-sheet mapper */}
      {xlsxSheets.length>0&&(()=>{
        const sheet=xlsxSheets[0];
        const savedForSheet=savedMappings[sheet.fingerprint];
        const autoMapping=savedForSheet?.mapping||autoDetect(sheet.headers, sheet.pairType||"paired");
        const knownMapping=!!savedForSheet;
        return(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:1000,overflowY:"auto",display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"40px 20px"}}>
            <div style={{...S.card,maxWidth:700,width:"100%"}}>
              {/* Sheet progress indicator */}
              <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
                {[...xlsxResults,...xlsxSheets].map((s,i)=>{
                  const done=i<xlsxResults.length;
                  const current=i===xlsxResults.length;
                  return(
                    <div key={i} style={{padding:"3px 10px",borderRadius:4,fontSize:13,fontFamily:"'DM Mono', monospace",
                      background:done?"#0d2a1e":current?"#1a2e3a":"#131c26",
                      color:done?"#2dd4a0":current?"#6ab4d0":"#6a8090",
                      border:`1px solid ${done?"#1a3028":current?"#1a3a5a":"#1e2d3d"}`}}>
                      {done?"✓ ":""}{"name" in s?s.name:`Sheet ${i+1}`}
                    </div>
                  );
                })}
              </div>

              <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:20,color:"#ffffff",marginBottom:4}}>
                Map columns — <span style={{color:"#6ab4d0"}}>{sheet.name}</span>
              </div>
              <div style={{fontSize:13,color:"#b0bec5",marginBottom:16}}>
                {xlsxResults.length+1} of {xlsxResults.length+xlsxSheets.length} sheets
                {knownMapping&&<span style={{color:"#4db882",marginLeft:8}}>✓ Saved mapping recognised — review and confirm</span>}
              </div>

              {/* Pair type selector for this sheet */}
              <div style={{marginBottom:16}}>
                <label style={S.label}>WHAT TYPE OF ENTRIES IS THIS SHEET?</label>
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  {PAIR_TYPES.map(pt=>(
                    <button key={pt.value}
                      onClick={()=>setXlsxSheets(prev=>{const n=[...prev];n[0]={...n[0],pairType:pt.value};return n;})}
                      style={{flex:1,padding:"7px 0",borderRadius:7,border:`1.5px solid ${(sheet.pairType||"paired")===pt.value?"#6ab4d0":"#1e2d3d"}`,
                        background:(sheet.pairType||"paired")===pt.value?"#0d2030":"#131c26",
                        color:(sheet.pairType||"paired")===pt.value?"#6ab4d0":"#90a4b4",cursor:"pointer",fontSize:13}}>
                      {pt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{marginBottom:12,padding:"10px 12px",background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
                <div style={{fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace",marginBottom:6}}>HEIGHT UNIT</div>
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  {[["meters","Meters (Epic)"],["cm","Centimeters"],["inches","Inches"],["auto","Auto"]].map(([val,label])=>(
                    <button key={val} onClick={()=>setImportHeightUnit(val)}
                      style={{flex:1,padding:"5px 0",borderRadius:5,border:`1px solid ${importHeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                        background:importHeightUnit===val?"#0d2030":"transparent",
                        color:importHeightUnit===val?"#6ab4d0":"#90a4b4",
                        cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace"}}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace",marginBottom:6}}>WEIGHT UNIT</div>
                <div style={{display:"flex",gap:6}}>
                  {[["kg","kg (Epic)"],["lbs","lbs"]].map(([val,label])=>(
                    <button key={val} onClick={()=>setImportWeightUnit(val)}
                      style={{flex:1,padding:"5px 0",borderRadius:5,border:`1px solid ${importWeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                        background:importWeightUnit===val?"#0d2030":"transparent",
                        color:importWeightUnit===val?"#6ab4d0":"#90a4b4",
                        cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace"}}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <CSVMapper
                headers={sheet.headers}
                pairType={sheet.pairType||"paired"}
                preview={sheet.preview}
                initialMapping={autoMapping}
                onConfirm={mapping=>handleMappingConfirm(mapping,{...sheet,pairType:sheet.pairType||"paired"})}
                onCancel={()=>{
                  // Skip this sheet, move to next
                  setXlsxResults(prev=>[...prev,{sheetName:sheet.name,imported:0,dupes:0,error:"Skipped"}]);
                  setXlsxSheets(prev=>{const r=prev.slice(1);if(!r.length)setXlsxSummaryVisible(true);return r;});
                }}
                cancelLabel="Skip Sheet"
              />
            </div>
          </div>
        );
      })()}

      {/* XLSX import summary */}
      {xlsxSummaryVisible&&xlsxResults.length>0&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:500,width:"90%"}}>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:22,color:"#ffffff",marginBottom:4}}>Import Complete</div>
            <div style={{fontSize:13,color:"#b0bec5",marginBottom:16}}>{xlsxResults.length} sheet{xlsxResults.length!==1?"s":""} processed</div>
            {xlsxResults.map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #141c24",fontSize:13}}>
                <span style={{color:"#c8d4dc",fontWeight:500}}>{r.sheetName}</span>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  {r.error&&r.error!=="Skipped"&&<span style={{color:"#ff8a8a",fontSize:13}}>{r.error}</span>}
                  {r.error==="Skipped"&&<span style={{color:"#c4d0d9",fontSize:13}}>Skipped</span>}
                  {!r.error&&<span style={{color:"#4db882",fontSize:13}}>{r.imported} imported</span>}
                  {r.dupes>0&&<span style={{color:"#ffd166",fontSize:13}}>{r.dupes} dupes skipped</span>}
                </div>
              </div>
            ))}
            <div style={{marginTop:16,display:"flex",justifyContent:"flex-end"}}>
              <button onClick={()=>{setXlsxSummaryVisible(false);setXlsxResults([]);}} style={{...S.btn,background:"#1a6b45",color:"#ffffff"}}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Export Matches Detail Level Modal */}
      {showMatchExport&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:480,width:"90%"}}>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:20,fontWeight:700,color:"#ffffff",marginBottom:6}}>Export Matches</div>
            <p style={{fontSize:13,color:"#b0bec5",marginBottom:20}}>Choose how much detail to include. All versions are sorted by Pair Score.</p>
            {[
              {level:"quick",label:"Quick View",desc:"Score · Names · Blood Types · PRA%","cols":"6 columns — for a fast first look in a meeting"},
              {level:"standard",label:"Standard",desc:"+ Age · Waitlist Date · Weights · Weight Gap","cols":"12 columns — recommended for most presentations"},
              {level:"full",label:"Full Clinical",desc:"+ eGFR · CMV (donor & recipient) · HLA Notes","cols":"17 columns — for detailed clinical review"},
            ].map(({level,label,desc,cols})=>(
              <button key={level} onClick={()=>{exportMatches(visiblePairs,level);setShowMatchExport(false);}}
                style={{width:"100%",textAlign:"left",padding:"14px 16px",borderRadius:10,border:"1px solid #1e2d3d",background:"#1a2535",cursor:"pointer",marginBottom:8,transition:"all 0.15s"}}>
                <div style={{fontSize:14,fontWeight:600,color:"#ffffff",marginBottom:3}}>{label}</div>
                <div style={{fontSize:13,color:"#6ab4d0",marginBottom:3}}>{desc}</div>
                <div style={{fontSize:13,color:"#b0bec8",fontFamily:"'DM Mono', monospace"}}>{cols}</div>
              </button>
            ))}
            <button onClick={()=>setShowMatchExport(false)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",width:"100%",marginTop:4}}>Cancel</button>
          </div>
        </div>
      )}

      {/* Duplicate Warning Modal */}
      {duplicateWarning&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:480,width:"90%",textAlign:"center"}}>
            <div style={{fontSize:22,marginBottom:8}}>⚠️</div>
            <div style={{fontSize:16,color:"#ffd166",marginBottom:8}}>Possible Duplicate Detected</div>
            <div style={{fontSize:13,color:"#b0bec5",marginBottom:6}}>
              An entry in the registry matches this patient's clinical profile — blood type, birth year, weight, and height are the same or very close. The ID doesn't have to match.
            </div>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#ffffff",padding:"8px 12px",background:"#1a2535",borderRadius:6,marginBottom:20}}>
              {duplicateWarning.donor_name||"—"} / {duplicateWarning.recipient_name||"—"}
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={async()=>{setDuplicateWarning(null);setAdding(true);await doInsert(pendingInsert);}}
                style={{...S.btn,background:"#6b4a00",color:"#ffd166"}}>Save Anyway</button>
              <button onClick={()=>{setDuplicateWarning(null);setPendingInsert(null);setAdding(false);}}
                style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Audit Log Panel (admin only) */}
      {showAudit&&isAdmin&&(
        <div style={{position:"fixed",top:60,right:0,bottom:0,width:380,background:"#131c26",borderLeft:"1px solid #1e2d3d",zIndex:500,overflowY:"auto",padding:20}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",letterSpacing:"0.1em"}}>AUDIT LOG</div>
            <button onClick={()=>setShowAudit(false)} style={{background:"none",border:"none",color:"#b0bec5",cursor:"pointer",fontSize:18}}>×</button>
          </div>
          {auditLog.length===0?(
            <div style={{fontSize:13,color:"#b0bec8"}}>No actions logged this session.</div>
          ):(
            auditLog.map(entry=>(
              <div key={entry.id} style={{borderTop:"1px solid #141c24",paddingTop:10,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{...S.tag(entry.action==="DELETE"||entry.action==="BULK DELETE"?"#ff8a8a":entry.action==="ADD"||entry.action==="BULK IMPORT"?"#2dd4a0":"#ffd166")}}>{entry.action}</span>
                  <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8"}}>{entry.time}</span>
                </div>
                <div style={{fontSize:13,color:"#b0bec5",marginBottom:2}}>{entry.detail}</div>
                <div style={{fontSize:13,color:"#b0bec8"}}>{entry.user}</div>
              </div>
            ))
          )}
        </div>
      )}
      {matchDetail&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setMatchDetail(null)}>
          <div style={{...S.card,maxWidth:480,width:"90%"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",letterSpacing:"0.1em",marginBottom:14}}>BEST MATCH</div>
            <div style={{fontSize:14,color:"#ffffff",marginBottom:4}}>Recipient: <strong>{matchDetail.recipient.recipient_name}</strong></div>
            <div style={{fontSize:14,color:"#ffffff",marginBottom:20}}>Best Donor: <strong>{matchDetail.donor.donor_name||"Altruistic Donor"}</strong></div>
            {[
              {label:"Pair Score",value:matchDetail.result.score!==null?matchDetail.result.score:"ABO ✓",color:scoreStyle(matchDetail.result.score,matchDetail.result.aboOnly).text},
              {label:"ABO",value:matchDetail.result.reasons.abo?"Compatible ✓":"Incompatible ✗",color:matchDetail.result.reasons.abo?"#2dd4a0":"#ff8a8a"},
              {label:"HLA Mismatches",value:matchDetail.result.aboOnly?"HLA not entered":matchDetail.result.reasons.hlaMismatches+" / 6",color:"#ffd166"},
              {label:"PRA",value:`${matchDetail.recipient.recipient_pra_percent||"?"}%`,color:matchDetail.result.reasons.highSensitization?"#6ab4d0":"#2dd4a0"},
              {label:"Score basis",value:matchDetail.result.aboOnly?"ABO only — enter HLA for Pair Score":"Full HLA score",color:"#6ab4d0"},
            ].map(({label,value,color})=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid #141c24"}}>
                <span style={{fontSize:13,color:"#b0bec5"}}>{label}</span>
                <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color}}>{value}</span>
              </div>
            ))}
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>{setMatchDetail(null);openDetail(matchDetail.donor,matchDetail.recipient);}} style={{...S.btn,background:"#0f2d1e",color:"#4db882",flex:1}}>Full Pair Score Report</button>
              <button onClick={()=>setMatchDetail(null)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header style={S.header}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <svg width="32" height="32" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M40 4 L4 40 L40 76 Z" fill="#4db882"/>
            <path d="M40 4 L76 40 L40 76 Z" fill="rgba(255,255,255,0.22)"/>
            <circle cx="40" cy="40" r="7" fill="#0f1c2e"/>
          </svg>
          <span style={{fontFamily:"'DM Sans', sans-serif",fontSize:20,letterSpacing:"-0.3px"}}>
            <span style={{fontWeight:700,color:"#ffffff"}}>Pair</span><span style={{fontWeight:300,color:"#4db882"}}>Path</span>
          </span>
          {false&&<button onClick={()=>setAppMode(m=>m==="solo"?"national":"solo")}
            style={{...S.tag(appMode==="national"?"#6ab4d0":"#3d8c6e"),cursor:"pointer",border:"none",background:appMode==="national"?"#6ab4d022":"#3d8c6e22"}}>
            {appMode.toUpperCase()}
          </button>}
          <button onClick={()=>setDemoMode(m=>!m)}
            style={{...S.tag(demoMode?"#ffd166":"#7a90a0"),cursor:"pointer",border:`1px solid ${demoMode?"#ffd16644":"#2a3a4a"}`,background:demoMode?"#2a1e0022":"transparent",fontSize:13,padding:"2px 8px"}}>
            {demoMode?"● DEMO":"DEMO"}
          </button>
          {demoMode&&<span style={{fontSize:13,color:"#ffd166",fontFamily:"'DM Mono', monospace"}}>demo data — not saved</span>}
        </div>
        <nav style={{display:"flex",gap:2}}>
          {[["grid","Grid"],["registry","Registry"],["matches","Matches"],["chains","Chains"],["swaps","Swaps"],["dashboard","Dashboard"],["add","+ Add"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setView(v);setEditingPair(null);if(v==="add")setForm(emptyForm);}} style={S.navBtn(view===v)}>{l}</button>
          ))}
        </nav>
        <div style={{display:"flex",gap:10,alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:13,color:"#b0bec5"}}>{demoMode?"Demo Mode":userMeta.full_name||session?.user?.email}</span>
          {isAdmin&&<span style={S.tag("#ffd166")}>Admin</span>}
          {!isAdmin&&hasCentreDomain&&<span style={{...S.tag("#6ab4d0"),fontSize:13}} title={`Sharing data with all @${userDomain} users`}>@{userDomain}</span>}
          {!isAdmin&&!hasCentreDomain&&!demoMode&&<span style={{...S.tag("#90a4b4"),fontSize:13}}>Personal</span>}
          {isAdmin&&<button onClick={()=>setShowAudit(v=>!v)} style={{...S.btn,padding:"4px 10px",background:showAudit?"#0f2d1e":"transparent",border:"1px solid #2a3d52",color:"#b0bec5",fontSize:13}}>Audit</button>}
          {userMeta.centre&&<span style={S.tag("#3d5060")}>{userMeta.centre}</span>}
          <div style={{width:7,height:7,borderRadius:"50%",background:"#4db882"}}/>
          <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#4db882"}}>{activePairs.length} ACTIVE</span>
          {session&&<button onClick={()=>supabase.auth.signOut()} style={{...S.btn,padding:"5px 12px",background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",fontSize:13}}>Sign Out</button>}
          {!session&&demoMode&&<button onClick={()=>setDemoMode(false)} style={{...S.btn,padding:"5px 12px",background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",fontSize:13}}>Exit Demo</button>}
        </div>
      </header>

      {/* Grid */}
      {view==="grid"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Compatibility Grid</h1>
          <p style={S.subtitle}>Click any cell for a full breakdown. Pair Score is 0–100 when HLA data is entered. ABO ✓ shown when HLA is missing.</p>
          <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
            <select value={filterBlood} onChange={e=>setFilterBlood(e.target.value)} style={{...S.select,width:140}}>
              <option value="all">Recipient Blood Type</option>
              {["A","B","AB","O"].map(b=><option key={b}>{b}</option>)}
            </select>
            <select value={filterDonorBlood} onChange={e=>setFilterDonorBlood(e.target.value)} style={{...S.select,width:140}}>
              <option value="all">Donor Blood Type</option>
              {["A","B","AB","O"].map(b=><option key={b}>{b}</option>)}
            </select>
            <div style={{marginLeft:"auto",display:"flex",gap:16,flexWrap:"wrap"}}>
              {[["Strong","75+",85,false],["Good","55–74",65,false],["Marginal","35–54",45,false],["ABO ✓","HLA needed",null,true],["Incompatible","ABO ✗",null,false]].map(([l,r,sc,ao])=>(
                <span key={l} style={{fontSize:13,color:"#b0bec5",display:"flex",alignItems:"center",gap:5}}>
                  <span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:scoreStyle(sc,ao).bg}}/>
                  {l} ({r})
                </span>
              ))}
            </div>
          </div>
          {activePairs.filter(p=>p.donor_blood_type).length===0?(
            <div style={{textAlign:"center",padding:80,color:"#b0bec8"}}>
              <div style={{fontSize:13,marginBottom:16}}>No active pairs with donors yet</div>
              <button onClick={()=>setView("add")} style={{...S.btn,background:"#1a6b45",color:"#ffffff"}}>Register First Pair</button>
            </div>
          ):(
            <div style={{overflowX:"auto",borderRadius:12,border:"1px solid #1e2d3d"}}>
              <table style={{borderCollapse:"collapse",width:"100%"}}>
                <thead>
                  <tr style={{background:"#131c26"}}>
                    <th style={{padding:"12px 16px",textAlign:"left",fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace",letterSpacing:"0.08em",fontWeight:400,borderBottom:"1px solid #1e2d3d",borderRight:"1px solid #1e2d3d",minWidth:190}}>
                      RECIPIENT ↓ / DONOR →
                    </th>
                    {activePairs.filter(p=>p.donor_blood_type).filter(p=>filterDonorBlood==="all"||p.donor_blood_type===filterDonorBlood).map(p=>(
                      <th key={p.id} style={{padding:"10px 12px",textAlign:"center",borderBottom:"1px solid #1e2d3d",borderRight:"1px solid #1e2d3d",minWidth:90}}>
                        <div style={{fontSize:13,fontWeight:600,color:"#ffffff"}}>{(p.donor_name||"Altruistic").split(" ")[0]}</div>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#4db882",marginTop:2}}>{p.donor_blood_type}</div>
                        {p.pair_type==="altruistic"&&<div style={{fontSize:13,color:"#ffd166",marginTop:1}}>ALT</div>}
                        {p.donor_priority&&p.pair_type==="paired"&&<div style={{fontSize:13,color:{Primary:"#2dd4a0",Secondary:"#6ab4d0",Tertiary:"#ffd166"}[p.donor_priority]||"#90a4b4",marginTop:1}}>{p.donor_priority.slice(0,3).toUpperCase()}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activePairs.filter(p=>p.recipient_blood_type)
                    .filter(p=>filterBlood==="all"||p.recipient_blood_type===filterBlood)
                    .map((recipient,ri)=>(
                    <tr key={recipient.id} style={{background:recipient.id===flash?"#0d2a1e":ri%2===0?"#0d1219":"#0c1018",transition:"background 0.5s"}}>
                      <td style={{padding:"10px 16px",borderBottom:"1px solid #141c24",borderRight:"1px solid #1e2d3d"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:"#ffffff"}}>{recipient.recipient_name}</div>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec5",marginTop:2}}>
                              {recipient.recipient_blood_type} · PRA {recipient.recipient_pra_percent||"?"}%
                              {recipient.recipient_pra_percent>80&&<span style={{color:"#ff8a8a",marginLeft:4}}>HIGH</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      {activePairs.filter(p=>p.donor_blood_type).filter(p=>filterDonorBlood==="all"||p.donor_blood_type===filterDonorBlood).map(donor=>{
                        if(donor.id===recipient.id) return <td key={donor.id} style={{textAlign:"center",borderBottom:"1px solid #141c24",borderRight:"1px solid #141c24",background:"#131c26",color:"#2a3a4a"}}>—</td>;
                        const result=calculateCompatibility(donor,recipient);
                        // Off the diagonal a cell is NEVER blank: a null/undefined/blank result
                        // renders as a red ABO-incompatible cell showing 0 and "ABO".
                        const rawScore=result?.score;
                        const isBlank=rawScore===null||rawScore===undefined||rawScore==="";
                        const scoreVal=isBlank?0:rawScore;
                        const s=isBlank?scoreStyle(0,false):scoreStyle(scoreVal,result.aboOnly);
                        const cellKey=`${donor.id}-${recipient.id}`;
                        return (
                          <td key={donor.id}
                            onMouseEnter={()=>setHoveredCell(cellKey)}
                            onMouseLeave={()=>setHoveredCell(null)}
                            onClick={()=>openDetail(donor,recipient)}
                            title={`ABO: ${result.reasons.abo?"✓":"✗"} | ${result.aboOnly?"ABO-only":"HLA MM: "+(result.reasons.hlaMismatches??0)} | ${s.label}`}
                            style={{textAlign:"center",cursor:"pointer",borderBottom:"1px solid #141c24",borderRight:"1px solid #141c24",background:hoveredCell===cellKey?s.bg:`${s.bg}99`,transition:"background 0.15s",padding:"10px 6px"}}>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:16,fontWeight:500,color:s.text,lineHeight:1}}>{scoreVal}</div>
                            <div style={{fontSize:13,color:`${s.text}cc`,marginTop:3}}>{isBlank?"ABO":(result.aboOnly?"ABO":`${result.reasons.hlaMismatches??0}MM`)}</div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{marginTop:10,fontSize:13,color:"#b0bec8",fontFamily:"'DM Mono', monospace"}}>
            MM = HLA mismatches · ABO = blood type only · ALT = altruistic donor · All matches require crossmatch confirmation
          </p>
        </div>
      )}

      {/* Registry */}
      {view==="registry"&&(
        <div style={S.page}>
          {/* Onboarding — shown only when registry is empty */}
          {pairs.length===0&&!demoMode&&(
            <div style={{maxWidth:560,margin:"0 auto",textAlign:"center",padding:"48px 24px"}}>
              <div style={{fontSize:48,marginBottom:16}}>🏥</div>
              <h1 style={{...S.pageTitle,textAlign:"center",marginBottom:8}}>Welcome to PairPath</h1>
              <p style={{color:"#b0bec5",fontSize:15,lineHeight:1.7,marginBottom:32}}>
                Your registry is empty. Start by uploading your active donors and recipients from Epic, or add pairs manually one at a time.
              </p>
              <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:32}}>
                <button onClick={()=>fileRef.current?.click()} style={{...S.btn,background:"#1a6b45",color:"#ffffff",padding:"14px 20px",fontSize:15}}>
                  ↑ Bulk Upload from Epic (CSV or Excel)
                </button>
                <button onClick={()=>{setView("add");setForm(emptyForm);}} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",padding:"14px 20px",fontSize:15}}>
                  + Add a Single Entry Manually
                </button>
                <button onClick={()=>setDemoMode(true)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec8",padding:"14px 20px",fontSize:14}}>
                  Explore with Demo Data First
                </button>
              </div>
              <div style={{padding:"16px 20px",borderRadius:10,background:"#131c26",border:"1px solid #1e2d3d",textAlign:"left"}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",marginBottom:10}}>QUICK START</div>
                {[
                  ["1","Export Active Status 1 recipients from Epic as CSV"],
                  ["2","Export Active Living Donors in Evaluation from Epic as CSV"],
                  ["3","Click Bulk Upload — PairPath detects and anonymizes real names automatically"],
                  ["4","Map your columns — PairPath remembers your mapping for next time"],
                  ["5","Go to Matches to see your best compatible pairs instantly"],
                ].map(([n,s])=>(
                  <div key={n} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                    <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#4db882",fontWeight:700,flexShrink:0}}>{n}.</span>
                    <span style={{fontSize:13,color:"#b0bec5",lineHeight:1.5}}>{s}</span>
                  </div>
                ))}
              </div>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} style={{display:"none"}}/>
            </div>
          )}
          {(pairs.length>0||demoMode)&&(
          <>
            <div>
              <h1 style={S.pageTitle}>Registry</h1>
              <p style={{...S.subtitle,marginBottom:0}}>All entries — manage, edit, and export.</p>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={downloadDeIDTemplate} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Download De-ID Template</button>
              <label style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",cursor:"pointer",display:"inline-flex",alignItems:"center"}}>
                {uploading?"Uploading…":"Bulk Upload CSV / Excel"}
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} style={{display:"none"}}/>
              </label>
              <button onClick={()=>exportRegistry(filteredPairs)} style={{...S.btn,background:"#0f2d1e",color:"#4db882"}}>Export CSV</button>
              <button onClick={()=>setShowMatchExport(true)} style={{...S.btn,background:"#1a203a",color:"#6ab4d0"}}>Export Matches</button>
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
          </div>

          {/* Multi-key sort stack */}
          <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace",marginRight:4}}>SORT BY</span>
            {sortStack.map((s,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",background:"#131c26",border:"1px solid #1e2d3d",borderRadius:6}}>
                {i>0&&<span style={{fontSize:13,color:"#b0bec8",marginRight:4}}>then</span>}
                <select value={s.key} onChange={e=>{const ns=[...sortStack];ns[i]={...ns[i],key:e.target.value};setSortStack(ns);}}
                  style={{...S.select,width:170,fontSize:13,padding:"3px 6px",border:"none",background:"transparent"}}>
                  <option value="date">Date Added</option>
                  <option value="score">Best Match Score</option>
                  <option value="dialysis">Time on Dialysis</option>
                  <option value="pra">PRA % (sensitization)</option>
                  <option value="lastname">Last Name</option>
                </select>
                <button onClick={()=>{const ns=[...sortStack];ns[i]={...ns[i],dir:ns[i].dir==="desc"?"asc":"desc"};setSortStack(ns);}}
                  style={{background:"none",border:"none",color:"#6ab4d0",cursor:"pointer",fontSize:13,padding:"0 2px"}}>
                  {s.dir==="desc"?"↓":"↑"}
                </button>
                {sortStack.length>1&&(
                  <button onClick={()=>setSortStack(st=>st.filter((_,j)=>j!==i))}
                    style={{background:"none",border:"none",color:"#5a3a3a",cursor:"pointer",fontSize:14,padding:"0 2px",lineHeight:1}}>×</button>
                )}
              </div>
            ))}
            {sortStack.length<4&&(
              <button onClick={()=>setSortStack(st=>[...st,{key:"pra",dir:"desc"}])}
                style={{...S.btn,background:"transparent",border:"1px dashed #2a3d52",color:"#c4d0d9",padding:"4px 10px",fontSize:13}}>
                + Add level
              </button>
            )}
            {sortStack.length>1&&(
              <button onClick={()=>setSortStack([{key:"date",dir:"desc"}])}
                style={{background:"none",border:"none",color:"#5a3a3a",cursor:"pointer",fontSize:13,marginLeft:4}}>
                reset
              </button>
            )}
          </div>

          {/* Select all bar */}
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"#131c26",borderRadius:8,marginBottom:8,border:"1px solid #1e2d3d"}}>
            <input type="checkbox" checked={selectedIds.size===filteredPairs.length&&filteredPairs.length>0} onChange={toggleSelectAll} style={{cursor:"pointer",width:16,height:16}}/>
            <span style={{fontSize:13,color:"#b0bec5"}}>
              {selectedIds.size>0?`${selectedIds.size} of ${filteredPairs.length} selected`:`${filteredPairs.length} entries shown`}
            </span>
            {selectedIds.size>0&&(
              <button onClick={()=>setBulkDeleteConfirm(true)} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a",padding:"5px 14px",fontSize:13,marginLeft:"auto"}}>
                Delete Selected ({selectedIds.size})
              </button>
            )}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {filteredPairs.length===0&&<div style={{textAlign:"center",padding:40,color:"#b0bec8",fontSize:13}}>No entries match your filters</div>}
            {filteredPairs.map(pair=>{
              const pairDomain=pair.user_email?pair.user_email.split("@")[1]?.toLowerCase():"";
              const canEdit=isAdmin||(hasCentreDomain&&pairDomain===userDomain)||pair.user_id===currentUserId;
              const donorPairs=activePairs.filter(p=>p.donor_blood_type);
              const matches=pair.recipient_blood_type?donorPairs.filter(d=>d.id!==pair.id).map(d=>({donor:d,result:calculateCompatibility(d,pair)})).filter(m=>m.result.reasons.abo).sort((a,b)=>(b.result.score||0)-(a.result.score||0)):[];
              const best=matches[0]||null;
              const bs=best?scoreStyle(best.result.score,best.result.aboOnly):null;
              const dAge=calcAge(pair.donor_year_born),rAge=calcAge(pair.recipient_year_born);
              const isSelected=selectedIds.has(pair.id);

              // Sibling donors — other entries with same recipient name
              const siblingDonors=pair.recipient_name?filteredPairs.filter(p=>
                p.id!==pair.id&&
                p.recipient_name&&
                p.recipient_name.trim().toLowerCase()===pair.recipient_name.trim().toLowerCase()&&
                p.donor_name
              ).sort((a,b)=>{
                const rank={Primary:0,Secondary:1,Tertiary:2};
                return (rank[a.donor_priority]??1)-(rank[b.donor_priority]??1);
              }):[];
              const priorityColor={Primary:"#2dd4a0",Secondary:"#6ab4d0",Tertiary:"#ffd166"};

              return (
                <div key={pair.id} style={{...S.card,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",borderColor:isSelected?"#2dd4a066":"#1e2d3d",background:isSelected?"#0d1a14":"#131c26"}}>
                  {canEdit&&<input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(pair.id)} style={{cursor:"pointer",width:16,height:16,flexShrink:0}}/>}
                  {!canEdit&&<div style={{width:16,height:16,flexShrink:0}}/>}
                  <span style={S.tag("#7a90a0")}>{pairTypeLabel(pair.pair_type)}</span>
                  <div style={{flex:1,minWidth:180}}>
                    {pair.recipient_name&&(
                      <>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                          <span style={{fontSize:14,fontWeight:600,color:"#ffffff"}}>{pair.recipient_name}</span>
                          {pair.recipient_blood_type&&<span style={S.tag("#3d8c6e")}>{pair.recipient_blood_type}</span>}
                          {pair.recipient_pra_percent>80&&<span style={S.tag("#ff8a8a")}>HIGH PRA</span>}
                        </div>
                        <div style={{fontSize:13,color:"#b0bec5"}}>
                          Recipient{rAge?` · Age ${rAge}`:""}
                          {pair.recipient_pra_percent?` · PRA ${pair.recipient_pra_percent}%`:""}
                          {pair.recipient_dialysis_start?` · Waitlist ${new Date(pair.recipient_dialysis_start).toLocaleDateString("en-US",{month:"short",year:"numeric"})}`:""}
                        </div>
                      </>
                    )}
                    {pair.donor_name&&(
                      <div style={{fontSize:13,color:"#c4d0d9",marginTop:pair.recipient_name?4:0,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        {pair.donor_priority&&pair.pair_type==="paired"&&(
                          <span style={{...S.tag(priorityColor[pair.donor_priority]||"#90a4b4"),fontSize:13}}>{pair.donor_priority}</span>
                        )}
                        Donor: <strong style={{color:"#c8d4dc"}}>{pair.donor_name}</strong>
                        {pair.donor_blood_type?` · ${pair.donor_blood_type}`:""}
                        {dAge?` · Age ${dAge}`:""}
                        {pair.donor_egfr?` · eGFR ${pair.donor_egfr}`:""}
                      </div>
                    )}
                    {/* Sibling donors for same recipient */}
                    {siblingDonors.length>0&&(
                      <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid #141c24"}}>
                        <div style={{fontSize:13,color:"#b0bec8",fontFamily:"'DM Mono', monospace",marginBottom:4}}>ALSO WILLING TO DONATE</div>
                        {siblingDonors.map(sd=>{
                          const sdResult=sd.donor_blood_type&&pair.recipient_blood_type?calculateCompatibility(sd,pair):null;
                          const sdStyle=sdResult?scoreStyle(sdResult.score,sdResult.aboOnly):null;
                          return(
                            <div key={sd.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,fontSize:13}}>
                              <span style={{...S.tag(priorityColor[sd.donor_priority]||"#90a4b4"),fontSize:13}}>{sd.donor_priority||"—"}</span>
                              <span style={{color:"#c8d4dc"}}>{sd.donor_name}</span>
                              <span style={{color:"#c4d0d9"}}>{sd.donor_blood_type||""}</span>
                              {sdStyle&&<span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:sdStyle.text,background:sdStyle.bg,padding:"1px 6px",borderRadius:4}}>{sdResult.score??"ABO ✓"}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(appMode==="national"||pair.centre)&&pair.centre&&(
                      <div style={{fontSize:13,color:"#7a90a0",marginTop:3}}>{pair.centre}</div>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0,flexWrap:"wrap"}}>
                    {bs&&(
                      <button onClick={()=>setMatchDetail({donor:best.donor,recipient:pair,result:best.result})}
                        style={{textAlign:"center",padding:"6px 12px",borderRadius:8,background:`${bs.bg}99`,border:"none",cursor:"pointer"}}>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:18,color:bs.text,lineHeight:1}}>
                          {best.result.score!==null?best.result.score:"ABO ✓"}
                        </div>
                        <div style={{fontSize:13,color:`${bs.text}cc`,marginTop:2}}>{best.result.score!==null?"PAIR SCORE":"HLA NEEDED"}</div>
                      </button>
                    )}
                    <select value={pair.status} onChange={e=>handleStatusChange(pair.id,e.target.value)} disabled={!canEdit}
                      style={{...S.select,width:170,fontSize:13,opacity:canEdit?1:0.4,cursor:canEdit?"pointer":"not-allowed"}}>
                      {STATUS_OPTIONS.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select>
                    {!canEdit&&appMode==="national"&&<span style={{fontSize:13,color:"#b0bec8",fontFamily:"'DM Mono', monospace"}}>READ ONLY</span>}
                    {canEdit&&(
                      <>
                        <button onClick={()=>startEdit(pair)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",padding:"6px 12px"}}>Edit</button>
                        <button onClick={()=>setDeleteConfirm(pair)} style={{...S.btn,background:"transparent",border:"1px solid #3a1010",color:"#ff8a8a",padding:"6px 12px"}}>Delete</button>
                      </>
                    )}
                  </div>
                  {pair.notes&&<div style={{width:"100%",fontSize:13,color:"#b0bec8",borderTop:"1px solid #141c24",paddingTop:8,marginTop:4}}>📝 {pair.notes}</div>}
                </div>
              );
            })}
          </div>
          </>)}
        </div>
      )}

      {/* Chains */}
      {view==="chains"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Chain Identification</h1>
          <p style={S.subtitle}>Compatible exchange chains across all active pairs. Chains longer than 6-way are rare in practice and logistically complex to coordinate.</p>
          {chainsLoading?(
            <div style={{textAlign:"center",padding:60,color:"#4db882",fontFamily:"'DM Mono', monospace",fontSize:13}}>Computing chains…</div>
          ):chains.length===0?(
            <div style={{textAlign:"center",padding:60,color:"#b0bec8",fontSize:13}}>
              No compatible chains found yet — add incompatible pairs to identify exchange opportunities
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {chains.map((chain,ci)=>(
                <div key={ci} style={{...S.card,borderColor:chain.length>=4?"#2d6e8c":chain.length>=3?"#3d8c6e":"#1e2d3d"}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14,flexWrap:"wrap"}}>
                    <span style={S.tag(chain.length>=4?"#6ab4d0":chain.length>=3?"#2dd4a0":"#b0bec5")}>{chain.length}-WAY CHAIN</span>
                    {chain.length>=4&&<span style={S.tag("#ffd166")}>COMPLEX EXCHANGE</span>}
                    {chain.some(c=>c.altruistic)&&<span style={S.tag("#ffd166")}>ALTRUISTIC TRIGGERED</span>}
                    <span style={{marginLeft:"auto",fontSize:13,color:"#b0bec5",fontFamily:"'DM Mono', monospace"}}>
                      AVG SCORE: {Math.round(chain.reduce((s,c)=>s+c.score,0)/chain.length)}
                    </span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:6}}>
                    {chain.map((link,li)=>{
                      const s=scoreStyle(link.score,false);
                      return (
                        <div key={li} style={{display:"flex",alignItems:"center"}}>
                          <div style={{padding:"10px 14px",borderRadius:8,background:"#1a2535",border:"1px solid #2a3d52",minWidth:100}}>
                            <div style={{fontSize:13,fontWeight:600,color:"#6ab4d0"}}>
                              {link.donorName.split(" ")[0]}
                              <span style={{fontSize:13,color:"#4db882",marginLeft:4}}>({link.donorBlood})</span>
                              {link.altruistic&&<span style={{fontSize:13,color:"#ffd166",marginLeft:4}}>ALT</span>}
                            </div>
                            <div style={{fontSize:13,color:"#b0bec8",margin:"4px 0",textAlign:"center"}}>donates to</div>
                            <div style={{fontSize:13,fontWeight:600,color:"#6ad0a0"}}>
                              {link.recipientName?.split(" ")[0]||"—"}
                              <span style={{fontSize:13,color:"#4db882",marginLeft:4}}>({link.recipientBlood})</span>
                            </div>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:s.text,marginTop:5,textAlign:"center"}}>
                              {link.score}
                            </div>
                          </div>
                          {li<chain.length-1&&<div style={{padding:"0 8px",color:"#4db882",fontSize:20}}>→</div>}
                        </div>
                      );
                    })}
                    <div style={{padding:"0 8px",color:"#6a8899",fontSize:20}}>↩</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Swaps */}
      {view==="swaps"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Swap Analysis</h1>
          <p style={S.subtitle}>2-way paired exchanges — both donors cross-donate to each other's recipient.</p>

          {/* Stats + controls */}
          <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",marginBottom:20}}>
            <div style={{display:"flex",gap:28,flexWrap:"wrap"}}>
              {[
                ["VIABLE SWAPS",swapStats.total,"#4db882"],
                ["AVG COMBINED",swapStats.avg,"#6ab4d0"],
                ["PROPOSED",swapStats.proposed,"#6ab4d0"],
                ["ACCEPTED",swapStats.accepted,"#4db882"],
              ].map(([l,v,c])=>(
                <div key={l}>
                  <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em"}}>{l}</div>
                  <div style={{fontSize:22,fontWeight:700,color:c}}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
              <select value={swapFilter} onChange={e=>setSwapFilter(e.target.value)} style={{...S.select,width:170}}>
                <option value="">All Swaps</option>
                <option value="proposed">Proposed</option>
                <option value="accepted">Accepted</option>
                <option value="scheduled">Scheduled</option>
                <option value="completed">Completed</option>
              </select>
              <button onClick={()=>exportSwaps(filteredSwaps,swapStatuses)} disabled={!swaps.length}
                style={{...S.btn,background:"#1a203a",color:"#6ab4d0",opacity:swaps.length?1:0.5,cursor:swaps.length?"pointer":"not-allowed"}}>Export CSV</button>
            </div>
          </div>

          {swaps.length===0?(
            <div style={{...S.card,textAlign:"center",padding:48,color:"#b0bec8"}}>
              <div style={{fontSize:15,color:"#ffffff",marginBottom:10}}>No viable swaps found</div>
              <div style={{fontSize:13,lineHeight:1.7,maxWidth:540,margin:"0 auto"}}>
                A swap requires <strong>paired entries</strong> — a single entry that has <em>both</em> a donor and a recipient — whose blood types are mutually compatible (Pair A's donor matches Pair B's recipient, and Pair B's donor matches Pair A's recipient).
                <div style={{marginTop:12,fontFamily:"'DM Mono', monospace",fontSize:13,color:"#6ab4d0"}}>
                  {eligibleSwapPairs} eligible paired {eligibleSwapPairs===1?"entry":"entries"} · at least 2 with compatible blood types are needed
                </div>
              </div>
            </div>
          ):filteredSwaps.length===0?(
            <div style={{...S.card,textAlign:"center",padding:40,color:"#b0bec8",fontSize:13}}>No swaps with status “{statusLabel(swapFilter)}”.</div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {filteredSwaps.map(swap=>{
                const cs=scoreStyle(swap.combined,false);
                const l1=scoreStyle(swap.leg1Score,swap.leg1.aboOnly);
                const l2=scoreStyle(swap.leg2Score,swap.leg2.aboOnly);
                const status=swapStatuses[swap.id];
                const idx=SWAP_STATUS_CYCLE.indexOf(status);
                const nextStatus=idx<0?"proposed":(idx>=SWAP_STATUS_CYCLE.length-1?null:SWAP_STATUS_CYCLE[idx+1]);
                const btnLabel=!status?"Propose":(nextStatus?`Mark ${statusLabel(nextStatus)}`:"Reset");
                const flags=[
                  ...swapLegFlags(swap.leg1).map(f=>`Leg 1 · ${f}`),
                  ...swapLegFlags(swap.leg2).map(f=>`Leg 2 · ${f}`),
                ];
                const A=swap.pairA, B=swap.pairB;
                return (
                  <div key={swap.id} style={{...S.card,background:"#131c26",border:`1px solid ${cs.bg}`}}>
                    {/* Header row */}
                    <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:14}}>
                      <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em"}}>COMBINED SCORE</span>
                      <span style={{fontFamily:"'DM Mono', monospace",fontSize:24,fontWeight:700,color:cs.text,background:`${cs.bg}55`,borderRadius:6,padding:"2px 12px"}}>{swap.combined}</span>
                      {status&&<span style={S.tag(SWAP_STATUS_COLORS[status])}>{statusLabel(status).toUpperCase()}</span>}
                      {status&&<button onClick={()=>resetSwapStatus(swap.id)} title="Reset status"
                        style={{background:"none",border:"none",color:"#6a8092",cursor:"pointer",fontSize:13,lineHeight:1,padding:"0 2px"}}>✕</button>}
                      <button onClick={()=>cycleSwapStatus(swap.id)}
                        style={{...S.btn,marginLeft:"auto",padding:"7px 16px",background:status?"transparent":SWAP_STATUS_COLORS.proposed,border:status?"1px solid #2a3d52":"none",color:status?"#b0bec5":"#0a0f18",fontSize:13}}>{btnLabel}</button>
                    </div>
                    {/* 3-column body */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:12,alignItems:"center"}}>
                      {/* Pair A */}
                      <div style={{padding:"12px 14px",borderRadius:8,background:"#1a2535",border:"1px solid #2a3d52"}}>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",marginBottom:6}}>PAIR A</div>
                        <div style={{fontSize:14,fontWeight:600,color:"#6ab4d0"}}>Donor {A.donor_name||A.id} <span style={{color:"#4db882"}}>· {A.donor_blood_type}</span></div>
                        <div style={{textAlign:"center",color:"#4db882",fontSize:16,margin:"2px 0"}}>↓</div>
                        <div style={{fontSize:14,fontWeight:600,color:"#6ad0a0"}}>Recip {A.recipient_name||A.id} <span style={{color:"#4db882"}}>· {A.recipient_blood_type}</span></div>
                        <div style={{fontSize:13,color:"#b0bec8",marginTop:4}}>Age {calcAge(A.recipient_year_born)||"—"} · PRA {A.recipient_pra_percent??"?"}%{A.recipient_pra_percent>80&&<span style={{color:"#ff8a8a",marginLeft:4}}>HIGH</span>}</div>
                      </div>
                      {/* Center — legs */}
                      <div style={{textAlign:"center",minWidth:120}}>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.06em"}}>LEG 1</div>
                        <div style={{color:"#4db882",fontSize:20,letterSpacing:"0.12em"}}>→ →</div>
                        <span style={{fontFamily:"'DM Mono', monospace",fontSize:15,fontWeight:600,color:l1.text,background:`${l1.bg}55`,borderRadius:5,padding:"1px 8px"}}>{swap.leg1Score}</span>
                        <div style={{height:12}}/>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.06em"}}>LEG 2</div>
                        <div style={{color:"#4db882",fontSize:20,letterSpacing:"0.12em"}}>← ←</div>
                        <span style={{fontFamily:"'DM Mono', monospace",fontSize:15,fontWeight:600,color:l2.text,background:`${l2.bg}55`,borderRadius:5,padding:"1px 8px"}}>{swap.leg2Score}</span>
                      </div>
                      {/* Pair B */}
                      <div style={{padding:"12px 14px",borderRadius:8,background:"#1a2535",border:"1px solid #2a3d52"}}>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec8",letterSpacing:"0.08em",marginBottom:6}}>PAIR B</div>
                        <div style={{fontSize:14,fontWeight:600,color:"#6ab4d0"}}>Donor {B.donor_name||B.id} <span style={{color:"#4db882"}}>· {B.donor_blood_type}</span></div>
                        <div style={{textAlign:"center",color:"#4db882",fontSize:16,margin:"2px 0"}}>↓</div>
                        <div style={{fontSize:14,fontWeight:600,color:"#6ad0a0"}}>Recip {B.recipient_name||B.id} <span style={{color:"#4db882"}}>· {B.recipient_blood_type}</span></div>
                        <div style={{fontSize:13,color:"#b0bec8",marginTop:4}}>Age {calcAge(B.recipient_year_born)||"—"} · PRA {B.recipient_pra_percent??"?"}%{B.recipient_pra_percent>80&&<span style={{color:"#ff8a8a",marginLeft:4}}>HIGH</span>}</div>
                      </div>
                    </div>
                    {/* Combined confidence flags for both legs */}
                    {flags.length>0&&(
                      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
                        {flags.map((f,fi)=><span key={fi} style={S.tag(f.includes("CMV")?"#ffb86b":f.includes("Size")?"#ffd166":"#ff8a8a")}>⚠ {f}</span>)}
                      </div>
                    )}
                  </div>
                );
              })}
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
              {label:"Total Entries",value:stats.total,color:"#b0bec5"},
              {label:"Active",value:stats.active,color:"#4db882"},
              {label:"With Match",value:stats.withMatch,color:"#6effc6"},
              {label:"Altruistic Donors",value:stats.altruistic,color:"#ffd166"},
              {label:"Recipient Only",value:stats.recipientOnly,color:"#6ab4d0"},
              {label:"Completed",value:stats.completed,color:"#6ab4d0"},
              {label:"Withdrawn",value:stats.withdrawn,color:"#b0bec8"},
              {label:"2-Way Chains",value:stats.chains2,color:"#4db882"},
              {label:"3-Way Chains",value:stats.chains3,color:"#6ab4d0"},
              {label:"4+ Way Chains",value:stats.chainsLong,color:"#ffd166"},
            ].map(({label,value,color})=>(
              <div key={label} style={{...S.card,textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:30,fontWeight:500,color,lineHeight:1}}>{value}</div>
                <div style={{fontSize:13,color:"#c4d0d9",marginTop:6}}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div style={S.card}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",letterSpacing:"0.1em",marginBottom:14}}>RECIPIENT BLOOD TYPE — ACTIVE</div>
              {["A","B","AB","O"].map(bt=>{
                const count=activePairs.filter(p=>p.recipient_blood_type===bt).length;
                const pct=activePairs.length?Math.round((count/activePairs.length)*100):0;
                return (
                  <div key={bt} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:13}}>
                      <span style={{color:"#b0bec5"}}>Type {bt}</span>
                      <span style={{fontFamily:"'DM Mono', monospace",color:"#ffffff"}}>{count} <span style={{color:"#b0bec8"}}>({pct}%)</span></span>
                    </div>
                    <div style={{height:5,background:"#1e2d3d",borderRadius:2}}>
                      <div style={{height:"100%",width:`${pct}%`,background:"#2dd4a0",borderRadius:2}}/>
                    </div>
                  </div>
                );
              })}
            </div>
            {appMode==="national"&&centres.length>0&&(
              <div style={S.card}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",letterSpacing:"0.1em",marginBottom:14}}>ENTRIES BY CENTER</div>
                {centres.map(c=>{
                  const count=visiblePairs.filter(p=>p.centre===c).length;
                  const pct=visiblePairs.length?Math.round((count/visiblePairs.length)*100):0;
                  return (
                    <div key={c} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:13}}>
                        <span style={{color:"#b0bec5"}}>{c}</span>
                        <span style={{fontFamily:"'DM Mono', monospace",color:"#ffffff"}}>{count}</span>
                      </div>
                      <div style={{height:5,background:"#1e2d3d",borderRadius:2}}>
                        <div style={{height:"100%",width:`${pct}%`,background:"#6ab4d0",borderRadius:2}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={S.card}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",letterSpacing:"0.1em",marginBottom:14}}>RECENT ENTRIES</div>
              {pairs.slice(0,6).map(p=>(
                <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,fontSize:13}}>
                  <span style={{color:"#c8d4dc"}}>{p.recipient_name||p.donor_name}</span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{color:"#b0bec8",fontFamily:"'DM Mono', monospace",fontSize:13}}>
                      {p.created_at?new Date(p.created_at).toLocaleDateString():""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Best Match Cards */}
      {view==="matches"&&(()=>{
        const donors = activePairs.filter(p=>p.donor_blood_type);
        const recipients = activePairs.filter(p=>p.recipient_blood_type);

        const waitlistDuration=r=>{
          if(!r.recipient_dialysis_start) return null;
          const d=Math.floor((Date.now()-new Date(r.recipient_dialysis_start))/86400000);
          return d>365?`${Math.floor(d/365)}yr ${Math.floor((d%365)/30)}mo`:`${d} days`;
        };

        // Build best match for each recipient — optionally excluding a withdrawn donor
        function buildMatches(excludeDonorId=null){
          const availDonors=donors.filter(d=>d.id!==excludeDonorId);
          return recipients.map(recip=>{
            const allMatches = availDonors
              .filter(d=>d.id!==recip.id)
              .map(d=>({donor:d, result:calculateCompatibility(d,recip)}))
              .filter(m=>m.result.reasons.abo)
              .sort((a,b)=>(b.result.score||0)-(a.result.score||0));
            const best = allMatches[0]||null;
            const days = recip.recipient_dialysis_start
              ? Math.floor((Date.now()-new Date(recip.recipient_dialysis_start))/(86400000)) : null;
            // Confidence flags
            const flags=[];
            if(best){
              if(best.donor.donor_cmv==="Positive"&&recip.recipient_cmv==="Negative") flags.push("CMV D+/R−");
              const dw=cleanWeight(best.donor.donor_weight_kg)||0, rw=cleanWeight(recip.recipient_weight_kg)||0;
              if(dw&&rw&&Math.abs(dw-rw)>20) flags.push("Size gap");
              if(parseFloat(recip.recipient_pra_percent||0)>80) flags.push("High PRA");
            }
            return {recip, best, allMatches, waitlistDays:days, flags};
          }).sort((a,b)=>{
            const aScore=a.best?.result.score||0,bScore=b.best?.result.score||0;
            if(bScore!==aScore) return bScore-aScore;
            const aPRA=parseFloat(a.recip.recipient_pra_percent||0),bPRA=parseFloat(b.recip.recipient_pra_percent||0);
            if(bPRA!==aPRA) return bPRA-aPRA;
            return (b.waitlistDays||0)-(a.waitlistDays||0);
          });
        }

        const recipientMatches=buildMatches(whatIfDonor);
        const noMatchCount = recipientMatches.filter(m=>!m.best).length;
        const affectedByWithdrawal = whatIfDonor
          ? recipientMatches.filter(m=>!m.best&&buildMatches(null).find(bm=>bm.recip.id===m.recip.id)?.best).length
          : 0;

        function matchNarrative(rm){
          const {recip,best,waitlistDays}=rm;
          if(!best) return "No compatible donor found in current registry.";
          const pra=parseFloat(recip.recipient_pra_percent||0);
          const weightDiff=best.donor.donor_weight_kg&&recip.recipient_weight_kg
            ?Math.abs((cleanWeight(best.donor.donor_weight_kg)||0)-(cleanWeight(recip.recipient_weight_kg)||0)):null;
          const ageDiff=best.result.reasons.ageDiff;
          const parts=[];
          if(pra>80) parts.push("Highly sensitized — rare compatible match");
          else if(pra>50) parts.push("Moderately sensitized");
          if(waitlistDays&&waitlistDays>365) parts.push(`${Math.floor(waitlistDays/365)}yr ${Math.floor((waitlistDays%365)/30)}mo on waitlist`);
          else if(waitlistDays) parts.push(`${waitlistDays} days on waitlist`);
          if(best.result.aboOnly) parts.push("ABO compatible — HLA not yet entered");
          return parts.join(" · ")||"ABO compatible match";
        }

        return (
          <div style={S.page}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4,flexWrap:"wrap",gap:12}}>
              <div>
                <h1 style={S.pageTitle}>Best Match Cards</h1>
                <p style={S.subtitle}>Top compatible donor per recipient · Sorted by score, sensitization, then waitlist time</p>
              </div>
              <button onClick={()=>exportMatchCards(activePairs)} style={{...S.btn,background:"#1a203a",color:"#6ab4d0"}}>Export PDF</button>
            </div>

            {/* What-if analysis */}
            <div style={{padding:"12px 16px",borderRadius:8,background:"#1a2535",border:"1px solid #2a3d52",marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <span style={{fontSize:13,color:"#4db882",fontFamily:"'DM Mono', monospace",letterSpacing:"0.08em",fontWeight:600,flexShrink:0}}>WHAT IF</span>
              <select value={whatIfDonor||""} onChange={e=>setWhatIfDonor(e.target.value||null)}
                style={{...S.select,width:320,fontSize:13,background:"#0d1219",border:"1px solid #2a3d52",color:"#ffffff"}}>
                <option value="">— a donor withdraws from the registry?</option>
                {donors.map(d=><option key={d.id} value={d.id}>{d.donor_name||"Unnamed"} · {d.donor_blood_type}</option>)}
              </select>
              {whatIfDonor&&(
                <>
                  <span style={{fontSize:13,color:affectedByWithdrawal>0?"#ff9999":"#4db882"}}>
                    {affectedByWithdrawal>0
                      ?`⚠ ${affectedByWithdrawal} recipient${affectedByWithdrawal!==1?"s":""} would lose their best match`
                      :"✓ No recipients lose their best match"}
                  </span>
                  <button onClick={()=>setWhatIfDonor(null)} style={{background:"none",border:"none",color:"#b0bec8",cursor:"pointer",fontSize:13}}>Clear</button>
                </>
              )}
            </div>

            {noMatchCount>0&&(
              <div style={{padding:"10px 14px",borderRadius:8,background:"#2a1010",border:"1px solid #3a1010",color:"#ff8a8a",fontSize:13,marginBottom:16}}>
                {whatIfDonor?"After withdrawal: ":""}{noMatchCount} recipient{noMatchCount!==1?"s":""} have no compatible donor in the current registry
              </div>
            )}

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:12}}>
              {recipientMatches.map(({recip,best,allMatches,waitlistDays,flags},i)=>{
                const s=best?scoreStyle(best.result.score,best.result.aboOnly):null;
                const pra=parseFloat(recip.recipient_pra_percent||0);
                const rAge=calcAge(recip.recipient_year_born);
                const dAge=best?calcAge(best.donor.donor_year_born):null;
                const duration=waitlistDuration(recip);
                return(
                  <div key={recip.id} style={{...S.card,padding:14,borderColor:best?`${s.text}33`:"#3a1010"}}>
                    {/* Recipient row */}
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8,gap:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap",marginBottom:3}}>
                          <span style={{fontSize:14,fontWeight:700,color:"#ffffff"}}>{recip.recipient_name||"Unnamed"}</span>
                          <span style={S.tag("#3d8c6e")}>{recip.recipient_blood_type}</span>
                          {pra>80&&<span style={S.tag("#ff8a8a")}>HIGH PRA</span>}
                        </div>
                        <div style={{fontSize:13,color:"#b0bec5",display:"flex",gap:8,flexWrap:"wrap"}}>
                          {rAge&&<span>Age {rAge}</span>}
                          {recip.recipient_pra_percent&&<span>PRA {recip.recipient_pra_percent}%</span>}
                          {duration&&<span>{duration} waiting</span>}
                        </div>
                        {flags&&flags.length>0&&(
                          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:4}}>
                            {flags.map((f,fi)=>(
                              <span key={fi} style={{fontSize:13,padding:"2px 6px",borderRadius:4,background:"#2a1500",color:"#ffd166",fontFamily:"'DM Mono', monospace"}}>⚠ {f}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      {best&&s&&(
                        <div style={{textAlign:"center",padding:"6px 12px",borderRadius:8,background:s.bg,flexShrink:0}}>
                          <div style={{fontFamily:"'DM Mono', monospace",fontSize:20,fontWeight:600,color:s.text,lineHeight:1}}>
                            {best.result.score??<span style={{fontSize:13}}>ABO ✓</span>}
                          </div>
                          <div style={{fontSize:13,color:`${s.text}cc`,marginTop:2,letterSpacing:"0.05em"}}>PAIR SCORE</div>
                        </div>
                      )}
                      {!best&&(
                        <div style={{padding:"6px 12px",borderRadius:8,background:"#2a1010",flexShrink:0}}>
                          <div style={{fontSize:13,color:"#ff8a8a"}}>No Match</div>
                        </div>
                      )}
                    </div>

                    <div style={{borderTop:"1px solid #1e2d3d",marginBottom:8}}/>

                    {/* Best donor — compact single line */}
                    {best?(
                      <>
                        <div style={{fontSize:13,color:"#4db882",fontFamily:"'DM Mono', monospace",marginBottom:5,letterSpacing:"0.08em"}}>BEST COMPATIBLE DONOR</div>
                        <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap",marginBottom:4}}>
                          <span style={{fontSize:13,fontWeight:600,color:"#c8d4dc"}}>{best.donor.donor_name}</span>
                          <span style={S.tag("#3d5060")}>{best.donor.donor_blood_type}</span>
                          {dAge&&<span style={{fontSize:13,color:"#c4d0d9"}}>Age {dAge}</span>}
                          {best.donor.donor_egfr&&<span style={{fontSize:13,color:"#c4d0d9"}}>eGFR {best.donor.donor_egfr}</span>}
                          {(()=>{
                            const dw=cleanWeight(best.donor.donor_weight_kg);
                            const rw=cleanWeight(recip.recipient_weight_kg);
                            if(!dw||!rw) return null;
                            const diff=Math.round(Math.abs(dw-rw)*10)/10;
                            return <span style={{fontSize:13,color:"#c4d0d9"}}>{diff}kg Δ</span>;
                          })()}
                          {best.result.oDonorIdeal&&<span style={{...S.tag("#4db882"),fontSize:13}}>O→O ✓</span>}
                          {best.result.oDonorPenalty<0&&<span style={{...S.tag("#ffd166"),fontSize:13}}>conserve O</span>}
                        </div>
                        <div style={{fontSize:13,color:"#6ab4d0",marginBottom:allMatches.length>1?6:0}}>
                          {matchNarrative({recip,best,waitlistDays})}
                        </div>
                        {/* Other compatible donors */}
                        {allMatches.length>1&&(
                          <div style={{fontSize:13,color:"#b0bec8",marginTop:4}}>
                            +{allMatches.length-1} other compatible donor{allMatches.length>2?"s":""}: {allMatches.slice(1,3).map(m=>m.donor.donor_name?.split(" ")[0]).join(", ")}
                            {allMatches.length>3?` +${allMatches.length-3} more`:""}
                          </div>
                        )}
                      </>
                    ):(
                      <div style={{fontSize:13,color:"#5a3a3a",fontStyle:"italic"}}>
                        No ABO-compatible donor currently in the registry. Consider expanding the donor pool or reviewing blood type requirements.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {recipientMatches.length===0&&(
              <div style={{textAlign:"center",padding:60,color:"#b0bec8"}}>
                No active recipients in the registry yet.
              </div>
            )}
          </div>
        );
      })()}

      {/* Add / Edit */}
      {view==="add"&&(()=>{
        // Unit conversion helpers
        const toKg  = v => unitSystem==="imperial" ? Math.round(parseFloat(v)*0.453592*10)/10 : parseFloat(v);
        const toCm  = v => unitSystem==="imperial" ? Math.round(parseFloat(v)*2.54*10)/10      : parseFloat(v);
        const fromKg= v => unitSystem==="imperial" ? Math.round(parseFloat(v)/0.453592*10)/10  : parseFloat(v);
        const fromCm= v => unitSystem==="imperial" ? Math.round(parseFloat(v)/2.54*10)/10      : parseFloat(v);

        // Display values (converted from stored kg/cm)
        const displayWeight = field => form[field] ? fromKg(form[field]) : "";
        const displayHeight = field => form[field] ? fromCm(form[field]) : "";

        // Store always in metric
        const setWeight = (field, v) => setForm(f=>({...f,[field]: v===''?'': toKg(v)}));
        const setHeight = (field, v) => setForm(f=>({...f,[field]: v===''?'': toCm(v)}));

        // Validation ranges (always in kg/cm stored values)
        const weightWarn = kg => {
          if(!kg) return null;
          const n=parseFloat(kg);
          if(n < 1.5 && n > 0) return "⚠ Weight looks like it may be in meters — enter in " + wLabel;
          if(unitSystem==="imperial"&&n<66) return "⚠ Weight seems low — verify in lbs";
          if(unitSystem==="metric"&&n<30) return "⚠ Weight seems low — verify in kg";
          if(unitSystem==="imperial"&&n>440) return "⚠ Weight seems high — verify in lbs";
          if(unitSystem==="metric"&&n>200) return "⚠ Weight seems high — verify in kg";
          return null;
        };
        const heightWarn = cm => {
          if(!cm) return null;
          const n=parseFloat(cm);
          if(unitSystem==="metric"&&n<3) return "⚠ Height looks like meters — enter in cm (e.g. 175)";
          if(unitSystem==="metric"&&n<120) return "⚠ Height seems low — verify in cm";
          if(unitSystem==="metric"&&n>220) return "⚠ Height seems high — verify in cm";
          if(unitSystem==="imperial"&&n<48) return "⚠ Height seems low — verify in inches";
          if(unitSystem==="imperial"&&n>84) return "⚠ Height seems high — verify in inches";
          return null;
        };
        const praWarn = v => {
          if(v===''||v===undefined||v===null) return null;
          const n=parseFloat(v);
          if(n<0||n>100) return "⚠ PRA must be 0–100%";
          return null;
        };
        const egfrWarn = v => {
          if(!v) return null;
          const n=parseFloat(v);
          if(n<5)  return "⚠ eGFR seems very low — verify";
          if(n>150) return "⚠ eGFR seems high — verify";
          return null;
        };
        const yearWarn = v => {
          if(!v) return null;
          const n=parseInt(v);
          const yr=new Date().getFullYear();
          if(n<1920||n>yr-18) return "⚠ Check year of birth";
          return null;
        };

        const wLabel = unitSystem==="imperial"?"lbs":"kg";
        const hLabel = unitSystem==="imperial"?"inches":"cm";

        return (
        <div style={{...S.page,maxWidth:960}}>
          <h1 style={S.pageTitle}>{editingPair?"Edit Entry":"Register New Entry"}</h1>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
            <p style={{...S.subtitle,margin:0}}>All entries are made by transplant coordinators on behalf of patients.</p>
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:"#131c26",borderRadius:8,border:"1px solid #1e2d3d"}}>
              <span style={{fontSize:13,color:"#c4d0d9",fontFamily:"'DM Mono', monospace"}}>UNITS</span>
              {["metric","imperial"].map(u=>(
                <button key={u} onClick={()=>setUnitSystem(u)}
                  style={{padding:"3px 10px",borderRadius:5,border:"none",cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace",
                    background:unitSystem===u?"#1e3a28":"transparent",color:unitSystem===u?"#2dd4a0":"#90a4b4"}}>
                  {u==="metric"?"Metric (kg/cm)":"Imperial (lbs/in)"}
                </button>
              ))}
              {unitSystem==="imperial"&&<span style={{fontSize:13,color:"#ffd166",marginLeft:4}}>values stored as kg/cm</span>}
            </div>
          </div>

          {!editingPair&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:24}}>
              {PAIR_TYPES.map(({value,label,desc})=>(
                <button key={value} onClick={()=>setForm(f=>({...f,pair_type:value}))}
                  style={{padding:16,borderRadius:10,border:`2px solid ${form.pair_type===value?"#2dd4a0":"#1e2d3d"}`,background:form.pair_type===value?"#0d2a1e":"#131c26",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                  <div style={{fontSize:14,fontWeight:600,color:form.pair_type===value?"#2dd4a0":"#ffffff",marginBottom:4}}>{label}</div>
                  <div style={{fontSize:13,color:"#b0bec5"}}>{desc}</div>
                </button>
              ))}
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:form.pair_type==="paired"?"1fr 1fr":"1fr",gap:20,marginBottom:20}}>
            {(form.pair_type==="paired"||form.pair_type==="recipient_only")&&(
              <div style={S.card}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
                  <div style={{width:3,height:18,borderRadius:2,background:"#3d8c6e"}}/>
                  <span style={{fontFamily:"'DM Sans', sans-serif",fontSize:18,color:"#ffffff"}}>Recipient</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <Field label="Full Name *" value={form.recipient_name} onChange={v=>setForm(f=>({...f,recipient_name:v}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><label style={S.label}>BLOOD TYPE *</label>
                      <select value={form.recipient_blood_type} onChange={e=>setForm(f=>({...f,recipient_blood_type:e.target.value}))} style={S.select}>
                        {["A","B","AB","O"].map(o=><option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <div>
                      <Field label="Year Born *" type="number" placeholder="e.g. 1975" value={form.recipient_year_born} onChange={v=>setForm(f=>({...f,recipient_year_born:v}))}/>
                      {yearWarn(form.recipient_year_born)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{yearWarn(form.recipient_year_born)}</div>}
                    </div>
                  </div>
                  <div>
                    <Field label="PRA %" type="number" placeholder="0–100" value={form.recipient_pra_percent} onChange={v=>setForm(f=>({...f,recipient_pra_percent:v}))}/>
                    {praWarn(form.recipient_pra_percent)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{praWarn(form.recipient_pra_percent)}</div>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <Field label={`Weight (${wLabel})`} type="number" value={displayWeight("recipient_weight_kg")} onChange={v=>setWeight("recipient_weight_kg",v)}/>
                      {weightWarn(form.recipient_weight_kg)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{weightWarn(form.recipient_weight_kg)}</div>}
                    </div>
                    <div>
                      <Field label={`Height (${hLabel})`} type="number" value={displayHeight("recipient_height_cm")} onChange={v=>setHeight("recipient_height_cm",v)}/>
                      {heightWarn(form.recipient_height_cm)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{heightWarn(form.recipient_height_cm)}</div>}
                    </div>
                  </div>
                  <div><label style={S.label}>CMV STATUS</label>
                    <select value={form.recipient_cmv} onChange={e=>setForm(f=>({...f,recipient_cmv:e.target.value}))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o=><option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div style={{borderTop:"1px solid #1e2d3d",paddingTop:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <label style={{...S.label,marginBottom:0}}>HLA TYPING <span style={{color:"#b0bec8"}}>(optional)</span></label>
                      <button onClick={()=>setShowHLAAdvanced(v=>!v)} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace"}}>
                        {showHLAAdvanced?"▲ hide":"▼ individual fields"}
                      </button>
                    </div>
                    <Field label="HLA Notes (paste Epic output)" placeholder="e.g. A*02:01 A*24:02 B*07:02..." value={form.recipient_hla_notes} onChange={v=>setForm(f=>({...f,recipient_hla_notes:v}))}/>
                    {showHLAAdvanced&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:8}}>
                        {["A1","A2","B1","B2","DR1","DR2"].map(h=>(
                          <div key={h}><label style={{...S.label,fontSize:13}}>HLA-{h}</label>
                            <input value={form[`recipient_hla_${h.toLowerCase()}`]||""} onChange={e=>setForm(f=>({...f,[`recipient_hla_${h.toLowerCase()}`]:e.target.value}))}
                              style={{...S.input,padding:"6px 8px",fontSize:13,fontFamily:"'DM Mono', monospace"}}/>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <Field label="Waitlist Date (UNOS)" type="date" value={form.recipient_dialysis_start} onChange={v=>setForm(f=>({...f,recipient_dialysis_start:v}))}/>
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
                  <span style={{fontFamily:"'DM Sans', sans-serif",fontSize:18,color:"#ffffff"}}>{form.pair_type==="altruistic"?"Altruistic Donor":"Donor"}</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  <Field label="Full Name *" value={form.donor_name} onChange={v=>setForm(f=>({...f,donor_name:v}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><label style={S.label}>BLOOD TYPE *</label>
                      <select value={form.donor_blood_type} onChange={e=>setForm(f=>({...f,donor_blood_type:e.target.value}))} style={S.select}>
                        {["A","B","AB","O"].map(o=><option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <div>
                      <Field label="Year Born *" type="number" placeholder="e.g. 1975" value={form.donor_year_born} onChange={v=>setForm(f=>({...f,donor_year_born:v}))}/>
                      {yearWarn(form.donor_year_born)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{yearWarn(form.donor_year_born)}</div>}
                    </div>
                  </div>
                  <div>
                    <Field label="eGFR (mL/min)" type="number" value={form.donor_egfr} onChange={v=>setForm(f=>({...f,donor_egfr:v}))}/>
                    {egfrWarn(form.donor_egfr)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{egfrWarn(form.donor_egfr)}</div>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <Field label={`Weight (${wLabel})`} type="number" value={displayWeight("donor_weight_kg")} onChange={v=>setWeight("donor_weight_kg",v)}/>
                      {weightWarn(form.donor_weight_kg)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{weightWarn(form.donor_weight_kg)}</div>}
                    </div>
                    <div>
                      <Field label={`Height (${hLabel})`} type="number" value={displayHeight("donor_height_cm")} onChange={v=>setHeight("donor_height_cm",v)}/>
                      {heightWarn(form.donor_height_cm)&&<div style={{fontSize:13,color:"#ffd166",marginTop:3}}>{heightWarn(form.donor_height_cm)}</div>}
                    </div>
                  </div>
                  <div><label style={S.label}>CMV STATUS</label>
                    <select value={form.donor_cmv} onChange={e=>setForm(f=>({...f,donor_cmv:e.target.value}))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o=><option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div style={{borderTop:"1px solid #1e2d3d",paddingTop:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <label style={{...S.label,marginBottom:0}}>HLA TYPING <span style={{color:"#b0bec8"}}>(optional)</span></label>
                      <button onClick={()=>setShowHLAAdvanced(v=>!v)} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace"}}>
                        {showHLAAdvanced?"▲ hide":"▼ individual fields"}
                      </button>
                    </div>
                    <Field label="HLA Notes (paste Epic output)" placeholder="e.g. A*01 A*03 B*08 B*35..." value={form.donor_hla_notes} onChange={v=>setForm(f=>({...f,donor_hla_notes:v}))}/>
                    {showHLAAdvanced&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:8}}>
                        {["A1","A2","B1","B2","DR1","DR2"].map(h=>(
                          <div key={h}><label style={{...S.label,fontSize:13}}>HLA-{h}</label>
                            <input value={form[`donor_hla_${h.toLowerCase()}`]||""} onChange={e=>setForm(f=>({...f,[`donor_hla_${h.toLowerCase()}`]:e.target.value}))}
                              style={{...S.input,padding:"6px 8px",fontSize:13,fontFamily:"'DM Mono', monospace"}}/>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <input type="checkbox" id="backup" checked={form.donor_backup||false} onChange={e=>setForm(f=>({...f,donor_backup:e.target.checked}))}/>
                    <label htmlFor="backup" style={{fontSize:13,color:"#b0bec5",cursor:"pointer"}}>Designated backup donor</label>
                  </div>
                  <div>
                    <label style={S.label}>DONOR PRIORITY</label>
                    <div style={{display:"flex",gap:8,marginTop:4}}>
                      {DONOR_PRIORITIES.map(p=>(
                        <button key={p} onClick={()=>setForm(f=>({...f,donor_priority:p}))}
                          style={{flex:1,padding:"7px 0",borderRadius:7,border:`1.5px solid ${form.donor_priority===p?"#6ab4d0":"#1e2d3d"}`,
                            background:form.donor_priority===p?"#0d2030":"#131c26",
                            color:form.donor_priority===p?"#6ab4d0":"#90a4b4",
                            cursor:"pointer",fontSize:13,fontFamily:"'DM Mono', monospace",transition:"all 0.15s"}}>
                          {p}
                        </button>
                      ))}
                    </div>
                    <div style={{fontSize:13,color:"#b0bec8",marginTop:5}}>
                      {form.donor_priority==="Primary"&&"First-choice donor for this recipient — evaluated first in matching"}
                      {form.donor_priority==="Secondary"&&"Second-choice donor — evaluated if primary doesn't match"}
                      {form.donor_priority==="Tertiary"&&"Third-choice donor — fallback option if primary and secondary don't match"}
                    </div>
                  </div>
                  <Field label="ZIP Code" placeholder="e.g. 94109" value={form.donor_zip} onChange={v=>setForm(f=>({...f,donor_zip:v}))}/>
                </div>
              </div>
            )}
          </div>

          <div style={{...S.card,marginBottom:20}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              {form.pair_type==="paired"&&(
                <div><label style={S.label}>DONOR-RECIPIENT RELATIONSHIP</label>
                  <select value={form.recipient_relationship} onChange={e=>setForm(f=>({...f,recipient_relationship:e.target.value}))} style={S.select}>
                    {["","Spouse/Partner","Parent","Sibling","Child","Friend","Other"].map(r=><option key={r} value={r}>{r||"Select…"}</option>)}
                  </select>
                </div>
              )}
              <div><label style={S.label}>TRANSPLANT CENTER</label>
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
            <button onClick={handleAdd} disabled={adding} style={{...S.btn,background:"#1a6b45",color:"#ffffff"}}>
              {adding?(editingPair?"Saving…":"Registering…"):(editingPair?"Save Changes":"Register")}
            </button>
            <button onClick={()=>{setView("grid");setEditingPair(null);setForm(emptyForm);}}
              style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Cancel</button>
          </div>
        </div>
        );
      })()}

      {/* Detail */}
      {view==="detail"&&selected&&(()=>{
        const{donor,recipient,result}=selected;
        const s=scoreStyle(result.score,result.aboOnly);
        const dAge=calcAge(donor.donor_year_born),rAge=calcAge(recipient.recipient_year_born);
        return (
          <div style={{...S.page,maxWidth:860}}>
            <button onClick={()=>setView("grid")} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontFamily:"'DM Mono', monospace",fontSize:13,padding:0,marginBottom:24,letterSpacing:"0.05em"}}>← BACK TO GRID</button>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:28,flexWrap:"wrap",gap:16}}>
              <div>
                <h1 style={S.pageTitle}>Pair Score Report</h1>
                <p style={{margin:"4px 0 0",color:"#b0bec5",fontSize:13}}>{donor.donor_name} → {recipient.recipient_name}</p>
                {result.aboOnly&&result.reasons.abo&&<p style={{margin:"6px 0 0",padding:"6px 10px",borderRadius:6,background:"#0d1e2e",border:"1px solid #1a3a5a",color:"#6ab4d0",fontSize:13,display:"inline-block"}}>ABO compatible ✓ — enter HLA data to generate a Pair Score</p>}
                {!result.reasons.abo&&<p style={{margin:"6px 0 0",padding:"6px 10px",borderRadius:6,background:"#2a1010",border:"1px solid #3a1010",color:"#ff8a8a",fontSize:13,display:"inline-block"}}>ABO incompatible — exchange not possible without chain</p>}
              </div>
              {result.score!==null&&(
              <div style={{textAlign:"center",padding:"14px 22px",borderRadius:12,background:s.bg,border:`1px solid ${s.text}33`}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:`${s.text}aa`,letterSpacing:"0.1em",marginBottom:4}}>PAIR SCORE</div>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:40,fontWeight:500,color:s.text,lineHeight:1}}>{result.score}</div>
                <div style={{fontSize:13,color:`${s.text}cc`,marginTop:4,letterSpacing:"0.1em"}}>{s.label.toUpperCase()}</div>
                <div style={{fontSize:13,color:`${s.text}cc`,marginTop:6}}>out of 100</div>
              </div>
              )}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
              {[
                {label:"ABO Compatibility",value:result.reasons.abo?"Compatible ✓":"Incompatible ✗",ok:result.reasons.abo,detail:`${donor.donor_blood_type} → ${recipient.recipient_blood_type}`},
                {label:"HLA Mismatches",value:result.aboOnly?"Not entered":result.reasons.hlaMismatches+" / 6",ok:!result.aboOnly&&result.reasons.hlaMismatches<=2,warn:!result.aboOnly&&result.reasons.hlaMismatches<=4,detail:result.aboOnly?"Enter HLA alleles for a Pair Score":"0 = perfect match · 6 = full mismatch · drives 60% of score"},
                {label:"PRA Sensitization",value:`${recipient.recipient_pra_percent||"?"}%`,ok:result.reasons.highSensitization,warn:result.reasons.moderatePRA,detail:result.reasons.highSensitization?"Highly sensitized — match earns highest PRA bonus":result.reasons.moderatePRA?"Moderately sensitized — partial bonus if matched":"Low sensitization"},
                {label:"Size Compatibility",value:result.reasons.sizeMatch?"Acceptable":"Flag",ok:result.reasons.sizeMatch,detail:`Donor ${donor.donor_weight_kg||"?"}kg → Recipient ${recipient.recipient_weight_kg||"?"}kg · >20kg gap flagged`},
                {label:"CMV Risk",value:result.reasons.cmvRisk?"D+/R− Risk":"Acceptable",ok:!result.reasons.cmvRisk,detail:`Donor ${donor.donor_cmv||"?"} / Recipient ${recipient.recipient_cmv||"?"} · D+/R− increases recipient risk`},
                {label:"Age Gap",value:dAge&&rAge?`${result.reasons.ageDiff} yrs`:"Unknown",ok:!result.reasons.ageFlag,detail:`Donor ${dAge||"?"}y · Recipient ${rAge||"?"}y · >15yr gap flagged`},
                {label:"Donor eGFR",value:donor.donor_egfr?`${donor.donor_egfr} mL/min`:"Not recorded",ok:(donor.donor_egfr||0)>=60,detail:(donor.donor_egfr||0)>=60?"Adequate renal function":"Below 60 — review required"},
                {label:"Virtual Crossmatch",value:recipient.recipient_crossmatch_virtual||"Not recorded",ok:recipient.recipient_crossmatch_virtual==="Negative",detail:"Negative = no known antibody conflict · overrides score if available"},
              ].map(({label,value,ok,warn,detail})=>(
                <div key={label} style={{...S.card,borderColor:ok?"#1a3028":warn?"#2a2010":"#2a1010"}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:13,color:"#b0bec5"}}>{label}</span>
                    <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:ok?"#2dd4a0":warn?"#ffd166":"#ff8a8a"}}>{value}</span>
                  </div>
                  <div style={{fontSize:13,color:"#b0bec8",marginTop:5}}>{detail}</div>
                </div>
              ))}
            </div>
            <div style={{...S.card,marginBottom:16}}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",letterSpacing:"0.1em",marginBottom:12}}>HLA ALLELE COMPARISON</div>
              {(donor.donor_hla_notes||recipient.recipient_hla_notes)&&(
                <div style={{marginBottom:12,fontSize:13,color:"#b0bec5"}}>
                  {donor.donor_hla_notes&&<div>Donor: <span style={{fontFamily:"'DM Mono', monospace",color:"#6ab4d0"}}>{donor.donor_hla_notes}</span></div>}
                  {recipient.recipient_hla_notes&&<div style={{marginTop:4}}>Recipient: <span style={{fontFamily:"'DM Mono', monospace",color:"#6ad0a0"}}>{recipient.recipient_hla_notes}</span></div>}
                </div>
              )}
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr>{["LOCUS","DONOR","RECIPIENT","MM"].map(h=><th key={h} style={{textAlign:h==="LOCUS"?"left":"center",padding:"6px 10px",fontFamily:"'DM Mono', monospace",fontSize:13,color:"#c4d0d9",fontWeight:400}}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {["A","B","DR"].map(locus=>{
                    const dl=[donor[`donor_hla_${locus.toLowerCase()}1`],donor[`donor_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const rl=[recipient[`recipient_hla_${locus.toLowerCase()}1`],recipient[`recipient_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const mm=dl.filter(a=>!rl.includes(a)).length;
                    return (
                      <tr key={locus} style={{borderTop:"1px solid #141c24"}}>
                        <td style={{padding:"9px 10px",fontFamily:"'DM Mono', monospace",fontSize:13,color:"#b0bec5"}}>HLA-{locus}</td>
                        <td style={{padding:"9px 10px",textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:13,color:"#6ab4d0"}}>{dl.join(" / ")||"—"}</td>
                        <td style={{padding:"9px 10px",textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:13,color:"#6ad0a0"}}>{rl.join(" / ")||"—"}</td>
                        <td style={{padding:"9px 10px",textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:13,color:mm===0?"#2dd4a0":mm===1?"#ffd166":"#ff8a8a"}}>{dl.length?`${mm} MM`:"—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:10,marginBottom:16}}>
              <button onClick={()=>window.print()} style={{...S.btn,background:"#0f2d1e",color:"#4db882"}}>Print Report</button>
            </div>
            <div style={{padding:"12px 16px",borderRadius:8,background:"#0d1a14",border:"1px solid #1a3028",fontSize:13,color:"#3d6a50"}}>
              ⚠ Pair Score is a computational screening tool, not a validated clinical index. Weights are provisional and should be reviewed with transplant professionals before operational use. All matches require crossmatch confirmation before any clinical decision.
            </div>
          </div>
        );
      })()}
      <style>{`select option{background:#1a2535;color:#e8e4dc;}input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5);}@media print{header,nav{display:none!important;}}`}</style>
    </div>
  );
}