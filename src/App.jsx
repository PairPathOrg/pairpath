import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500;600&display=swap";
document.head.appendChild(fontLink);

// ── Matching Engine ────────────────────────────────────────────────────────
const ABO_COMPATIBLE = { O:["O","A","B","AB"], A:["A","AB"], B:["B","AB"], AB:["AB"] };
function calcAge(y) { if(!y) return null; const yr=parseInt(y); return (yr>=1900&&yr<=new Date().getFullYear())?new Date().getFullYear()-yr:null; }
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
//   Modifiers (15pts): CMV D+/R- risk (-8), size mismatch >20kg (-4), age gap >15yr (-3)
//   Blood type bonus  : O→O exact match +8 (preserves O donor for O-only recipients),
//                       other exact type match (A→A, B→B, AB→AB) +4.
//                       O donor → non-O recipient is compatible but flagged as
//                       suboptimal chain use (no bonus, no penalty).
//
// TODO: Validate weights against published KPD outcomes data.
// TODO: Consider dialysis vintage (time on dialysis) as a prioritization factor.
// TODO: Crossmatch result should override score entirely if available.
function calculateCompatibility(donor, recipient) {
  if (!donor?.donor_blood_type || !recipient?.recipient_blood_type) {
    return { compatible: false, score: null, aboOnly: true, reasons: {} };
  }

  const dBlood = donor.donor_blood_type;
  const rBlood = recipient.recipient_blood_type;
  const aboOk = checkABO(dBlood, rBlood);
  const hasHLA = !!(donor.donor_hla_a1 || donor.donor_hla_notes || recipient.recipient_hla_a1 || recipient.recipient_hla_notes);

  const hlaMismatches = hasHLA ? countHLAMismatches(donor, recipient) : 0;
  const pra = recipient.recipient_pra_percent || 0;
  const highPRA = pra > 80;
  const moderatePRA = pra > 50 && pra <= 80;
  const sizeDiff = Math.abs((donor.donor_weight_kg || 70) - (recipient.recipient_weight_kg || 70));
  const sizeOk = sizeDiff < 20;
  const cmvRisk = donor.donor_cmv === "Positive" && recipient.recipient_cmv === "Negative";
  const dAge = calcAge(donor.donor_year_born), rAge = calcAge(recipient.recipient_year_born);
  const ageDiff = dAge && rAge ? Math.abs(dAge - rAge) : 0;
  const ageFlag = ageDiff > 15;
  const bmi = donor.donor_weight_kg && donor.donor_height_cm
    ? donor.donor_weight_kg / Math.pow(donor.donor_height_cm / 100, 2) : null;
  const bmiFlag = bmi && bmi > 35;

  // Blood type efficiency bonus
  // O→O: highest bonus — O recipients can ONLY receive O donors, so this is the ideal use
  // Exact match (A→A, B→B, AB→AB): smaller bonus — preserves flexibility in chains
  // O→non-O: compatible but no bonus (O donor is being "used up" on a recipient who has more options)
  const oToO = dBlood === "O" && rBlood === "O";
  const exactBloodMatch = dBlood === rBlood;
  const bloodBonus = oToO ? 8 : exactBloodMatch ? 4 : 0;
  const suboptimalOUse = dBlood === "O" && rBlood !== "O"; // informational flag only

  // No number shown without HLA — only ABO status
  if (!aboOk) {
    return {
      compatible: false, score: 0, aboOnly: !hasHLA,
      reasons: { abo: false, hlaMismatches: 0, highSensitization: highPRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff, pra, oToO, exactBloodMatch, suboptimalOUse }
    };
  }
  if (!hasHLA) {
    // ABO compatible but no HLA — cap at 70 so coordinators know scores above 70 mean HLA was entered.
    // Blood type bonus intentionally excluded here — it only applies when full data is present.
    const aboScore = Math.min(70, Math.max(0, 70 - (highPRA ? 15 : 0) - (sizeOk ? 0 : 4) - (cmvRisk ? 8 : 0) - (ageFlag ? 3 : 0)));
    return {
      compatible: true, score: aboScore, aboOnly: true,
      reasons: { abo: true, hlaMismatches: 0, highSensitization: highPRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff, pra, oToO, exactBloodMatch, suboptimalOUse }
    };
  }

  // Full scored path — 0 to 100
  const hlaPoints = Math.max(0, 60 - hlaMismatches * 10);

  // PRA: high PRA recipient successfully matched = clinical win, award points
  const praPoints = highPRA ? 25 : moderatePRA ? 18 : 15;

  // Modifiers (deductions only)
  const cmvPenalty  = cmvRisk  ?  8 : 0;
  const sizePenalty = sizeOk   ?  0 : 4;
  const agePenalty  = ageFlag  ?  3 : 0;
  const bmiPenalty  = bmiFlag  ?  2 : 0;

  const score = Math.min(100, Math.max(0,
    hlaPoints + praPoints + bloodBonus - cmvPenalty - sizePenalty - agePenalty - bmiPenalty
  ));

  return {
    compatible: hlaMismatches <= 4,
    score,
    aboOnly: false,
    reasons: { abo: true, hlaMismatches, highSensitization: highPRA, moderatePRA, sizeMatch: sizeOk, cmvRisk, ageFlag, bmiFlag, ageDiff, pra, oToO, exactBloodMatch, suboptimalOUse }
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
        altruistic: donor.pair_type === "altruistic"
      };

      chain.push(step);

      if (chain.length >= 2) {
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

  // Keep only chains where no longer chain starts with the same donor sequence
  const filtered = allChains.filter(chain => {
    const seq = donorSequence(chain);
    return !allChains.some(other =>
      other.length > chain.length &&
      donorSequence(other).startsWith(seq)
    );
  });

  // Among remaining, deduplicate by exact donor sequence
  const seenSeqs = new Set();
  const deduped = filtered.filter(chain => {
    const seq = donorSequence(chain);
    if (seenSeqs.has(seq)) return false;
    seenSeqs.add(seq);
    return true;
  });

  return deduped.sort((a,b) =>
    b.length - a.length ||
    b.reduce((sum,c)=>sum+c.score,0) - a.reduce((sum,c)=>sum+c.score,0)
  ).slice(0, MAX_RESULTS);
}

// ── Pair Score display helpers ─────────────────────────────────────────────
function scoreStyle(score, aboOnly) {
  if (score >= 70) return { bg: "#0d7a52", text: "#7fffd4", label: aboOnly ? "ABO Compatible" : "Compatible" };
  if (score >= 40) return { bg: "#7a5500", text: "#ffd166", label: aboOnly ? "ABO Marginal" : "Marginal" };
  return { bg: "#7a1010", text: "#ff9999", label: "Incompatible" };
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

// ── CSV ────────────────────────────────────────────────────────────────────
function downloadDeIDTemplate() {
  // Simple two-sheet approach via CSV — one file for donors, one for recipients
  // Plain, no styling, 100 rows each, clear headers
  const recipRows = [["Recipient ID","Full Name (Last, First)","Notes"]];
  const donorRows = [["Donor ID","Full Name (Last, First)","Notes"]];
  for(let i=1;i<=100;i++){recipRows.push([`R${i}`,"",""]);}
  for(let i=1;i<=100;i++){donorRows.push([`D${i}`,"",""]);}

  // Combine into one CSV with a separator
  const lines=[
    "PAIRPATH DE-IDENTIFICATION LOOKUP TABLE",
    "Fill in before uploading to PairPath. Keep this file private.",
    "Assign IDs to your patients then upload D1/R1 etc. as names in PairPath.",
    "",
    "--- RECIPIENTS ---",
    ...recipRows.map(r=>r.join(",")),
    "",
    "--- DONORS ---",
    ...donorRows.map(r=>r.join(",")),
    "",
    "--- COPILOT RE-IDENTIFICATION PROMPT ---",
    "Paste this into Copilot after exporting matches from PairPath:",
    "",
    '"I have two files. File 1 is my ID lookup table with columns: ID and Full Name.',
    'File 2 is a match export from PairPath with columns: Donor Recipient Pair Score and others.',
    'The Donor and Recipient columns contain anonymized IDs like D1 R3 etc.',
    'Please replace each Donor ID with the matching Full Name from File 1.',
    'Do the same for the Recipient column.',
    'Keep all other columns unchanged.',
    'Output a clean spreadsheet sorted by Pair Score highest to lowest.',
    'Tell me if any ID in the match export is not found in the lookup table."',
  ];

  const blob=new Blob([lines.join("\n")],{type:"text/csv"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="PairPath_DeID_Lookup.csv";a.click();
}

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
    const sanitizeWt=v=>{const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,"")));return(!isNaN(n)&&n>0&&n<400)?n:null;};
    const recipWtClean=sanitizeWt(recip.recipient_weight_kg);
    const weightDiff=best&&best.donor.donor_weight_kg&&recip.recipient_weight_kg
      ?Math.abs((sanitizeWt(best.donor.donor_weight_kg)||0)-(recipWtClean||0)):null;
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
              ${recipWtClean!=null?`<span>Weight: ${recipWtClean}kg</span>`:""}
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
  const rows = [];
  donors.forEach(donor=>{
    recipients.forEach(recipient=>{
      if(donor.id===recipient.id) return;
      const result = calculateCompatibility(donor, recipient);
      if(!result.reasons.abo) return;
      const cleanWt = v => { const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,""))); return (!isNaN(n)&&n>0&&n<400)?n:""; };
      const cleanHt = v => { const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,""))); return (!isNaN(n)&&n>0&&n<250)?n:""; };
      const donorWt  = cleanWt(donor.donor_weight_kg);
      const recipWt  = cleanWt(recipient.recipient_weight_kg);
      const donorHt  = cleanHt(donor.donor_height_cm);
      const recipHt  = cleanHt(recipient.recipient_height_cm);
      const waitlist = recipient.recipient_dialysis_start
        ? new Date(recipient.recipient_dialysis_start).toLocaleDateString("en-US",{month:"2-digit",day:"2-digit",year:"numeric"}) : "";
      const cmvFlag = donor.donor_cmv==="Positive"&&recipient.recipient_cmv==="Negative"?"⚠ CMV D+/R-":"";
      const sizeFlag = donorWt&&recipWt&&Math.abs(donorWt-recipWt)>20?"⚠ Size gap":"";
      const flags = [cmvFlag,sizeFlag].filter(Boolean).join("; ")||"None";
      rows.push({
        pair_score:               result.score ?? "ABO only",
        donor:                    donor.donor_name || donor.id,
        donor_blood:              donor.donor_blood_type,
        donor_age:                calcAge(donor.donor_year_born)||"",
        donor_height:             donorHt,
        donor_weight:             donorWt,
        donor_egfr:               donor.donor_egfr||"",
        donor_cmv:                donor.donor_cmv||"",
        recipient:                recipient.recipient_name || recipient.id,
        recipient_blood:          recipient.recipient_blood_type,
        recipient_age:            calcAge(recipient.recipient_year_born)||"",
        recipient_height:         recipHt,
        recipient_weight:         recipWt,
        recipient_cmv:            recipient.recipient_cmv||"",
        pra:                      recipient.recipient_pra_percent ?? "",
        waitlist_date:            waitlist,
        waitlist_duration:        (()=>{const d=recipient.recipient_dialysis_start?Math.floor((Date.now()-new Date(recipient.recipient_dialysis_start))/86400000):null;return d?(d>365?`${Math.floor(d/365)}yr ${Math.floor((d%365)/30)}mo`:`${d} days`):"—";})(),
        waitlist_rank:            "",
        weight_gap_kg:            donorWt&&recipWt?Math.abs(donorWt-recipWt):"",
        flags,
        hla_notes:                recipient.recipient_hla_notes||donor.donor_hla_notes||"",
        intended_recipient:       "",
        intended_recipient_blood: "",
        intended_recipient_age:   "",
        swap:                     "",
      });
    });
  });
  rows.sort((a,b)=>(b.pair_score==="ABO only"?0:b.pair_score)-(a.pair_score==="ABO only"?0:a.pair_score));

  let header, lines;
  if(level==="quick"){
    header = "Pair Score,Donor,Donor Blood,Donor Age,Donor Height (cm),Donor Weight (kg),Recipient,Recipient Blood,Recipient Age,Recipient Height (cm),Recipient Weight (kg),PRA %,Waitlist Duration,Waitlist Rank,Flags,Intended Recipient,Intended Recipient Blood,Intended Recipient Age,Swap";
    lines  = rows.map(r=>[r.pair_score,r.donor,r.donor_blood,r.donor_age,r.donor_height,r.donor_weight,r.recipient,r.recipient_blood,r.recipient_age,r.recipient_height,r.recipient_weight,r.pra,r.waitlist_duration,r.waitlist_rank,r.flags,r.intended_recipient,r.intended_recipient_blood,r.intended_recipient_age,r.swap].join(","));
  } else if(level==="full"){
    header = "Pair Score,Donor,Donor Blood,Donor Age,Donor Height (cm),Donor Weight (kg),Donor eGFR,Donor CMV,Recipient,Recipient Blood,Recipient Age,Recipient Height (cm),Recipient Weight (kg),Recipient CMV,PRA %,Waitlist Date,Waitlist Duration,Waitlist Rank,Weight Gap (kg),Flags,HLA Notes,Intended Recipient,Intended Recipient Blood,Intended Recipient Age,Swap";
    lines  = rows.map(r=>[r.pair_score,r.donor,r.donor_blood,r.donor_age,r.donor_height,r.donor_weight,r.donor_egfr,r.donor_cmv,r.recipient,r.recipient_blood,r.recipient_age,r.recipient_height,r.recipient_weight,r.recipient_cmv,r.pra,r.waitlist_date,r.waitlist_duration,r.waitlist_rank,r.weight_gap_kg,r.flags,r.hla_notes,r.intended_recipient,r.intended_recipient_blood,r.intended_recipient_age,r.swap].join(","));
  } else {
    // standard
    header = "Pair Score,Donor,Donor Blood,Donor Age,Donor Height (cm),Donor Weight (kg),Recipient,Recipient Blood,Recipient Age,Recipient Height (cm),Recipient Weight (kg),PRA %,Waitlist Duration,Waitlist Rank,Weight Gap (kg),Flags,Intended Recipient,Intended Recipient Blood,Intended Recipient Age,Swap";
    lines  = rows.map(r=>[r.pair_score,r.donor,r.donor_blood,r.donor_age,r.donor_height,r.donor_weight,r.recipient,r.recipient_blood,r.recipient_age,r.recipient_height,r.recipient_weight,r.pra,r.waitlist_duration,r.waitlist_rank,r.weight_gap_kg,r.flags,r.intended_recipient,r.intended_recipient_blood,r.intended_recipient_age,r.swap].join(","));
  }
  const blob = new Blob([[header,...lines].join("\n")],{type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`pairpath_matches_${level}.csv`; a.click();
}

function parseYearFromAny(val) {
  // Handles: YYYY, MM/DD/YYYY, YYYY-MM-DD, Excel serial (40000-60000), full ISO datetime
  if (!val) return val;
  const s = String(val).trim();
  // Excel serial date — covers full range including birth years back to 1900 (serial ~1)
  const n = parseFloat(s);
  if (!isNaN(n) && n > 1 && n < 60000) {
    const date = new Date((n - 25569) * 86400000);
    return String(date.getUTCFullYear());
  }
  // ISO date or datetime: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  if (s.includes("-")) return s.split("-")[0];
  // MM/DD/YYYY or MM/DD/YY
  if (s.includes("/")) { const p=s.split("/"); return p[2]?.length===4?p[2]:`20${p[2]}`; }
  // Already a 4-digit year
  if (/^\d{4}$/.test(s)) return s;
  return val;
}

function parseCSV(text, userId) {
  const [headerLine,...rows] = text.trim().split("\n");
  const headers = headerLine.split(",").map(h=>h.trim());
  return rows.filter(r=>r.trim()).map(row => {
    const vals = row.split(",").map(v=>v.trim().replace(/^"|"$/g,""));
    const obj = {};
    headers.forEach((h,i) => { obj[h] = vals[i]||""; });
    // Handle DOB columns → extract year
    if (obj.recipient_dob) obj.recipient_year_born = parseYearFromAny(obj.recipient_dob);
    if (obj.donor_dob) obj.donor_year_born = parseYearFromAny(obj.donor_dob);
    // Also clean year_born fields themselves in case they came in as dates or serials
    if (obj.recipient_year_born) obj.recipient_year_born = parseYearFromAny(obj.recipient_year_born);
    if (obj.donor_year_born) obj.donor_year_born = parseYearFromAny(obj.donor_year_born);
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
      {keys:["donor_blood_type","donor_abo"],field:"donor_blood_type"},
      {keys:["donor_egfr","egfr","gfr"],field:"donor_egfr"},
      {keys:["donor_weight"],field:"donor_weight_kg"},
      {keys:["donor_height"],field:"donor_height_cm"},
      {keys:["donor_cmv"],field:"donor_cmv"},
      {keys:["donor_dob"],field:"donor_year_born"},
    ]:[]),
    // Generic fields that could be either — map based on pairType
    {keys:["name","patient name","full name","pt name"],field:isDonorOnly?"donor_name":"recipient_name"},
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

// ── Styles ─────────────────────────────────────────────────────────────────
const S = {
  app: {minHeight:"100vh",background:"#131c26",color:"#ffffff",fontFamily:"'DM Sans', sans-serif",fontSize:14},
  header: {borderBottom:"1px solid #1e2d3d",padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:64,background:"#0a0f18",gap:12},
  navBtn: a => ({padding:"8px 16px",borderRadius:6,border:"none",cursor:"pointer",fontSize:14,fontWeight:600,background:a?"#0f2d1e":"transparent",color:a?"#4db882":"#c0cdd8",transition:"all 0.15s"}),
  page: {padding:"28px 32px",maxWidth:1400,margin:"0 auto"},
  pageTitle: {fontFamily:"'DM Sans', sans-serif",fontSize:28,fontWeight:700,margin:"0 0 6px",color:"#ffffff"},
  subtitle: {margin:"0 0 24px",color:"#b0bec5",fontSize:14},
  card: {background:"#131c26",border:"1px solid #1e2d3d",borderRadius:12,padding:18},
  input: {width:"100%",boxSizing:"border-box",background:"#1a2535",border:"1px solid #2a3d52",borderRadius:6,padding:"10px 12px",color:"#ffffff",fontSize:14,fontFamily:"'DM Sans', sans-serif",outline:"none"},
  select: {width:"100%",background:"#1a2535",border:"1px solid #2a3d52",borderRadius:6,padding:"10px 12px",color:"#ffffff",fontSize:14,fontFamily:"'DM Sans', sans-serif",outline:"none",cursor:"pointer"},
  label: {fontFamily:"'DM Mono', monospace",fontSize:11,color:"#90a4b4",letterSpacing:"0.08em",display:"block",marginBottom:5},
  btn: {padding:"10px 22px",borderRadius:7,border:"none",cursor:"pointer",fontFamily:"'DM Sans', sans-serif",fontWeight:600,fontSize:14,transition:"all 0.15s"},
  tag: c => ({fontSize:11,padding:"3px 9px",borderRadius:4,background:`${c}22`,color:c,fontFamily:"'DM Mono', monospace",letterSpacing:"0.05em"}),
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
        <span style={{fontSize:12,color:"#3a4f66",lineHeight:1.55}}>
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
          <div style={{fontSize:15,color:"rgba(255,255,255,0.65)",lineHeight:1.7,marginBottom:40}}>
            Every willing donor. Every Listed Active recipient. Scored, ranked, and matched — across the exchanges your current workflow was never built to find.
          </div>

          {/* Stats */}
          <div style={{display:"flex",gap:32,marginBottom:48}}>
            {[["6-WAY","Max chain depth"],["0–100","Pair Score range"],["<1 min","Time to match"]].map(([val,label])=>(
              <div key={label}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:26,fontWeight:500,color:"#4db882",lineHeight:1}}>{val}</div>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:4,letterSpacing:"0.08em"}}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Privacy statement */}
        <div style={{background:"rgba(77,184,130,0.08)",border:"1px solid rgba(77,184,130,0.2)",borderRadius:8,padding:"14px 16px",marginBottom:24,maxWidth:400}}>
          <div style={{fontFamily:"'DM Mono', monospace",fontSize:9,color:"#4db882",letterSpacing:"0.12em",marginBottom:6}}>PRIVACY BY DESIGN</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",lineHeight:1.65}}>
            PairPath uses built-in de-identification tools so real patient names never leave your computer. Identifiers like D1 and R1 are all the system needs — and all it ever sees. Your registry data is stored securely and is never shared, sold, or used for any purpose outside of your matching workflow.
          </div>
        </div>

        {/* Bottom tagline */}
        <div style={{fontSize:12,color:"rgba(255,255,255,0.3)",lineHeight:1.6,maxWidth:380,fontStyle:"italic"}}>
          Built independently, outside of institutional affiliation, by someone inside the transplant field — because this infrastructure should exist.
        </div>
      </div>

      {/* Right form panel */}
      <div style={{flex:1,background:"#ffffff",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"48px 40px",minHeight:"100vh",boxSizing:"border-box"}}>
        <div style={{width:"100%",maxWidth:400}}>
          {/* Logo */}
          <div style={{textAlign:"center",marginBottom:32}}>
            <LogoMark size={52} variant="light"/>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:28,fontWeight:700,letterSpacing:"-0.5px",marginTop:12,marginBottom:4}}>
              <span style={{color:"#1e3448"}}>Pair</span><span style={{color:"#1a6b45",fontWeight:300}}>Path</span>
            </div>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:14,fontWeight:300,color:"#1a6b45"}}>
              Every exchange starts here.
            </div>
          </div>

          {/* Mode tabs — login vs signup */}
          {mode!=="reset_sent"&&(
            <div style={{display:"flex",gap:4,marginBottom:24,background:"#f2f0eb",borderRadius:8,padding:4}}>
              {[["login","Sign In"],["signup","Create Account"]].map(([m,l])=>(
                <button key={m} onClick={()=>{setMode(m);setError("");setSuccess("");setLocked(false);}} style={{flex:1,padding:"8px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:600,background:mode===m?"#ffffff":"transparent",color:mode===m?"#1e3448":"#6a7a8a",boxShadow:mode===m?"0 1px 4px rgba(0,0,0,0.08)":"none",transition:"all 0.15s"}}>{l}</button>
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
            <div style={{marginBottom:16,padding:"12px 14px",borderRadius:8,background:"#eafaf1",border:"1px solid #a8d5b5",color:"#1a6b45",fontSize:13}}>
              ✓ {success}
            </div>
          )}

          {/* Reset sent state */}
          {mode==="reset_sent"?(
            <div style={{textAlign:"center",padding:"24px 0"}}>
              <div style={{fontSize:40,marginBottom:12}}>✉️</div>
              <div style={{fontSize:16,fontWeight:600,color:"#1e3448",marginBottom:8}}>Reset email sent</div>
              <div style={{fontSize:13,color:"#6a7a8a",lineHeight:1.6,marginBottom:24}}>
                We sent a reset link to <strong style={{color:"#1e3448"}}>{email}</strong>. The link expires in 30 minutes.
              </div>
              <button onClick={handleReset} disabled={loading} style={{background:"none",border:"1px solid #1a6b45",borderRadius:7,padding:"9px 20px",color:"#1a6b45",fontSize:13,cursor:"pointer",marginBottom:12,width:"100%"}}>
                {loading?"Sending…":"Resend reset email"}
              </button>
              <button onClick={()=>{setMode("login");setSuccess("");}} style={{background:"none",border:"none",color:"#6a7a8a",fontSize:12,cursor:"pointer"}}>
                Back to sign in
              </button>
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {mode==="signup"&&(
                <>
                  <div><label style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.08em",display:"block",marginBottom:5}}>FULL NAME</label>
                  <input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={locked?disabledInput:inputStyle} disabled={locked}/></div>
                  <div><label style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.08em",display:"block",marginBottom:5}}>TRANSPLANT CENTER</label>
                  <input value={centre} onChange={e=>setCentre(e.target.value)} placeholder="Your transplant center" style={locked?disabledInput:inputStyle} disabled={locked}/></div>
                </>
              )}
              <div>
                <label style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.08em",display:"block",marginBottom:5}}>EMAIL</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@hospital.org" style={locked||loading?disabledInput:inputStyle} disabled={locked||loading}/>
              </div>
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                  <label style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#6a7a8a",letterSpacing:"0.08em"}}>PASSWORD</label>
                  {mode==="login"&&<button onClick={handleReset} disabled={loading||locked} style={{background:"none",border:"none",color:"#1a6b45",cursor:"pointer",fontSize:11,padding:0}}>Forgot password?</button>}
                </div>
                <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" style={locked||loading?disabledInput:inputStyle} disabled={locked||loading}/>
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
                <button onClick={handleReset} style={{background:"none",border:"1px solid #1a6b45",borderRadius:7,padding:"10px",color:"#1a6b45",fontSize:13,fontWeight:600,cursor:"pointer",width:"100%",fontFamily:"'DM Sans', sans-serif"}}>
                  Reset my password
                </button>
              )}

              {/* Demo divider */}
              {mode==="login"&&!locked&&(
                <>
                  <div style={{display:"flex",alignItems:"center",gap:12,margin:"4px 0"}}>
                    <div style={{flex:1,height:1,background:"#e8ecf0"}}/>
                    <span style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#9aabb8",letterSpacing:"0.08em"}}>NO ACCOUNT?</span>
                    <div style={{flex:1,height:1,background:"#e8ecf0"}}/>
                  </div>
                  <ConfidentialityBox/>
                  <button onClick={agreed?onDemoMode:null} style={{background:"none",border:"1px solid #1e3448",borderRadius:7,padding:"10px",color:agreed?"#1e3448":"#9aabb8",fontSize:13,fontWeight:600,cursor:agreed?"pointer":"not-allowed",width:"100%",fontFamily:"'DM Sans', sans-serif",opacity:agreed?1:0.5,transition:"all 0.2s"}}>
                    Explore Demo Mode
                  </button>

                </>
              )}
            </div>
          )}

          {/* Footer */}
          <div style={{marginTop:32,textAlign:"center",fontFamily:"'DM Mono', monospace",fontSize:10,color:"#b0bec5",letterSpacing:"0.06em",lineHeight:1.8}}>
            pairpath.org · Independent clinical tool · Not yet clinically validated
          </div>
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes ppPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.3)}}@media(max-width:768px){.pp-left{display:none!important}}`}</style>
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
  
  // Only count a required field as missing if it's relevant to this pair type
  const missingRequired = requiredFields.filter(f => !Object.values(mapping).includes(f.key));
  
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
          <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",marginBottom:8}}>FIRST ROW PREVIEW</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {headers.slice(0,6).map(h=>(
              <div key={h} style={{fontSize:11,color:"#b0bec5"}}>
                <span style={{color:"#90a4b4"}}>{h}:</span> <span style={{color:"#ffffff"}}>{preview[0][h]||"—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:20}}>
        {headers.map(h => (
          <div key={h} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
            <div style={{flex:1,fontSize:12,color:"#c8d4dc",fontWeight:500}}>{h}</div>
            <div style={{fontSize:12,color:"#90a4b4"}}>→</div>
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
        <div style={{padding:"10px 14px",borderRadius:8,background:"#1a2010",border:"1px solid #2a3010",color:"#ffd166",fontSize:12,marginBottom:16}}>
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
  {id:"d1",pair_type:"paired",status:"active",recipient_name:"R1",recipient_blood_type:"B",recipient_pra_percent:85,recipient_weight_kg:58,recipient_height_cm:162,recipient_year_born:"1968",donor_name:"D1",donor_blood_type:"A",donor_weight_kg:82,donor_height_cm:178,donor_year_born:"1966",donor_egfr:72,centre:"Sutter CPMC",created_at:new Date(Date.now()-86400000*2).toISOString(),user_id:"demo"},
  {id:"d2",pair_type:"paired",status:"active",recipient_name:"R2",recipient_blood_type:"O",recipient_pra_percent:92,recipient_weight_kg:74,recipient_height_cm:175,recipient_year_born:"1972",donor_name:"D2",donor_blood_type:"A",donor_weight_kg:68,donor_height_cm:165,donor_year_born:"1974",centre:"UCSF Medical Center",created_at:new Date(Date.now()-86400000*5).toISOString(),user_id:"demo"},
  {id:"d3",pair_type:"paired",status:"active",recipient_name:"R3",recipient_blood_type:"A",recipient_pra_percent:30,recipient_weight_kg:54,recipient_height_cm:158,recipient_year_born:"1980",donor_name:"D3",donor_blood_type:"B",donor_weight_kg:79,donor_height_cm:180,donor_year_born:"1978",donor_egfr:88,centre:"Stanford Health",created_at:new Date(Date.now()-86400000*8).toISOString(),user_id:"demo"},
  {id:"d4",pair_type:"altruistic",status:"active",donor_name:"D4",donor_blood_type:"O",donor_weight_kg:77,donor_height_cm:174,donor_year_born:"1975",donor_egfr:95,donor_cmv:"Negative",centre:"Sutter CPMC",created_at:new Date(Date.now()-86400000*10).toISOString(),user_id:"demo"},
  {id:"d5",pair_type:"paired",status:"active",recipient_name:"R5",recipient_blood_type:"AB",recipient_pra_percent:15,recipient_weight_kg:61,recipient_height_cm:163,recipient_year_born:"1985",donor_name:"D5",donor_blood_type:"O",donor_weight_kg:88,donor_height_cm:183,donor_year_born:"1983",donor_egfr:91,centre:"Kaiser Oakland",created_at:new Date(Date.now()-86400000*12).toISOString(),user_id:"demo"},
  {id:"d6",pair_type:"recipient_only",status:"active",recipient_name:"R6",recipient_blood_type:"O",recipient_pra_percent:98,recipient_weight_kg:52,recipient_height_cm:155,recipient_year_born:"1965",centre:"UCSF Medical Center",created_at:new Date(Date.now()-86400000*14).toISOString(),user_id:"demo"},
  {id:"d7",pair_type:"paired",status:"active",recipient_name:"R7",recipient_blood_type:"A",recipient_pra_percent:10,recipient_weight_kg:83,recipient_height_cm:177,recipient_year_born:"1990",donor_name:"D7",donor_blood_type:"A",donor_weight_kg:65,donor_height_cm:160,donor_year_born:"1988",donor_egfr:82,centre:"Stanford Health",created_at:new Date(Date.now()-86400000*18).toISOString(),user_id:"demo"},
  {id:"d8",pair_type:"paired",status:"matched",recipient_name:"R8",recipient_blood_type:"B",recipient_pra_percent:45,recipient_weight_kg:57,recipient_height_cm:161,recipient_year_born:"1970",donor_name:"D8",donor_blood_type:"O",donor_weight_kg:81,donor_height_cm:176,donor_year_born:"1968",centre:"Kaiser Oakland",created_at:new Date(Date.now()-86400000*20).toISOString(),user_id:"demo"},
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
  const [filterCentre,setFilterCentre]=useState("all");
  const [filterPairType,setFilterPairType]=useState("all");
  const [sortStack,setSortStack]=useState([{key:"date",dir:"desc"}]);
  const [unitSystem,setUnitSystem]=useState("metric");
  const [savedMappings,setSavedMappings]=useState(()=>{try{return JSON.parse(localStorage.getItem("pairpath_mappings")||"{}");}catch{return {};}});
  const [xlsxSheets,setXlsxSheets]=useState([]);
  const [xlsxResults,setXlsxResults]=useState([]);
  const [xlsxSummaryVisible,setXlsxSummaryVisible]=useState(false);
  const [showMatchExport,setShowMatchExport]=useState(false);
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
  const [showWelcome,setShowWelcome]=useState(false);
  const [visitedTabs,setVisitedTabs]=useState(()=>new Set(["grid"]));
  const [hintDismissed,setHintDismissed]=useState(false);

  const DEMO_HINTS={
    grid:"You're looking at the Compatibility Grid — each cell shows how well a donor and recipient pair. Click any colored cell to see a full breakdown including blood type, PRA sensitization, and size compatibility.",
    registry:"This is the Registry — every donor-recipient pair in the system. Use the filters to sort by blood type, pair type, or centre. Click any row to view or edit details.",
    matches:"The Matches view shows the best compatible donor for each recipient, ranked by Pair Score. Click a score to see the full compatibility report.",
    chains:"Chains shows viable kidney exchange sequences — two or more incompatible pairs who can swap donors so everyone gets a transplant. Longer chains mean more lives saved.",
    dashboard:"The Dashboard gives you a snapshot of your registry — active pairs, match rates, blood type distribution, and how many exchange chains are available right now.",
    add:"Use this form to add a new pair to the registry. You can enter an incompatible donor-recipient pair, an altruistic donor, or a recipient-only entry. You can also bulk-upload from a CSV or Excel file.",
  };
  const [computedChains,setComputedChains]=useState([]);
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
    // Show welcome modal on first login — flag stored in auth metadata so it's per-user, not per-device
    if(!session.user?.user_metadata?.has_seen_welcome){
      setShowWelcome(true);
    }
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

  async function dismissWelcome(goToAdd=false){
    setShowWelcome(false);
    if(goToAdd) setView("add");
    // Persist flag to auth metadata so modal never shows again for this user
    await supabase.auth.updateUser({data:{has_seen_welcome:true}});
  }

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

  function donorFingerprint(r){
    const bt=(r.donor_blood_type||"").trim().toUpperCase();
    const yr=String(r.donor_year_born||"").trim();
    const wt=String(Math.round(parseFloat(r.donor_weight_kg)||0)||"");
    const ht=String(Math.round(parseFloat(r.donor_height_cm)||0)||"");
    if(!bt||!yr||!wt||!ht) return null;
    return `D|${bt}|${yr}|${wt}|${ht}`;
  }
  function recipientFingerprint(r){
    const bt=(r.recipient_blood_type||"").trim().toUpperCase();
    const yr=String(r.recipient_year_born||"").trim();
    const wt=String(Math.round(parseFloat(r.recipient_weight_kg)||0)||"");
    const ht=String(Math.round(parseFloat(r.recipient_height_cm)||0)||"");
    if(!bt||!yr||!wt||!ht) return null;
    return `R|${bt}|${yr}|${wt}|${ht}`;
  }
  function findByFingerprint(incoming, excludeId=null){
    const df=donorFingerprint(incoming);
    const rf=recipientFingerprint(incoming);
    const type=incoming.pair_type||"paired";
    return pairs.find(p=>{
      if(excludeId&&p.id===excludeId) return false;
      if(type==="altruistic") return df&&df===donorFingerprint(p);
      if(type==="recipient_only") return rf&&rf===recipientFingerprint(p);
      return df&&rf&&df===donorFingerprint(p)&&rf===recipientFingerprint(p);
    })||null;
  }
  function fingerprintMatchScore(incoming, existing){
    let score=0;
    const fields=[
      [incoming.donor_blood_type, existing.donor_blood_type],
      [incoming.donor_year_born,  existing.donor_year_born],
      [incoming.donor_weight_kg,  existing.donor_weight_kg],
      [incoming.donor_height_cm,  existing.donor_height_cm],
      [incoming.recipient_blood_type, existing.recipient_blood_type],
      [incoming.recipient_year_born,  existing.recipient_year_born],
      [incoming.recipient_weight_kg,  existing.recipient_weight_kg],
      [incoming.recipient_height_cm,  existing.recipient_height_cm],
    ];
    fields.forEach(([a,b])=>{
      if(a&&b&&String(Math.round(parseFloat(a)||0)||a).trim()===String(Math.round(parseFloat(b)||0)||b).trim()) score++;
    });
    return score;
  }
  function isDuplicate(f, excludeId=null){
    const fp=findByFingerprint(f, excludeId);
    if(fp) return true;
    return pairs.some(p=>{
      if(excludeId&&p.id===excludeId) return false;
      const dName=(p.donor_name||"").trim().toLowerCase();
      const rName=(p.recipient_name||"").trim().toLowerCase();
      const fDName=(f.donor_name||"").trim().toLowerCase();
      const fRName=(f.recipient_name||"").trim().toLowerCase();
      const donorYearMismatch=p.donor_year_born&&f.donor_year_born&&String(p.donor_year_born)!==String(f.donor_year_born);
      const recipYearMismatch=p.recipient_year_born&&f.recipient_year_born&&String(p.recipient_year_born)!==String(f.recipient_year_born);
      if(f.pair_type==="altruistic") return dName&&dName===fDName&&!donorYearMismatch;
      if(f.pair_type==="recipient_only") return rName&&rName===fRName&&!recipYearMismatch;
      return dName&&rName&&dName===fDName&&rName===fRName&&!donorYearMismatch&&!recipYearMismatch;
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
      setXlsxSheets(sheets);
      setXlsxResults([]);
    }catch(err){setUploadResult({success:false,message:"Could not read Excel file: "+err.message});}
    setUploading(false);
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
    // Validate blood types
    if(!["A","B","AB","O"].includes(obj.donor_blood_type)) obj.donor_blood_type=null;
    if(!["A","B","AB","O"].includes(obj.recipient_blood_type)) obj.recipient_blood_type=null;
    // Validate CMV
    if(!["Positive","Negative","Unknown"].includes(obj.donor_cmv)) obj.donor_cmv="Unknown";
    if(!["Positive","Negative","Unknown"].includes(obj.recipient_cmv)) obj.recipient_cmv="Unknown";
    // Convert Excel serial date numbers — applies to ALL date fields
    function excelSerialToISO(val){
      if(!val&&val!==0) return val;
      const n=parseFloat(String(val).trim());
      // Excel serial: 1 = Jan 1 1900. Birth years (1900-2010) fall in range ~1–40179.
      // We accept any positive serial that produces a plausible calendar date.
      if(!isNaN(n)&&n>1&&n<60000){
        const date=new Date((n-25569)*86400000);
        return date.toISOString().split("T")[0]; // YYYY-MM-DD
      }
      return val;
    }
    function extractYear(val){
      if(!val) return val;
      const converted=excelSerialToISO(val); // handle serial first
      const s=String(converted).trim();
      if(s.includes("-")) return s.split("-")[0]; // YYYY-MM-DD → YYYY
      if(s.includes("/")){ const p=s.split("/"); return p[2]?.length===4?p[2]:`20${p[2]}`; } // MM/DD/YYYY → YYYY
      if(/^\d{4}$/.test(s)) return s; // already a year
      return s;
    }
    obj.recipient_dialysis_start=excelSerialToISO(obj.recipient_dialysis_start);
    obj.recipient_year_born=extractYear(obj.recipient_year_born);
    obj.donor_year_born=extractYear(obj.donor_year_born);
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
      const toInsert=[]; const toUpdate=[]; const toFlag=[]; const importedIds=new Set();
      records.forEach(r=>{
        const exact=findByFingerprint(r);
        if(exact){
          toUpdate.push({id:exact.id,update:{
            donor_name:r.donor_name||exact.donor_name,
            recipient_name:r.recipient_name||exact.recipient_name,
            donor_blood_type:r.donor_blood_type||exact.donor_blood_type,
            recipient_blood_type:r.recipient_blood_type||exact.recipient_blood_type,
            donor_year_born:r.donor_year_born||exact.donor_year_born,
            recipient_year_born:r.recipient_year_born||exact.recipient_year_born,
            donor_weight_kg:r.donor_weight_kg||exact.donor_weight_kg,
            recipient_weight_kg:r.recipient_weight_kg||exact.recipient_weight_kg,
            donor_height_cm:r.donor_height_cm||exact.donor_height_cm,
            recipient_height_cm:r.recipient_height_cm||exact.recipient_height_cm,
            donor_egfr:r.donor_egfr||exact.donor_egfr,
            donor_cmv:r.donor_cmv||exact.donor_cmv,
            recipient_cmv:r.recipient_cmv||exact.recipient_cmv,
            recipient_pra_percent:r.recipient_pra_percent||exact.recipient_pra_percent,
            recipient_dialysis_start:r.recipient_dialysis_start||exact.recipient_dialysis_start,
            notes:r.notes||exact.notes,
            status:"active",
          }});
          importedIds.add(exact.id);
        } else {
          const partial=pairs.find(p=>fingerprintMatchScore(r,p)>=2&&fingerprintMatchScore(r,p)<4);
          if(partial) toFlag.push({incoming:r,existing:partial});
          else toInsert.push(r);
        }
      });
      const activeExisting=pairs.filter(p=>p.status==="active"&&!p.donor_backup);
      const toArchive=activeExisting.filter(p=>!importedIds.has(p.id)&&!toUpdate.find(u=>u.id===p.id));
      let inserted=0,updated=0,archived=0,errors=[];
      if(toInsert.length){const{data:ins,error:insErr}=await supabase.from("pairs").insert(toInsert).select();if(insErr)errors.push(insErr.message);else inserted=ins?.length??0;}
      for(const{id,update} of toUpdate){const{error:updErr}=await supabase.from("pairs").update(update).eq("id",id);if(updErr)errors.push(updErr.message);else updated++;}
      for(const p of toArchive){const{error:archErr}=await supabase.from("pairs").update({status:"inactive"}).eq("id",p.id);if(archErr)errors.push(archErr.message);else archived++;}
      const parts=[];
      if(inserted>0) parts.push(`${inserted} added`);
      if(updated>0)  parts.push(`${updated} updated`);
      if(archived>0) parts.push(`${archived} archived`);
      if(toFlag.length>0) parts.push(`${toFlag.length} flagged for review`);
      const summaryMsg=parts.length?parts.join(", "):"No changes";
      const hasError=errors.length>0;
      if(sheetContext){
        const result={sheetName:sheetContext.name,imported:inserted,updated,archived,flagged:toFlag.length,dupes:0,error:hasError?errors[0]:null};
        setXlsxResults(prev=>[...prev,result]);
        addAudit("BULK IMPORT",`Sheet "${sheetContext.name}": ${summaryMsg}`);
        setXlsxSheets(prev=>{const remaining=prev.slice(1);if(!remaining.length)setXlsxSummaryVisible(true);return remaining;});
      } else {
        if(hasError)setUploadResult({success:false,message:errors[0]});
        else{addAudit("BULK IMPORT",`Imported: ${summaryMsg}`);setUploadResult({success:true,message:summaryMsg+(toFlag.length>0?" — check registry for flagged entries":"")});}
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
                  <div style={{fontSize:12,color:"#b0bec5"}}>{t.desc}</div>
                </button>
              ))}
            </div>
            {/* Height and weight unit toggles */}
            <div style={{marginBottom:16,padding:"12px 14px",background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
              <div style={{fontSize:11,color:"#90a4b4",fontFamily:"'DM Mono', monospace",marginBottom:8}}>HEIGHT UNIT IN YOUR FILE</div>
              <div style={{display:"flex",gap:8,marginBottom:12}}>
                {[["meters","Meters (Epic default)"],["cm","Centimeters"],["auto","Auto-detect"]].map(([val,label])=>(
                  <button key={val} onClick={()=>setImportHeightUnit(val)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,border:`1.5px solid ${importHeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                      background:importHeightUnit===val?"#0d2030":"transparent",
                      color:importHeightUnit===val?"#6ab4d0":"#90a4b4",
                      cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace"}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{fontSize:11,color:"#90a4b4",fontFamily:"'DM Mono', monospace",marginBottom:8}}>WEIGHT UNIT IN YOUR FILE</div>
              <div style={{display:"flex",gap:8}}>
                {[["kg","Kilograms (Epic default)"],["lbs","Pounds"]].map(([val,label])=>(
                  <button key={val} onClick={()=>setImportWeightUnit(val)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,border:`1.5px solid ${importWeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                      background:importWeightUnit===val?"#0d2030":"transparent",
                      color:importWeightUnit===val?"#6ab4d0":"#90a4b4",
                      cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace"}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{fontSize:11,color:"#8a9aaa",marginTop:6}}>
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
                    <div key={i} style={{padding:"3px 10px",borderRadius:4,fontSize:11,fontFamily:"'DM Mono', monospace",
                      background:done?"#0d2a1e":current?"#1a2e3a":"#131c26",
                      color:done?"#2dd4a0":current?"#6ab4d0":"#8a9aaa",
                      border:`1px solid ${done?"#1a3028":current?"#1a3a5a":"#1e2d3d"}`}}>
                      {done?"✓ ":""}{"name" in s?s.name:`Sheet ${i+1}`}
                    </div>
                  );
                })}
              </div>

              <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:20,color:"#ffffff",marginBottom:4}}>
                Map columns — <span style={{color:"#6ab4d0"}}>{sheet.name}</span>
              </div>
              <div style={{fontSize:12,color:"#b0bec5",marginBottom:16}}>
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
                        color:(sheet.pairType||"paired")===pt.value?"#6ab4d0":"#90a4b4",cursor:"pointer",fontSize:11}}>
                      {pt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{marginBottom:12,padding:"10px 12px",background:"#1a2535",borderRadius:8,border:"1px solid #2a3d52"}}>
                <div style={{fontSize:10,color:"#90a4b4",fontFamily:"'DM Mono', monospace",marginBottom:6}}>HEIGHT UNIT</div>
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  {[["meters","Meters (Epic)"],["cm","Centimeters"],["auto","Auto"]].map(([val,label])=>(
                    <button key={val} onClick={()=>setImportHeightUnit(val)}
                      style={{flex:1,padding:"5px 0",borderRadius:5,border:`1px solid ${importHeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                        background:importHeightUnit===val?"#0d2030":"transparent",
                        color:importHeightUnit===val?"#6ab4d0":"#90a4b4",
                        cursor:"pointer",fontSize:10,fontFamily:"'DM Mono', monospace"}}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{fontSize:10,color:"#90a4b4",fontFamily:"'DM Mono', monospace",marginBottom:6}}>WEIGHT UNIT</div>
                <div style={{display:"flex",gap:6}}>
                  {[["kg","kg (Epic)"],["lbs","lbs"]].map(([val,label])=>(
                    <button key={val} onClick={()=>setImportWeightUnit(val)}
                      style={{flex:1,padding:"5px 0",borderRadius:5,border:`1px solid ${importWeightUnit===val?"#6ab4d0":"#1e2d3d"}`,
                        background:importWeightUnit===val?"#0d2030":"transparent",
                        color:importWeightUnit===val?"#6ab4d0":"#90a4b4",
                        cursor:"pointer",fontSize:10,fontFamily:"'DM Mono', monospace"}}>
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
            <div style={{fontSize:12,color:"#b0bec5",marginBottom:16}}>{xlsxResults.length} sheet{xlsxResults.length!==1?"s":""} processed</div>
            {xlsxResults.map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #141c24",fontSize:13}}>
                <span style={{color:"#c8d4dc",fontWeight:500}}>{r.sheetName}</span>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  {r.error&&r.error!=="Skipped"&&<span style={{color:"#ff8a8a",fontSize:11}}>{r.error}</span>}
                  {r.error==="Skipped"&&<span style={{color:"#90a4b4",fontSize:11}}>Skipped</span>}
                  {!r.error&&r.imported>0&&<span style={{color:"#4db882",fontSize:12}}>{r.imported} added</span>}
                  {!r.error&&r.updated>0&&<span style={{color:"#6ab4d0",fontSize:12}}>{r.updated} updated</span>}
                  {!r.error&&r.archived>0&&<span style={{color:"#90a4b4",fontSize:11}}>{r.archived} archived</span>}
                  {!r.error&&r.flagged>0&&<span style={{color:"#ffd166",fontSize:11}}>{r.flagged} flagged</span>}
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
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:9999,pointerEvents:"all"}}>
          <div style={{...S.card,maxWidth:480,width:"90%",pointerEvents:"all"}}>
            <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:20,fontWeight:700,color:"#ffffff",marginBottom:6}}>Export Matches</div>
            <p style={{fontSize:13,color:"#b0bec5",marginBottom:20}}>Choose how much detail to include. All versions are sorted by Pair Score.</p>
            {[
              {level:"quick",label:"Quick View",desc:"Score · Names · Blood Types · Height · PRA%",cols:"8 columns — for a fast first look in a meeting"},
              {level:"standard",label:"Standard",desc:"+ Age · Height · Weights · Waitlist Date · Weight Gap",cols:"14 columns — recommended for most presentations"},
              {level:"full",label:"Full Clinical",desc:"+ eGFR · CMV (donor & recipient) · HLA Notes · Chain Columns",cols:"20 columns — for detailed clinical review"},
            ].map(({level,label,desc,cols})=>(
              <button key={level} onClick={()=>{exportMatches(visiblePairs,level);setShowMatchExport(false);}}
                style={{width:"100%",textAlign:"left",padding:"14px 16px",borderRadius:10,border:"1px solid #1e2d3d",background:"#1a2535",cursor:"pointer",marginBottom:8,transition:"all 0.15s"}}>
                <div style={{fontSize:14,fontWeight:600,color:"#ffffff",marginBottom:3}}>{label}</div>
                <div style={{fontSize:12,color:"#6ab4d0",marginBottom:3}}>{desc}</div>
                <div style={{fontSize:11,color:"#8a9aaa",fontFamily:"'DM Mono', monospace"}}>{cols}</div>
              </button>
            ))}
            <button onClick={()=>setShowMatchExport(false)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",width:"100%",marginTop:4}}>Cancel</button>
          </div>
        </div>
      )}

      {/* Duplicate Warning Modal */}
      {duplicateWarning&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{...S.card,maxWidth:440,width:"90%",textAlign:"center"}}>
            <div style={{fontSize:22,marginBottom:8}}>⚠️</div>
            <div style={{fontSize:16,color:"#ffd166",marginBottom:8}}>Possible Duplicate Detected</div>
            <div style={{fontSize:13,color:"#b0bec5",marginBottom:6}}>
              A record with this donor/recipient name pair already exists in the registry.
            </div>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:12,color:"#ffffff",padding:"8px 12px",background:"#1a2535",borderRadius:6,marginBottom:20}}>
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
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:"#90a4b4",letterSpacing:"0.1em"}}>AUDIT LOG</div>
            <button onClick={()=>setShowAudit(false)} style={{background:"none",border:"none",color:"#b0bec5",cursor:"pointer",fontSize:18}}>×</button>
          </div>
          {auditLog.length===0?(
            <div style={{fontSize:13,color:"#8a9aaa"}}>No actions logged this session.</div>
          ):(
            auditLog.map(entry=>(
              <div key={entry.id} style={{borderTop:"1px solid #141c24",paddingTop:10,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{...S.tag(entry.action==="DELETE"||entry.action==="BULK DELETE"?"#ff8a8a":entry.action==="ADD"||entry.action==="BULK IMPORT"?"#2dd4a0":"#ffd166")}}>{entry.action}</span>
                  <span style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#8a9aaa"}}>{entry.time}</span>
                </div>
                <div style={{fontSize:12,color:"#b0bec5",marginBottom:2}}>{entry.detail}</div>
                <div style={{fontSize:11,color:"#8a9aaa"}}>{entry.user}</div>
              </div>
            ))
          )}
        </div>
      )}
      {matchDetail&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setMatchDetail(null)}>
          <div style={{...S.card,maxWidth:480,width:"90%"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",letterSpacing:"0.1em",marginBottom:14}}>BEST MATCH</div>
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
                <span style={{fontSize:12,color:"#b0bec5"}}>{label}</span>
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

          <button onClick={()=>setDemoMode(m=>!m)}
            style={{...S.tag(demoMode?"#ffd166":"#7a90a0"),cursor:"pointer",border:`1px solid ${demoMode?"#ffd16644":"#2a3a4a"}`,background:demoMode?"#2a1e0022":"transparent",fontSize:10,padding:"2px 8px"}}>
            {demoMode?"● DEMO":"DEMO"}
          </button>
          {demoMode&&(
            <span style={{fontSize:11,color:"#ffd166",fontFamily:"'DM Mono', monospace"}}>
              demo data — not saved · real names never leave your machine
            </span>
          )}
        </div>
        <nav style={{display:"flex",gap:2}}>
          {[["grid","Grid"],["registry","Registry"],["matches","Matches"],["chains","Chains"],["dashboard","Dashboard"],["add","+ Add"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setView(v);setEditingPair(null);if(v==="add")setForm(emptyForm);setVisitedTabs(s=>{const n=new Set(s);n.add(v);return n;});}} style={{...S.navBtn(view===v),position:"relative"}}>
              {l}
              {demoMode&&!visitedTabs.has(v)&&(
                <span style={{position:"absolute",top:3,right:3,width:6,height:6,borderRadius:"50%",background:"#4db882",boxShadow:"0 0 5px #4db882",animation:"ppPulse 1.5s ease-in-out infinite"}}/>
              )}
            </button>
          ))}
        </nav>
        <div style={{display:"flex",gap:10,alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:12,color:"#b0bec5"}}>{demoMode?"Demo Mode":userMeta.full_name||session?.user?.email}</span>
          {isAdmin&&<span style={S.tag("#ffd166")}>Admin</span>}
          {!isAdmin&&hasCentreDomain&&<span style={{...S.tag("#6ab4d0"),fontSize:10}} title={`Sharing data with all @${userDomain} users`}>@{userDomain}</span>}
          {!isAdmin&&!hasCentreDomain&&!demoMode&&<span style={{...S.tag("#90a4b4"),fontSize:10}}>Personal</span>}
          {isAdmin&&<button onClick={()=>setShowAudit(v=>!v)} style={{...S.btn,padding:"4px 10px",background:showAudit?"#0f2d1e":"transparent",border:"1px solid #2a3d52",color:"#b0bec5",fontSize:11}}>Audit</button>}
          {userMeta.centre&&<span style={S.tag("#7a90a4")}>{userMeta.centre}</span>}
          <div style={{width:7,height:7,borderRadius:"50%",background:"#4db882"}}/>
          <span style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:"#4db882"}}>{activePairs.length} ACTIVE</span>
          {session&&<button onClick={()=>supabase.auth.signOut()} style={{...S.btn,padding:"5px 12px",background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",fontSize:12}}>Sign Out</button>}
          {!session&&demoMode&&<button onClick={()=>setDemoMode(false)} style={{...S.btn,padding:"5px 12px",background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",fontSize:12}}>Exit Demo</button>}
        </div>
      </header>

      {/* First-time welcome modal */}
      {showWelcome&&!demoMode&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"#0f1c2a",border:"1px solid rgba(77,184,130,0.3)",borderRadius:12,padding:"36px 40px",maxWidth:520,width:"100%",boxShadow:"0 24px 80px rgba(0,0,0,0.5)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
              <LogoMark size={36}/>
              <div>
                <div style={{fontFamily:"'DM Sans', sans-serif",fontSize:22,fontWeight:700,letterSpacing:"-0.3px"}}>
                  <span style={{color:"#ffffff"}}>Welcome to </span><span style={{color:"#4db882",fontWeight:300}}>PairPath</span>
                </div>
                <div style={{fontSize:12,color:"#8a9aaa",marginTop:2}}>Kidney paired donation registry</div>
              </div>
            </div>

            <div style={{fontSize:14,color:"rgba(255,255,255,0.8)",lineHeight:1.7,marginBottom:24}}>
              PairPath helps you identify compatible kidney exchange pairs and build donation chains — all in one place, at no cost.
            </div>

            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:28}}>
              {[
                ["1","Add your pairs","Use the Add tab to enter incompatible donor-recipient pairs, altruistic donors, or recipient-only entries — or bulk upload from a CSV or Excel file."],
                ["2","Check compatibility","The Grid and Matches tabs show you who's compatible with whom, ranked by Pair Score."],
                ["3","Find exchange chains","The Chains tab identifies viable kidney exchange sequences across your registry."],
              ].map(([n,title,desc])=>(
                <div key={n} style={{display:"flex",gap:14,padding:"12px 14px",background:"rgba(77,184,130,0.06)",borderRadius:8,border:"1px solid rgba(77,184,130,0.12)"}}>
                  <div style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:"#4db882",fontWeight:600,flexShrink:0,minWidth:16}}>{n}</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"#ffffff",marginBottom:3}}>{title}</div>
                    <div style={{fontSize:12,color:"#8a9aaa",lineHeight:1.55}}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>dismissWelcome(true)} style={{flex:1,padding:"11px 0",background:"#4db882",border:"none",borderRadius:7,color:"#0a1628",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans', sans-serif"}}>
                Add My First Pair →
              </button>
              <button onClick={()=>dismissWelcome(false)} style={{padding:"11px 20px",background:"transparent",border:"1px solid #2a3d52",borderRadius:7,color:"#8a9aaa",fontSize:13,cursor:"pointer",fontFamily:"'DM Sans', sans-serif"}}>
                Explore first
              </button>
            </div>

            <div style={{marginTop:16,fontSize:11,color:"#4a6a5a",textAlign:"center",lineHeight:1.5}}>
              Real patient names never leave your computer — PairPath only stores anonymous identifiers like D1 and R1.
            </div>
          </div>
        </div>
      )}

      {/* Floating help button — reopens welcome modal */}
      {!demoMode&&(
        <button
          onClick={()=>setShowWelcome(true)}
          title="How to use PairPath"
          style={{position:"fixed",bottom:24,right:24,zIndex:900,width:38,height:38,borderRadius:"50%",background:"#0f1c2a",border:"1px solid rgba(77,184,130,0.25)",color:"#4db882",fontSize:17,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 16px rgba(0,0,0,0.4)",transition:"border-color 0.2s,box-shadow 0.2s",fontFamily:"'DM Sans', sans-serif",lineHeight:1}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(77,184,130,0.6)";e.currentTarget.style.boxShadow="0 4px 20px rgba(77,184,130,0.2)";}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(77,184,130,0.25)";e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,0.4)";}}
        >?</button>
      )}

      {/* Demo hint bar */}
      {demoMode&&!hintDismissed&&DEMO_HINTS[view]&&(
        <div style={{background:"rgba(77,184,130,0.08)",borderBottom:"1px solid rgba(77,184,130,0.15)",padding:"10px 32px",display:"flex",alignItems:"center",gap:12,justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flex:1}}>
            <span style={{fontFamily:"'DM Mono', monospace",fontSize:9,color:"#4db882",letterSpacing:"0.1em",flexShrink:0}}>DEMO GUIDE</span>
            <span style={{fontSize:12,color:"rgba(255,255,255,0.75)",lineHeight:1.55}}>{DEMO_HINTS[view]}</span>
          </div>
          <button onClick={()=>setHintDismissed(true)} style={{background:"none",border:"none",color:"#4a6a5a",cursor:"pointer",fontSize:16,lineHeight:1,padding:"0 4px",flexShrink:0}} title="Dismiss hints">×</button>
        </div>
      )}

      {/* Grid */}
      {view==="grid"&&(
        <div style={S.page}>
          <h1 style={S.pageTitle}>Compatibility Grid</h1>
          <p style={S.subtitle}>Click any cell for a full breakdown. Pair Score is 0–100 when HLA data is entered. ABO ✓ shown when HLA is missing.</p>
          <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
            <select value={filterBlood} onChange={e=>setFilterBlood(e.target.value)} style={{...S.select,width:140}}>
              <option value="all">All Blood Types</option>
              {["A","B","AB","O"].map(b=><option key={b}>{b}</option>)}
            </select>

            <div style={{marginLeft:"auto",display:"flex",gap:16,flexWrap:"wrap"}}>
              {[["Strong","75+",85,false],["Good","55–74",65,false],["Marginal","35–54",45,false],["ABO ✓","HLA needed",null,true],["Incompatible","ABO ✗",null,false]].map(([l,r,sc,ao])=>(
                <span key={l} style={{fontSize:11,color:"#b0bec5",display:"flex",alignItems:"center",gap:5}}>
                  <span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:scoreStyle(sc,ao).bg}}/>
                  {l} ({r})
                </span>
              ))}
            </div>
          </div>
          {activePairs.filter(p=>p.donor_blood_type).length===0?(
            <div style={{textAlign:"center",padding:80,color:"#8a9aaa"}}>
              <div style={{fontSize:13,marginBottom:16}}>No active pairs with donors yet</div>
              <button onClick={()=>setView("add")} style={{...S.btn,background:"#1a6b45",color:"#ffffff"}}>Register First Pair</button>
            </div>
          ):(
            <div style={{overflowX:"auto",borderRadius:12,border:"1px solid #1e2d3d"}}>
              <table style={{borderCollapse:"collapse",width:"100%"}}>
                <thead>
                  <tr style={{background:"#131c26"}}>
                    <th style={{padding:"12px 16px",textAlign:"left",fontSize:10,color:"#90a4b4",fontFamily:"'DM Mono', monospace",letterSpacing:"0.08em",fontWeight:400,borderBottom:"1px solid #1e2d3d",borderRight:"1px solid #1e2d3d",minWidth:190}}>
                      RECIPIENT ↓ / DONOR →
                    </th>
                    {activePairs.filter(p=>p.donor_blood_type).map(p=>(
                      <th key={p.id} style={{padding:"10px 12px",textAlign:"center",borderBottom:"1px solid #1e2d3d",borderRight:"1px solid #1e2d3d",minWidth:90}}>
                        <div style={{fontSize:12,fontWeight:600,color:"#ffffff"}}>{(p.donor_name||"Altruistic").split(" ")[0]}</div>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#4db882",marginTop:2}}>{p.donor_blood_type}</div>
                        {p.pair_type==="altruistic"&&<div style={{fontSize:9,color:"#ffd166",marginTop:1}}>ALT</div>}
                        {p.donor_priority&&p.pair_type==="paired"&&<div style={{fontSize:9,color:{Primary:"#2dd4a0",Secondary:"#6ab4d0",Tertiary:"#ffd166"}[p.donor_priority]||"#90a4b4",marginTop:1}}>{p.donor_priority.slice(0,3).toUpperCase()}</div>}
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
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:"#b0bec5",marginTop:2}}>
                              {recipient.recipient_blood_type} · PRA {recipient.recipient_pra_percent||"?"}%
                              {recipient.recipient_pra_percent>80&&<span style={{color:"#ff8a8a",marginLeft:4}}>HIGH</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      {activePairs.filter(p=>p.donor_blood_type).map(donor=>{
                        if(donor.id===recipient.id) return <td key={donor.id} style={{textAlign:"center",borderBottom:"1px solid #141c24",borderRight:"1px solid #141c24",background:"#131c26",color:"#2a3a4a"}}>—</td>;
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
          <p style={{marginTop:10,fontSize:11,color:"#8a9aaa",fontFamily:"'DM Mono', monospace"}}>
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
              <button onClick={downloadDeIDTemplate} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5"}}>Download De-ID Template</button>
              <label style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",cursor:"pointer",display:"inline-flex",alignItems:"center"}}>
                {uploading?"Uploading…":"Bulk Upload CSV / Excel"}
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} style={{display:"none"}}/>
              </label>
              <button onClick={()=>exportRegistry(filteredPairs)} style={{...S.btn,background:"#0f2d1e",color:"#4db882"}}>Export CSV</button>
              <button onClick={()=>setShowMatchExport(true)} style={{...S.btn,background:"#1a203a",color:"#6ab4d0"}}>Export Matches</button>
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
            <span style={{fontSize:11,color:"#90a4b4",fontFamily:"'DM Mono', monospace",marginRight:4}}>SORT BY</span>
            {sortStack.map((s,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",background:"#131c26",border:"1px solid #1e2d3d",borderRadius:6}}>
                {i>0&&<span style={{fontSize:10,color:"#8a9aaa",marginRight:4}}>then</span>}
                <select value={s.key} onChange={e=>{const ns=[...sortStack];ns[i]={...ns[i],key:e.target.value};setSortStack(ns);}}
                  style={{...S.select,width:170,fontSize:11,padding:"3px 6px",border:"none",background:"transparent"}}>
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
                style={{...S.btn,background:"transparent",border:"1px dashed #2a3d52",color:"#90a4b4",padding:"4px 10px",fontSize:11}}>
                + Add level
              </button>
            )}
            {sortStack.length>1&&(
              <button onClick={()=>setSortStack([{key:"date",dir:"desc"}])}
                style={{background:"none",border:"none",color:"#5a3a3a",cursor:"pointer",fontSize:11,marginLeft:4}}>
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
              <button onClick={()=>setBulkDeleteConfirm(true)} style={{...S.btn,background:"#6e0d0d",color:"#ff8a8a",padding:"5px 14px",fontSize:12,marginLeft:"auto"}}>
                Delete Selected ({selectedIds.size})
              </button>
            )}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {filteredPairs.length===0&&<div style={{textAlign:"center",padding:40,color:"#8a9aaa",fontSize:13}}>No entries match your filters</div>}
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
                        <div style={{fontSize:12,color:"#b0bec5"}}>
                          Recipient{rAge?` · Age ${rAge}`:""}
                          {pair.recipient_pra_percent?` · PRA ${pair.recipient_pra_percent}%`:""}
                          {pair.recipient_dialysis_start?` · Waitlist ${new Date(pair.recipient_dialysis_start).toLocaleDateString("en-US",{month:"short",year:"numeric"})}`:""}
                        </div>
                      </>
                    )}
                    {pair.donor_name&&(
                      <div style={{fontSize:12,color:"#90a4b4",marginTop:pair.recipient_name?4:0,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        {pair.donor_priority&&pair.pair_type==="paired"&&(
                          <span style={{...S.tag(priorityColor[pair.donor_priority]||"#90a4b4"),fontSize:9}}>{pair.donor_priority}</span>
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
                        <div style={{fontSize:10,color:"#8a9aaa",fontFamily:"'DM Mono', monospace",marginBottom:4}}>ALSO WILLING TO DONATE</div>
                        {siblingDonors.map(sd=>{
                          const sdResult=sd.donor_blood_type&&pair.recipient_blood_type?calculateCompatibility(sd,pair):null;
                          const sdStyle=sdResult?scoreStyle(sdResult.score,sdResult.aboOnly):null;
                          return(
                            <div key={sd.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,fontSize:11}}>
                              <span style={{...S.tag(priorityColor[sd.donor_priority]||"#90a4b4"),fontSize:9}}>{sd.donor_priority||"—"}</span>
                              <span style={{color:"#c8d4dc"}}>{sd.donor_name}</span>
                              <span style={{color:"#90a4b4"}}>{sd.donor_blood_type||""}</span>
                              {sdStyle&&<span style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:sdStyle.text,background:sdStyle.bg,padding:"1px 6px",borderRadius:4}}>{sdResult.score??"ABO ✓"}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(appMode==="national"||pair.centre)&&pair.centre&&(
                      <div style={{fontSize:11,color:"#7a90a0",marginTop:3}}>{pair.centre}</div>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0,flexWrap:"wrap"}}>
                    {bs&&(
                      <button onClick={()=>setMatchDetail({donor:best.donor,recipient:pair,result:best.result})}
                        style={{textAlign:"center",padding:"6px 12px",borderRadius:8,background:`${bs.bg}99`,border:"none",cursor:"pointer"}}>
                        <div style={{fontFamily:"'DM Mono', monospace",fontSize:18,color:bs.text,lineHeight:1}}>
                          {best.result.score!==null?best.result.score:"ABO ✓"}
                        </div>
                        <div style={{fontSize:9,color:`${bs.text}88`,marginTop:2}}>{best.result.score!==null?"PAIR SCORE":"HLA NEEDED"}</div>
                      </button>
                    )}
                    <select value={pair.status} onChange={e=>handleStatusChange(pair.id,e.target.value)} disabled={!canEdit}
                      style={{...S.select,width:170,fontSize:12,opacity:canEdit?1:0.4,cursor:canEdit?"pointer":"not-allowed"}}>
                      {STATUS_OPTIONS.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select>
                    {!canEdit&&appMode==="national"&&<span style={{fontSize:10,color:"#8a9aaa",fontFamily:"'DM Mono', monospace"}}>READ ONLY</span>}
                    {canEdit&&(
                      <>
                        <button onClick={()=>startEdit(pair)} style={{...S.btn,background:"transparent",border:"1px solid #2a3d52",color:"#b0bec5",padding:"6px 12px"}}>Edit</button>
                        <button onClick={()=>setDeleteConfirm(pair)} style={{...S.btn,background:"transparent",border:"1px solid #3a1010",color:"#ff8a8a",padding:"6px 12px"}}>Delete</button>
                      </>
                    )}
                  </div>
                  {pair.notes&&<div style={{width:"100%",fontSize:12,color:"#8a9aaa",borderTop:"1px solid #141c24",paddingTop:8,marginTop:4}}>📝 {pair.notes}</div>}
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
          <p style={S.subtitle}>Compatible exchange chains across all active pairs. Chains longer than 6-way are rare in practice and logistically complex to coordinate.</p>
          {chainsLoading?(
            <div style={{textAlign:"center",padding:60,color:"#4db882",fontFamily:"'DM Mono', monospace",fontSize:13}}>Computing chains…</div>
          ):chains.length===0?(
            <div style={{textAlign:"center",padding:60,color:"#8a9aaa",fontSize:13}}>
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
                    <span style={{marginLeft:"auto",fontSize:11,color:"#b0bec5",fontFamily:"'DM Mono', monospace"}}>
                      AVG SCORE: {Math.round(chain.reduce((s,c)=>s+c.score,0)/chain.length)}
                    </span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:6}}>
                    {chain.map((link,li)=>{
                      const s=scoreStyle(link.score,false);
                      return (
                        <div key={li} style={{display:"flex",alignItems:"center"}}>
                          <div style={{padding:"10px 14px",borderRadius:8,background:"#1a2535",border:"1px solid #2a3d52",minWidth:100}}>
                            <div style={{fontSize:12,fontWeight:600,color:"#6ab4d0"}}>
                              {link.donorName.split(" ")[0]}
                              <span style={{fontSize:10,color:"#4db882",marginLeft:4}}>({link.donorBlood})</span>
                              {link.altruistic&&<span style={{fontSize:9,color:"#ffd166",marginLeft:4}}>ALT</span>}
                            </div>
                            <div style={{fontSize:10,color:"#8a9aaa",margin:"4px 0",textAlign:"center"}}>donates to</div>
                            <div style={{fontSize:12,fontWeight:600,color:"#6ad0a0"}}>
                              {link.recipientName?.split(" ")[0]||"—"}
                              <span style={{fontSize:10,color:"#4db882",marginLeft:4}}>({link.recipientBlood})</span>
                            </div>
                            <div style={{fontFamily:"'DM Mono', monospace",fontSize:11,color:s.text,marginTop:5,textAlign:"center"}}>
                              {link.score}
                            </div>
                          </div>
                          {li<chain.length-1&&<div style={{padding:"0 8px",color:"#4db882",fontSize:20}}>→</div>}
                        </div>
                      );
                    })}
                    <div style={{padding:"0 8px",color:"#7a90a4",fontSize:20}}>↩</div>
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
              {label:"Total Entries",value:stats.total,color:"#b0bec5"},
              {label:"Active",value:stats.active,color:"#4db882"},
              {label:"With Match",value:stats.withMatch,color:"#6effc6"},
              {label:"Altruistic Donors",value:stats.altruistic,color:"#ffd166"},
              {label:"Recipient Only",value:stats.recipientOnly,color:"#6ab4d0"},
              {label:"Completed",value:stats.completed,color:"#6ab4d0"},
              {label:"Withdrawn",value:stats.withdrawn,color:"#8a9aaa"},
              {label:"2-Way Matches Found",value:stats.chains2,color:"#4db882"},
              {label:"3-Way Matches Found",value:stats.chains3,color:"#6ab4d0"},
              {label:"4+ Way Matches Found",value:stats.chainsLong,color:"#ffd166"},
            ].map(({label,value,color})=>(
              <div key={label} style={{...S.card,textAlign:"center"}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:30,fontWeight:500,color,lineHeight:1}}>{value}</div>
                <div style={{fontSize:11,color:"#90a4b4",marginTop:6}}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div style={S.card}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",letterSpacing:"0.1em",marginBottom:14}}>RECIPIENT BLOOD TYPE — ACTIVE</div>
              {["A","B","AB","O"].map(bt=>{
                const count=activePairs.filter(p=>p.recipient_blood_type===bt).length;
                const pct=activePairs.length?Math.round((count/activePairs.length)*100):0;
                return (
                  <div key={bt} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:12}}>
                      <span style={{color:"#b0bec5"}}>Type {bt}</span>
                      <span style={{fontFamily:"'DM Mono', monospace",color:"#ffffff"}}>{count} <span style={{color:"#8a9aaa"}}>({pct}%)</span></span>
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
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",letterSpacing:"0.1em",marginBottom:14}}>ENTRIES BY CENTER</div>
                {centres.map(c=>{
                  const count=visiblePairs.filter(p=>p.centre===c).length;
                  const pct=visiblePairs.length?Math.round((count/visiblePairs.length)*100):0;
                  return (
                    <div key={c} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:12}}>
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
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",letterSpacing:"0.1em",marginBottom:14}}>RECENT ENTRIES</div>
              {pairs.slice(0,6).map(p=>(
                <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,fontSize:12}}>
                  <span style={{color:"#c8d4dc"}}>{p.recipient_name||p.donor_name}</span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{color:"#8a9aaa",fontFamily:"'DM Mono', monospace",fontSize:11}}>
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

        // Build best match for each recipient
        const recipientMatches = recipients.map(recip=>{
          const allMatches = donors
            .filter(d=>d.id!==recip.id)
            .map(d=>({donor:d, result:calculateCompatibility(d,recip)}))
            .filter(m=>m.result.reasons.abo)
            .sort((a,b)=>(b.result.score||0)-(a.result.score||0));
          const best = allMatches[0]||null;
          const waitlistDays = recip.recipient_dialysis_start
            ? Math.floor((Date.now()-new Date(recip.recipient_dialysis_start))/(86400000))
            : null;
          return {recip, best, allMatches, waitlistDays};
        }).sort((a,b)=>{
          // Sort: best score first, then PRA desc, then waitlist days desc
          const aScore = a.best?.result.score||0;
          const bScore = b.best?.result.score||0;
          if(bScore!==aScore) return bScore-aScore;
          const aPRA = parseFloat(a.recip.recipient_pra_percent||0);
          const bPRA = parseFloat(b.recip.recipient_pra_percent||0);
          if(bPRA!==aPRA) return bPRA-aPRA;
          return (b.waitlistDays||0)-(a.waitlistDays||0);
        });

        const noMatchCount = recipientMatches.filter(m=>!m.best).length;

        function matchNarrative(rm){
          const {recip,best,waitlistDays}=rm;
          if(!best) return "No compatible donor found in current registry.";
          const pra=parseFloat(recip.recipient_pra_percent||0);
          const _sdWt=v=>{const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,"")));return(!isNaN(n)&&n>0&&n<400)?n:null;};
          const weightDiff=best.donor.donor_weight_kg&&recip.recipient_weight_kg
            ?Math.abs((_sdWt(best.donor.donor_weight_kg)||0)-(_sdWt(recip.recipient_weight_kg)||0)):null;
          const ageDiff=best.result.reasons.ageDiff;
          const parts=[];
          if(pra>80) parts.push("Highly sensitized — rare compatible match");
          else if(pra>50) parts.push("Moderately sensitized");
          if(waitlistDays&&waitlistDays>365) parts.push(`${Math.floor(waitlistDays/365)}yr ${Math.floor((waitlistDays%365)/30)}mo on waitlist`);
          else if(waitlistDays) parts.push(`${waitlistDays} days on waitlist`);
          if(weightDiff!==null) parts.push(`${weightDiff}kg size difference`);
          if(ageDiff) parts.push(`${ageDiff}yr age gap`);
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
              <button onClick={()=>exportMatchCards(activePairs)}
                style={{...S.btn,background:"#1a203a",color:"#6ab4d0"}}>Export PDF</button>
            </div>

            {noMatchCount>0&&(
              <div style={{padding:"10px 14px",borderRadius:8,background:"#2a1010",border:"1px solid #3a1010",color:"#ff8a8a",fontSize:12,marginBottom:16}}>
                {noMatchCount} recipient{noMatchCount!==1?"s":""} have no compatible donor in the current registry
              </div>
            )}

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:12}}>
              {recipientMatches.map(({recip,best,allMatches,waitlistDays},i)=>{
                const s=best?scoreStyle(best.result.score,best.result.aboOnly):null;
                const pra=parseFloat(recip.recipient_pra_percent||0);
                const rAge=calcAge(recip.recipient_year_born);
                const dAge=best?calcAge(best.donor.donor_year_born):null;
                return(
                  <div key={recip.id} style={{...S.card,borderColor:best?`${s.text}33`:"#3a1010"}}>
                    {/* Recipient */}
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:3}}>
                          <span style={{fontSize:15,fontWeight:600,color:"#ffffff"}}>{recip.recipient_name||"Unnamed"}</span>
                          <span style={S.tag("#3d8c6e")}>{recip.recipient_blood_type}</span>
                          {pra>80&&<span style={S.tag("#ff8a8a")}>HIGH PRA</span>}
                        </div>
                        <div style={{fontSize:12,color:"#b0bec5",display:"flex",gap:10,flexWrap:"wrap"}}>
                          {rAge&&<span>Age {rAge}</span>}
                          {recip.recipient_pra_percent&&<span>PRA {recip.recipient_pra_percent}%</span>}
                          {waitlistDays&&<span>{waitlistDays>365?`${Math.floor(waitlistDays/365)}yr ${Math.floor((waitlistDays%365)/30)}mo`:`${waitlistDays}d`} waitlist</span>}
                        </div>
                      </div>
                      {best&&s&&(
                        <div style={{textAlign:"center",padding:"8px 14px",borderRadius:8,background:s.bg,flexShrink:0}}>
                          <div style={{fontFamily:"'DM Mono', monospace",fontSize:22,fontWeight:500,color:s.text,lineHeight:1}}>
                            {best.result.score??<span style={{fontSize:14}}>ABO ✓</span>}
                          </div>
                          <div style={{fontSize:9,color:`${s.text}99`,marginTop:2}}>PAIR SCORE</div>
                        </div>
                      )}
                      {!best&&(
                        <div style={{textAlign:"center",padding:"8px 14px",borderRadius:8,background:"#2a1010",flexShrink:0}}>
                          <div style={{fontSize:13,color:"#ff8a8a"}}>No Match</div>
                        </div>
                      )}
                    </div>

                    {/* Divider */}
                    <div style={{borderTop:"1px solid #1e2d3d",marginBottom:10}}/>

                    {/* Best donor */}
                    {best?(
                      <>
                        <div style={{fontSize:10,color:"#4db882",fontFamily:"'DM Mono', monospace",marginBottom:6}}>BEST COMPATIBLE DONOR</div>
                        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:4}}>
                          <span style={{fontSize:14,fontWeight:600,color:"#c8d4dc"}}>{best.donor.donor_name}</span>
                          <span style={S.tag("#7a90a4")}>{best.donor.donor_blood_type}</span>
                          {best.donor.donor_priority&&<span style={{...S.tag({Primary:"#2dd4a0",Secondary:"#6ab4d0",Tertiary:"#ffd166"}[best.donor.donor_priority]||"#90a4b4"),fontSize:9}}>{best.donor.donor_priority}</span>}
                        </div>
                        <div style={{fontSize:12,color:"#b0bec5",marginBottom:8,display:"flex",gap:10,flexWrap:"wrap"}}>
                          {dAge&&<span>Age {dAge}</span>}
                          {best.donor.donor_egfr&&<span>eGFR {best.donor.donor_egfr}</span>}
                          {best.donor.donor_weight_kg&&recip.recipient_weight_kg&&(()=>{
                            const sd=v=>{const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,"")));return(!isNaN(n)&&n>0&&n<400)?n:null;};
                            const diff=Math.abs((sd(best.donor.donor_weight_kg)||0)-(sd(recip.recipient_weight_kg)||0));
                            return <span>{diff}kg size diff</span>;
                          })()}
                        </div>
                        {/* Narrative */}
                        <div style={{fontSize:12,color:"#6ab4d0",fontStyle:"italic",marginBottom:allMatches.length>1?8:0}}>
                          {matchNarrative({recip,best,waitlistDays})}
                        </div>
                        {/* Other compatible donors */}
                        {allMatches.length>1&&(
                          <div style={{fontSize:11,color:"#8a9aaa",marginTop:4}}>
                            +{allMatches.length-1} other compatible donor{allMatches.length>2?"s":""}: {allMatches.slice(1,3).map(m=>m.donor.donor_name?.split(" ")[0]).join(", ")}
                            {allMatches.length>3?` +${allMatches.length-3} more`:""}
                          </div>
                        )}
                      </>
                    ):(
                      <div style={{fontSize:12,color:"#5a3a3a",fontStyle:"italic"}}>
                        No ABO-compatible donor currently in the registry. Consider expanding the donor pool or reviewing blood type requirements.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {recipientMatches.length===0&&(
              <div style={{textAlign:"center",padding:60,color:"#8a9aaa"}}>
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
              <span style={{fontSize:11,color:"#90a4b4",fontFamily:"'DM Mono', monospace"}}>UNITS</span>
              {["metric","imperial"].map(u=>(
                <button key={u} onClick={()=>setUnitSystem(u)}
                  style={{padding:"3px 10px",borderRadius:5,border:"none",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace",
                    background:unitSystem===u?"#1e3a28":"transparent",color:unitSystem===u?"#2dd4a0":"#90a4b4"}}>
                  {u==="metric"?"Metric (kg/cm)":"Imperial (lbs/in)"}
                </button>
              ))}
              {unitSystem==="imperial"&&<span style={{fontSize:10,color:"#ffd166",marginLeft:4}}>values stored as kg/cm</span>}
            </div>
          </div>

          {!editingPair&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:24}}>
              {PAIR_TYPES.map(({value,label,desc})=>(
                <button key={value} onClick={()=>setForm(f=>({...f,pair_type:value}))}
                  style={{padding:16,borderRadius:10,border:`2px solid ${form.pair_type===value?"#2dd4a0":"#1e2d3d"}`,background:form.pair_type===value?"#0d2a1e":"#131c26",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                  <div style={{fontSize:14,fontWeight:600,color:form.pair_type===value?"#2dd4a0":"#ffffff",marginBottom:4}}>{label}</div>
                  <div style={{fontSize:12,color:"#b0bec5"}}>{desc}</div>
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
                      {yearWarn(form.recipient_year_born)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{yearWarn(form.recipient_year_born)}</div>}
                    </div>
                  </div>
                  <div>
                    <Field label="PRA %" type="number" placeholder="0–100" value={form.recipient_pra_percent} onChange={v=>setForm(f=>({...f,recipient_pra_percent:v}))}/>
                    {praWarn(form.recipient_pra_percent)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{praWarn(form.recipient_pra_percent)}</div>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <Field label={`Weight (${wLabel})`} type="number" value={displayWeight("recipient_weight_kg")} onChange={v=>setWeight("recipient_weight_kg",v)}/>
                      {weightWarn(form.recipient_weight_kg)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{weightWarn(form.recipient_weight_kg)}</div>}
                    </div>
                    <div>
                      <Field label={`Height (${hLabel})`} type="number" value={displayHeight("recipient_height_cm")} onChange={v=>setHeight("recipient_height_cm",v)}/>
                      {heightWarn(form.recipient_height_cm)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{heightWarn(form.recipient_height_cm)}</div>}
                    </div>
                  </div>
                  <div><label style={S.label}>CMV STATUS</label>
                    <select value={form.recipient_cmv} onChange={e=>setForm(f=>({...f,recipient_cmv:e.target.value}))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o=><option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div style={{borderTop:"1px solid #1e2d3d",paddingTop:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <label style={{...S.label,marginBottom:0}}>HLA TYPING <span style={{color:"#8a9aaa"}}>(optional)</span></label>
                      <button onClick={()=>setShowHLAAdvanced(v=>!v)} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace"}}>
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
                      {yearWarn(form.donor_year_born)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{yearWarn(form.donor_year_born)}</div>}
                    </div>
                  </div>
                  <div>
                    <Field label="eGFR (mL/min)" type="number" value={form.donor_egfr} onChange={v=>setForm(f=>({...f,donor_egfr:v}))}/>
                    {egfrWarn(form.donor_egfr)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{egfrWarn(form.donor_egfr)}</div>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div>
                      <Field label={`Weight (${wLabel})`} type="number" value={displayWeight("donor_weight_kg")} onChange={v=>setWeight("donor_weight_kg",v)}/>
                      {weightWarn(form.donor_weight_kg)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{weightWarn(form.donor_weight_kg)}</div>}
                    </div>
                    <div>
                      <Field label={`Height (${hLabel})`} type="number" value={displayHeight("donor_height_cm")} onChange={v=>setHeight("donor_height_cm",v)}/>
                      {heightWarn(form.donor_height_cm)&&<div style={{fontSize:11,color:"#ffd166",marginTop:3}}>{heightWarn(form.donor_height_cm)}</div>}
                    </div>
                  </div>
                  <div><label style={S.label}>CMV STATUS</label>
                    <select value={form.donor_cmv} onChange={e=>setForm(f=>({...f,donor_cmv:e.target.value}))} style={S.select}>
                      {["Unknown","Positive","Negative"].map(o=><option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div style={{borderTop:"1px solid #1e2d3d",paddingTop:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                      <label style={{...S.label,marginBottom:0}}>HLA TYPING <span style={{color:"#8a9aaa"}}>(optional)</span></label>
                      <button onClick={()=>setShowHLAAdvanced(v=>!v)} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono', monospace"}}>
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
                    <label htmlFor="backup" style={{fontSize:12,color:"#b0bec5",cursor:"pointer"}}>Designated backup donor</label>
                  </div>
                  <div>
                    <label style={S.label}>DONOR PRIORITY</label>
                    <div style={{display:"flex",gap:8,marginTop:4}}>
                      {DONOR_PRIORITIES.map(p=>(
                        <button key={p} onClick={()=>setForm(f=>({...f,donor_priority:p}))}
                          style={{flex:1,padding:"7px 0",borderRadius:7,border:`1.5px solid ${form.donor_priority===p?"#6ab4d0":"#1e2d3d"}`,
                            background:form.donor_priority===p?"#0d2030":"#131c26",
                            color:form.donor_priority===p?"#6ab4d0":"#90a4b4",
                            cursor:"pointer",fontSize:12,fontFamily:"'DM Mono', monospace",transition:"all 0.15s"}}>
                          {p}
                        </button>
                      ))}
                    </div>
                    <div style={{fontSize:11,color:"#8a9aaa",marginTop:5}}>
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
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
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
            <button onClick={()=>setView("grid")} style={{background:"none",border:"none",color:"#4db882",cursor:"pointer",fontFamily:"'DM Mono', monospace",fontSize:12,padding:0,marginBottom:24,letterSpacing:"0.05em"}}>← BACK TO GRID</button>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:28,flexWrap:"wrap",gap:16}}>
              <div>
                <h1 style={S.pageTitle}>Pair Score Report</h1>
                <p style={{margin:"4px 0 0",color:"#b0bec5",fontSize:13}}>{donor.donor_name} → {recipient.recipient_name}</p>
                {result.aboOnly&&result.reasons.abo&&<p style={{margin:"6px 0 0",padding:"6px 10px",borderRadius:6,background:"#0d1e2e",border:"1px solid #1a3a5a",color:"#6ab4d0",fontSize:12,display:"inline-block"}}>ABO compatible ✓ — enter HLA data to generate a Pair Score</p>}
                {!result.reasons.abo&&<p style={{margin:"6px 0 0",padding:"6px 10px",borderRadius:6,background:"#2a1010",border:"1px solid #3a1010",color:"#ff8a8a",fontSize:12,display:"inline-block"}}>ABO incompatible — exchange not possible without chain</p>}
              </div>
              {result.score!==null&&(
              <div style={{textAlign:"center",padding:"14px 22px",borderRadius:12,background:s.bg,border:`1px solid ${s.text}33`}}>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:`${s.text}88`,letterSpacing:"0.1em",marginBottom:4}}>PAIR SCORE</div>
                <div style={{fontFamily:"'DM Mono', monospace",fontSize:40,fontWeight:500,color:s.text,lineHeight:1}}>{result.score}</div>
                <div style={{fontSize:11,color:`${s.text}cc`,marginTop:4,letterSpacing:"0.1em"}}>{s.label.toUpperCase()}</div>
                <div style={{fontSize:10,color:`${s.text}66`,marginTop:6}}>out of 100</div>
              </div>
              )}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
              {[
                {label:"ABO Compatibility",value:result.reasons.abo?"Compatible ✓":"Incompatible ✗",ok:result.reasons.abo,detail:`${donor.donor_blood_type} → ${recipient.recipient_blood_type}`},
                {label:"Blood Type Efficiency",value:result.reasons.oToO?"O→O Ideal Match ✓":result.reasons.exactBloodMatch?"Exact Match ✓":result.reasons.suboptimalOUse?"O donor → non-O recipient":"Standard",ok:result.reasons.oToO||result.reasons.exactBloodMatch,warn:result.reasons.suboptimalOUse,detail:result.reasons.oToO?"O donors can only go to O recipients — this is the highest-efficiency pairing":result.reasons.suboptimalOUse?"This O donor could donate to any blood type — consider whether an O recipient exists in the chain":result.reasons.exactBloodMatch?"Donor and recipient share blood type — preserves chain efficiency":"Compatible — no efficiency concern"},
                {label:"HLA Mismatches",value:result.aboOnly?"Not entered":result.reasons.hlaMismatches+" / 6",ok:!result.aboOnly&&result.reasons.hlaMismatches<=2,warn:!result.aboOnly&&result.reasons.hlaMismatches<=4,detail:result.aboOnly?"Enter HLA alleles for a Pair Score":"0 = perfect match · 6 = full mismatch · drives 60% of score"},
                {label:"PRA Sensitization",value:`${recipient.recipient_pra_percent||"?"}%`,ok:result.reasons.highSensitization,warn:result.reasons.moderatePRA,detail:result.reasons.highSensitization?"Highly sensitized — match earns highest PRA bonus":result.reasons.moderatePRA?"Moderately sensitized — partial bonus if matched":"Low sensitization"},
                {label:"Size Compatibility",value:result.reasons.sizeMatch?"Acceptable":"Flag",ok:result.reasons.sizeMatch,detail:(()=>{const sd=v=>{const n=Math.round(parseFloat(String(v||"").replace(/[^\d.]/g,"")));return(!isNaN(n)&&n>0&&n<400)?n:null;};const dw=sd(donor.donor_weight_kg),rw=sd(recipient.recipient_weight_kg);return `Donor ${dw!=null?dw+"kg":"?"}  → Recipient ${rw!=null?rw+"kg":"?"} · >20kg gap flagged`;})()},
                {label:"CMV Risk",value:result.reasons.cmvRisk?"D+/R− Risk":"Acceptable",ok:!result.reasons.cmvRisk,detail:`Donor ${donor.donor_cmv||"?"} / Recipient ${recipient.recipient_cmv||"?"} · D+/R− increases recipient risk`},
                {label:"Age Gap",value:dAge&&rAge?`${result.reasons.ageDiff} yrs`:"Unknown",ok:!result.reasons.ageFlag,detail:`Donor ${dAge||"?"}y · Recipient ${rAge||"?"}y · >15yr gap flagged`},
                {label:"Donor eGFR",value:donor.donor_egfr?`${donor.donor_egfr} mL/min`:"Not recorded",ok:(donor.donor_egfr||0)>=60,detail:(donor.donor_egfr||0)>=60?"Adequate renal function":"Below 60 — review required"},
                {label:"Virtual Crossmatch",value:recipient.recipient_crossmatch_virtual||"Not recorded",ok:recipient.recipient_crossmatch_virtual==="Negative",detail:"Negative = no known antibody conflict · overrides score if available"},
              ].map(({label,value,ok,warn,detail})=>(
                <div key={label} style={{...S.card,borderColor:ok?"#1a3028":warn?"#2a2010":"#2a1010"}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:12,color:"#b0bec5"}}>{label}</span>
                    <span style={{fontFamily:"'DM Mono', monospace",fontSize:13,color:ok?"#2dd4a0":warn?"#ffd166":"#ff8a8a"}}>{value}</span>
                  </div>
                  <div style={{fontSize:11,color:"#8a9aaa",marginTop:5}}>{detail}</div>
                </div>
              ))}
            </div>
            <div style={{...S.card,marginBottom:16}}>
              <div style={{fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",letterSpacing:"0.1em",marginBottom:12}}>HLA ALLELE COMPARISON</div>
              {(donor.donor_hla_notes||recipient.recipient_hla_notes)&&(
                <div style={{marginBottom:12,fontSize:12,color:"#b0bec5"}}>
                  {donor.donor_hla_notes&&<div>Donor: <span style={{fontFamily:"'DM Mono', monospace",color:"#6ab4d0"}}>{donor.donor_hla_notes}</span></div>}
                  {recipient.recipient_hla_notes&&<div style={{marginTop:4}}>Recipient: <span style={{fontFamily:"'DM Mono', monospace",color:"#6ad0a0"}}>{recipient.recipient_hla_notes}</span></div>}
                </div>
              )}
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr>{["LOCUS","DONOR","RECIPIENT","MM"].map(h=><th key={h} style={{textAlign:h==="LOCUS"?"left":"center",padding:"6px 10px",fontFamily:"'DM Mono', monospace",fontSize:10,color:"#90a4b4",fontWeight:400}}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {["A","B","DR"].map(locus=>{
                    const dl=[donor[`donor_hla_${locus.toLowerCase()}1`],donor[`donor_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const rl=[recipient[`recipient_hla_${locus.toLowerCase()}1`],recipient[`recipient_hla_${locus.toLowerCase()}2`]].filter(Boolean);
                    const mm=dl.filter(a=>!rl.includes(a)).length;
                    return (
                      <tr key={locus} style={{borderTop:"1px solid #141c24"}}>
                        <td style={{padding:"9px 10px",fontFamily:"'DM Mono', monospace",fontSize:12,color:"#b0bec5"}}>HLA-{locus}</td>
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
              <button onClick={()=>window.print()} style={{...S.btn,background:"#0f2d1e",color:"#4db882"}}>Print Report</button>
            </div>
            <div style={{padding:"12px 16px",borderRadius:8,background:"#0d1a14",border:"1px solid #1a3028",fontSize:12,color:"#3d6a50"}}>
              ⚠ Pair Score is a computational screening tool, not a validated clinical index. Weights are provisional and should be reviewed with transplant professionals before operational use. All matches require crossmatch confirmation before any clinical decision.
            </div>
          </div>
        );
      })()}
      <style>{`select option{background:#1a2535;color:#e8e4dc;}input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5);}@media print{header,nav{display:none!important;}}`}</style>
    </div>
  );
}