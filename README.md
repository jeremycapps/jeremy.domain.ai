# Corus

**Corus is a program whose product is job application packets.**

It coordinates candidate evidence, job opportunities, capability interpretation, application materials, validation, author decisions, and submission history so application work can continue without reconstructing context from scratch.

This repository currently contains the backend and recovery experiments for that program. It is not yet the complete automated job-application product.

## Product direction

The shortest useful Corus loop is:

```text
find jobs → filter → score → deduplicate → save → review
```

Once an opportunity is selected, Corus should be able to produce a grounded application packet:

```text
opportunity
→ requirements
→ admitted candidate evidence
→ capability mapping
→ packet composition
→ validation
→ author approval
→ submission record
```

A job application packet may include a tailored résumé, cover letter, application answers, work samples, and outreach copy. Generated language is never candidate truth; packet claims must remain traceable to admitted evidence.

## What exists today

The codebase is a TypeScript/Node.js backend with two related proof paths.

### Resume router

- Loads structured experience data and cached résumé artifacts.
- Routes a job description to a role archetype.
- Selects a bounded set of experience units.
- Generates or validates résumé Markdown.
- Writes generation records that distinguish reusable drafts from source truth.
- Exposes `POST /api/generate-resume`.

### Corus capability pipeline

- Preserves candidate and job contexts.
- Reduces those contexts into evidence-linked capability claims.
- Validates claims and blocks unsupported projections.
- Supports mocked, fixture, and live provider execution.
- Records provider provenance, token admission, execution receipts, and generation metadata.
- Exposes `POST /api/capability-analysis` and a readiness endpoint.

The Prophet fixture is the current golden vertical slice. It replays:

```text
structured context preservation
→ capability reduction
→ capability validation
→ projection
→ capability admission
→ awaiting author
```

### Recoverable program state

The latest implementation adds:

- canonical `CorusProgram` process definitions and transition rules;
- deterministic next-action planning;
- process history replay without provider calls;
- filesystem-backed `DomainMemory`;
- content-addressed records, proposals, admissions, and checkpoints;
- ordered event continuity using ordinals and parent references;
- recovery from the latest verified checkpoint.

These are foundations for safe continuation. They do not yet make Corus an autonomous local workflow.

## Roadmap status

### Foundation — implemented

The repository has proved that Corus can:

- route a job description into relevant candidate context;
- generate and validate a résumé draft;
- coordinate multiple model providers behind a provider-neutral execution boundary;
- represent one capability-analysis run as recoverable program state;
- derive continuation from declared process transitions;
- stop at an explicit author decision;
- persist and recover verified state without replaying model calls.

This is the current architectural checkpoint.

### v0 — local automated job intake (now)

The immediate product milestone is a local workflow that runs on a schedule:

1. Read local `experience_units.yaml` and search criteria.
2. find appropriate jobs from configured sources;
3. exclude jobs already present in the ledger;
4. score credible matches against candidate evidence and preferences;
5. append new matches to `opportunities.jsonl`;
6. write a dated Markdown digest for review.

Definition of done:

> The local task runs without prompting, discovers useful jobs, avoids duplicates, and leaves a reviewable ledger and daily digest.

For v0, Corus does **not** apply automatically or generate packets automatically. The scheduler is the runtime, local files are the state, and the operating instructions are the contract.

This local intake loop is not yet implemented in this repository.

### v1 — manually triggered application packets

After intake is reliable:

- select one opportunity;
- reduce and account for its requirements;
- retrieve relevant admitted evidence;
- generate a complete application packet;
- validate unsupported claims and missing requirements;
- pause for author approval;
- preserve the approved packet and any submission receipt.

The existing Prophet capability pipeline and résumé generator are partial foundations for this phase, but they are not yet connected into a complete packet workflow.

### v2 — review and submission surface

Later work may add:

- a web interface for opportunities and submitted applications;
- packet comparison and version history;
- review, approval, and submission controls;
- employer-response tracking;
- portfolio-level prioritization.

### Deferred architecture

The following are intentionally deferred until the local workflow proves they are necessary:

- generic Domain contract extraction;
- a generalized harness compiler;
- Project as a runtime object;
- semantic retrieval;
- multi-user organizations and permissions;
- concurrent state-changing processes;
- a synthetic-filesystem UI;
- outcome-driven learning across applications.

The product roadmap now prioritizes a working local loop over additional abstraction.

## Relationship to Domain

Domain is the broader architecture for portable, source-grounded, recoverable work. Corus is one concrete program running on those ideas.

The working distinction is:

```text
Domain  = recovery, provenance, admission, and continuation laws
Corus   = the ongoing job-application program
Product = a job application packet
```

The repository currently contains both Corus product code and emerging Domain memory primitives. Generic contracts should be extracted only after the concrete Corus workflow demonstrates which abstractions are actually shared.

## Run locally

Requirements:

- Node.js 20 or newer
- npm
- provider credentials only for the live modes being used

```bash
npm install
npm test
npm run dev
```

The server listens on `http://localhost:3000` by default.

Useful endpoints:

```text
GET  /health
GET  /api/capability-analysis/readiness?mode=live
POST /api/capability-analysis
POST /api/generate-resume
```

Useful fixture and diagnostic commands are listed in `package.json`. Live commands may make paid provider calls and should only be run with the intended credentials and data-egress boundary.

## Current product constraint

Corus should remain simple enough to run locally this week.

New architecture is justified only when it removes a demonstrated failure from the live workflow. The next code should close the scheduled intake loop, not broaden the ontology.
