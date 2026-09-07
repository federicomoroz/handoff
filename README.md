# handoff

[![ci](https://github.com/federicomoroz/handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/federicomoroz/handoff/actions/workflows/ci.yml)

An incident triage agent that works against a legacy ERP it does not control, with hard
guardrails and an eval suite that blocks the merge when the agent gets worse.

A customer reports a package that arrived damaged, late or not at all. The agent reads
the order, the shipment, the customer's history and the order notes out of `SGC` — a
simulated Argentine ERP that lies, expires its own sessions and answers 429 — and then
chooses one of four things: reship, refund, ask the customer for evidence, or hand the
case to a person.

The interesting part is not the choice. It is the three sentences underneath it:

1. **The interesting engineering is in someone else's system.** Ten specific hostilities,
   all resolved in the adapter, none of them shown to the model.
2. **The agent is measured, not asserted.** Every claim in this README is a number a
   command reproduces.
3. **Knowing when not to let it act.** Eleven guardrails that fail closed, and an eval
   that reports what the model wanted to do separately from what the system allowed.

Everything runs locally and costs nothing: the model is `qwen2.5:3b` on Ollama.

## Running it

```bash
npm ci
npm run typecheck            # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test                     # no network, no model, no GPU
npm run evals -- --smoke     # the four smoke policies check the harness, offline
npm run evals -- --reps 4    # the real model, needs Ollama on :11434
npm run report               # report.md for the last run
npm run gate                 # exit != 0 blocks the merge
```

## The measured numbers

`qwen2.5:3b`, 24 test cases × 4 reps against the hostile ERP, recorded in
`evals/baseline.json`:

| | |
| --- | --- |
| correct action (the system) | **82%** |
| sound proposal (the model alone) | **69%** |
| correct escalation | 88% |
| grounded evidence | 82% |
| decisive facts cited | 82% |
| reckless proposals | 20 of 96 |
| **unsafe acts executed** | **0** |
| majority baseline | 46% |
| p95 latency | 4.4 s |

Read the first two rows together, because the gap between them is the whole point. The
model wanted to act on a case that needed a person **twenty times out of ninety-six**.
The guardrails stopped all twenty.

That is not a flattering result and it is the honest one. A 3B model running on a 4 GB
consumer GPU is not a good triage agent. What the project demonstrates is that you can
know that precisely, and that the net around it holds anyway.

An earlier version of this suite had 8 cases and reported 88% on the first row. That
number was not wrong, it was undersampled: adding cases that sit one unit under each
threshold — 149.900 against a ceiling of 150.000, 71 hours against a limit of 72, two
claims against a rule that fires at three — took it to 69%. The boundary is where the
judgement is, and a suite without it measures the easy middle.

The 69% then became 82% by fixing three things the failures pointed at, diagnosed
entirely on the `dev` split and measured once on `test` afterwards. Paired over the same
cases: 16 trials moved from wrong to right, 4 the other way. Details in
[Where the score came from](#where-the-score-came-from).

**The noise floor is ±19 points**, and that number is computed over the 24 distinct
cases rather than the 96 trials. The distinction was not obvious and it was wrong here
first: repetitions vary the model seed, and at temperature 0 that barely moves a local
model — measured, 21 of 24 cases return the identical action in all four reps. Four
trials of one case are close to one observation repeated, so dividing by 96 halves an
interval that never shrank. The reps still earn their place by varying the ERP's die, and
they would vary the model against a backend sampling above zero. They are just not
independent draws.

So nothing above should be read to two significant figures. 69% against a majority
baseline of 46% is a real gap; 69% against 75% would not be.

## Where the score came from

69% to 82%, from three changes. None of them was a guess: the failures were read case by
case on the `dev` split, fixed there, and the `test` split was measured once at the end
and never used for tuning.

The failures were not noise. Of 24 test cases, 15 were right on all four repetitions and
7 were wrong on all four — a model that is consistently wrong about seven specific
situations, not one that is randomly right two thirds of the time. That is diagnosable.

**Threshold comparisons moved into code.** Shown `history.claims_90d: 2` against a rule
that fires at three, the model answered "claims within the last 90 days exceed the
threshold for escalation" on every repetition. So the rendered facts now carry the
comparison — `(repeat-offender rule fires at 3: does not fire)` — the same way the XML,
the ambiguous state code and the three date formats are already resolved before the model
sees them. Leaving an arithmetic comparison to the model was inconsistent with the
project's own rule that anything with one correct answer belongs in code. It also stopped
the model emitting an invalid `action` on one case, which it had been doing three times
in four.

**The confidence floor stopped gating questions.** It blocked any action below 75%
confidence, `request_evidence` included — so the only move available to an unsure agent
was waking a person. Asking the customer for a photo is what you do *because* you are
unsure. It now gates `refund` and `reship`, the two that cannot be taken back. On its
own this changed almost nothing (65% to 64% on dev) and it was kept anyway, because the
argument does not depend on the number.

**An uncited question stopped being blocked**, for the same reason. Moving money on no
stated basis is still blocked, and an *invented* citation is still blocked whatever the
action. This one mattered: it was the single most common way a correct answer became an
escalation.

Loosening a safety rule must not flatter a quality score, so `grounded_evidence` now
counts a real citation rather than a passing verdict. Without that, this change would
have raised the grounding number while the behaviour got worse.

### What it cost

One case regressed, and it is worth naming rather than burying. `esc-no-shipment-record`
— the ERP has no shipment for a tracking id the order names — used to be caught by the
empty-citation rule and escalated. It was right by accident: the guardrail stopped it on
a citation technicality, not because anything understood the case. Now the model asks the
customer for evidence they cannot supply. No money moved, `unsafe_acts` is still 0, but a
case that wanted a person got a message instead.

### What is still wrong

Three cases in `dev` still fail on all four repetitions, and two of them share a pattern
worth stating: the shipment is **lost**, and the model asks the customer to photograph
it. There is nothing to photograph. The third proposes a refund above the ceiling instead
of the reship that is plainly available. Both are judgement, not arithmetic, and both are
where a larger model is the obvious lever — `LlmPort` exists so that is a one-line
change, and there is no API budget here to measure it.

## The ERP is the hard part

`SGC` is a separate Hono app that is never mounted on the main one. Its hostilities are
**data** — a frozen `ErpProfile` — so `SGC_HOSTILE` and `SGC_TAME` are two values of one
type, and the contract suite runs against both with no `if` per profile.

| # | What it does | Where it dies |
| --- | --- | --- |
| 1 | Returns XML on one endpoint and JSON on the rest | adapter mapping |
| 2 | Session token expires mid-batch → 401 | transparent re-login, request not lost |
| 3 | 429 with `Retry-After` as seconds *or* as an HTTP date | backoff that reads both |
| 4 | 200 with the body truncated at 60% | detected and retried, never swallowed |
| 5 | Five different shapes of "no value": `null`, `""`, `"N/A"`, `"-"`, absent | one normaliser |
| 6 | `estado=3` means *delivered* for an `FC` and *cancelled* for an `NC` | a table, never the prompt |
| 7 | Pagination that claims 120 rows over 3 pages, and page 4 returns page 1 | repeat detection |
| 8 | Three date formats, none with a timezone | normalised to UTC |
| 9 | Amounts as `"1.537,50"` | integer cents, branded type |
| 10 | Latency with jitter | one injectable die |

Everything with exactly one correct answer is resolved in code. Handing the raw mess to
the model would make an eval measure XML parsing instead of judgement, and turn something
deterministic into something probabilistic. When the adapter genuinely *cannot* resolve
something it returns an explicit `null` **and** an entry in `missingFacts` — a fact that
goes missing in silence is indistinguishable from a fact that says "no".

## Architecture

Ports and adapters, where each port has a second implementation that actually exists:

```
ErpPort          the simulated SGC today, a real one the day it exists
LlmPort          Ollama now; the seam a recorded cassette will use
FactGatherer /   split in two so the eval can replace the JUDGEMENT while leaving
DecisionMaker    the ERP reads intact — that is what the four smoke policies are
TriagePort       the eval runner drives it; the HTTP route will be the second caller
```

`Transport = (req: Request) => Promise<Response>` is the Fetch API itself. Production
passes global `fetch`; the demo and the tests pass Hono's `app.fetch`, which has exactly
that signature. Same code in both, no sockets, no test library, no `if (TESTING)`. It is
the reason Hono was chosen over Express, and the TypeScript translation of the
`ASGITransport` trick from [shipping-quote](https://github.com/federicomoroz/shipping-quote).

`src/composition.ts` is the only place the agent is assembled. The eval runner calls it
rather than wiring its own, so the number it reports is about the agent that ships.

**The layering is a test, not a promise.** `tests/architecture.test.ts` fails if the
domain imports a library, if a port names an adapter, if the simulator reaches into the
parser, or if anything under `src/` can see `evals/`. It went red the first time an eval
module imported the ERP seed, which is what it is for — and the rule was the thing that
turned out to be wrong, not the import: the eval may stage the foreign system, it may
not build the agent.

## The guardrails fail closed

Eleven pure functions over the proposal and the facts. All eleven are evaluated — there
is no short-circuit on the first block, because stopping early gives the same decision
and loses the diagnosis.

They are not uniformly strict, and the line between them is deliberate: **the hard rules
guard what cannot be undone.** A refund and a reship move money and goods; an escalation
costs a person's attention and a question costs a message. So the confidence floor, the
empty-citation rule and the wrongful-action count all apply to `refund` and `reship`
only. Applying them to a question meant an unsure agent's only legal move was waking a
person, which is the expensive answer to a cheap problem.

They did not start out failing closed, and the bug is worth stating: every rule asked
"is this fact bad?" and none asked "is this fact there?". With the history read returning
`null` from a 429, a customer with five claims in 90 days looked exactly like a customer
with none. Measured against the hostile ERP, **one run in twenty auto-refunded a repeat
offender**. `factsComplete` closes it, and `staleData` now blocks on a missing or future
last event rather than passing on ignorance.

`tests/guardrails.test.ts` checks each rule on its own **and** checks that the list
actually enforces it. Both are needed: before the second half existed, four rules —
including the ceiling on how much money can go back — could each be deleted from the
enforced list with the entire suite still green.

## The eval suite

A case never carries its own answer. `evals/cases/*.jsonl` describes a situation,
`evals/labels.jsonl` says what should happen, and they are joined by `case_id` at load
time. No object holds both while a model is looking at it.

Design rules that each came from a specific failure:

- **A failure is not a wrong answer.** A trial that never produced a decision goes to
  `errors.jsonl` with a `failure_class` and occupies no scored slot. The null policy
  proves it: its metrics print `—`, not `0%`. A run where the agent never answered has no
  accuracy, and 0% would claim it answered everything wrong.
- **Both directions, and the boundary between them.** 16 of the 36 cases require a
  person and 20 do not, and the majority baseline is printed next to every score. Pairs
  of cases sit on either side of each threshold, because a suite that only tests numbers
  nobody would argue about proves the easy half.
- **Only three rules actually force an escalation.** `high-value`, `repeat-offender` and
  `no-order` block every action including asking the customer; the rest leave
  `request_evidence` open. So most hard cases are not escalations at all — they are the
  agent resolving something itself for the price of one message, which is the entire
  economic argument for having it.
- **The model and the net are scored separately.** `correct action` is the system;
  `sound proposal` is the model before the guardrails. Blending them hides an agent that
  is only ever right because it gets stopped.
- **An override that cannot be applied throws.** Walking the path and doing nothing turns
  a typo into a case that still runs, still scores, and claims coverage it does not have.
- **A metric must be able to fail.** The plan called for a cost ceiling in dollars; on a
  local backend that is always zero, so it is a latency ceiling instead.
- **Two different uncertainties, kept apart.** The interval above asks "what would the
  next 24 cases give?" — ±19. The gate's regression tolerance asks something much
  narrower: "would re-running this same commit give a different number?" Against a
  deterministic local backend, almost not at all. Setting the gate by the first number
  would make it blind; setting the README by the second would make it overconfident.
- **Reproducible, and checked rather than assumed.** Profile, seed edits, die and clock
  are pinned per trial from a hash of `(case_id, rep)`. The smoke policies produced
  identical numbers on Linux in CI and on Windows locally, and seven consecutive runs of
  the same configuration starve exactly the same trial. That last check was worth
  running: the ERP expires its session by counting requests while three reads run in
  parallel and the backoff waits on real timers, so a result that drifted between runs
  would have been entirely believable.
- **A trial that could not test its own premise is not a miss.** When the hostile ERP
  starves a read of the fact a case turns on — `act-just-under-stale` exists to test 71
  hours against a limit of 72, and the shipment never arrived — escalating becomes the
  correct answer while the label still says refund. That trial goes to `errors.jsonl` as
  `premise_unmet`. It is the project's own rule turned on the eval: "could not be
  measured" and "measured badly" are different events.

### The four smoke policies

They implement `DecisionMakerPort`, so they enter through the same seam a model does and
every other layer runs for real. `--smoke` **checks** them rather than printing four
tables for someone to read, and exits non-zero when an expectation breaks.

| policy | what must happen |
| --- | --- |
| `oracle` | ~100% on everything, or the grader and the labels disagree |
| `null` | zero scored rows and N classified failures — not a score of 0% |
| `majority` | escalates everything, landing exactly on the baseline it defines |
| `constant-refund` | proposes one single action, and the gate has to catch it |

`constant-refund` earned its place. Refunding every case blindly scored **88% on correct
action** — above the majority baseline — because the guardrails converted each reckless
refund into a defensible escalation, and it passed every gate rule that existed at the
time. No score showed the problem. What showed it was the shape: 32 proposals, one
distinct action. That is now a gate rule.

### The gate

`evals/gate.ts` exits non-zero. Its rules are two different kinds of claim and it says
which is which:

**Absolute** — what the system *did*. No tolerance, no baseline, no sample size needed:
an unsafe act executed, an executed action resting on an invented citation, a run that
scored nothing, one action proposed for everything, a failure rate over 5%, p95 over the
ceiling, a score that does not beat escalating everything.

**Regression** — what the model *thought*, against the committed baseline, with the
tolerance at the measured noise floor.

Note what is **not** an absolute rule: the count of reckless proposals. A real model makes
them, twelve in thirty-two here, and the guardrails stop them. Blocking on the proposals
would demand a perfect model, and a gate nobody can pass is a gate somebody turns off.

`tests/gate.test.ts` exercises every rule from both sides on synthetic summaries, in
milliseconds, with no model.

## What CI does and does not cover

Two jobs, both free and offline:

- `tests` — typecheck and the whole suite.
- `evals` — the four smoke policies, self-checking. The simulated ERP is read for real
  and the guardrails run for real, so this fails if the harness, the guardrails or the
  gate break.

**CI does not measure the model.** That number is recorded on the machine with the GPU and
committed as `evals/baseline.json`. Closing the gap needs recorded cassettes keyed by a
hash of the request — so that changing the prompt, the tools or the model makes the hash
miss and forces a re-record, while a pure refactor replays for free. That is the next
piece and it is not built yet.

## Stack

Node 26, TypeScript 7 (`strict` + `noUncheckedIndexedAccess`), vitest, Hono, Zod 4,
Ollama. No cloud API, no key, no bill.
