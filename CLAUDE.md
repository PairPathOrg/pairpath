# PairPath — Claude Code Context

## What this is
Free, open-source national kidney paired donation registry. Competes with 
fee-based networks (NKR, APKD) by being free for transplant centers and patients.
No patient-facing access — coordinators enter all data on behalf of patients.

## Stack
- Frontend: React + Vite, deployed on Vercel
- Database: Supabase/PostgreSQL (project ID: tyfrkmbuhyuvmypjmsny)
- Repo: github.com/PairPathOrg
- Domain: pairpath.org

## Entry types
- Incompatible Pair (donor + recipient who can't donate to each other)
- Altruistic Donor (willing to donate to anyone)
- Recipient Only (for altruistic donors to connect with)

## Key product decisions
- No full DOB — year of birth only (PHI minimization); CSV upload accepts full DOB, extracts year
- HLA and CMV fields optional; scoring degrades gracefully
- Solo mode default, toggle to National
- CSV field mapping built for Epic EMR export format
- donor_backup is boolean — must NOT be sent as string
- Row Level Security enabled; admin = maggie2jacobs@gmail.com
- Stage 2 (chain coordination workflow) not started yet

## Views
- Compatibility grid
- Registry (filterable/sortable)
- Chains (unlimited-length exchange chains)
- Dashboard
- Add/edit form

## Test data
All test entries have centre = "TEST" for easy bulk deletion.
50 recipient-only + 10 altruistic donors uploaded. 
20 incompatible pairs CSV generated but not yet uploaded.

## Current status / known issues
App.jsx was incomplete/broken at end of last session — may need review and repair.