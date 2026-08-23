# RESULTS.md — what actually works, no marketing

This file exists so you don't have to reverse-engineer the README's enthusiasm.
Everything below was verified by running it: `npm test`, `bash demo/run_demo.sh`,
and the per-example commands shown.

Status: working MVP. Every claim in the README maps to a test or a runnable
example, and the "partial / not real" lists here are the complete set of caveats
we know about. If you find something missing from this list, that's a bug in
this document — please treat it as such.

---

## What is real

**Physical units & dimensional analysis.** Numeric literals fuse with unit
suffixes at lex time; arithmetic goes through a 4-base-dimension signature
system (Length, Mass, Time, Angle). `120mm + 30cm = 420 mm`, `10m / 2s` is a
Velocity, `1500mm > 1m` compares across scales, `1m + 45deg` aborts with
`cannot add Length and Angle`. Verified: `tests/lang.test.ts`,
`examples/01_units.tq`, `02_unit_error.tq`.

**Deterministic-feeling loops with deadline measurement.** Ticks are scheduled
against absolute deadlines (`period * k`, not `now + period`) so there is no
cumulative drift; each tick's wall time is measured against the declared
deadline; overprints are throttled and counted; an exit report prints ticks,
overruns, missed resyncs, max tick, achieved hz. Verified: `04_blink.tq`
(49.9–50 achieved vs 50 declared), `05_overrun.tq` (deliberate overruns counted).

**Pub/sub with typed payloads.** In-process bus; `topic /x: Vec3 @ 25hz`
declares a payload type enforced on every `publish`; handlers run serially per
subscriber from bounded FIFO queues (64 pending, oldest dropped). Verified:
`06_topics.tq`, `tests/backends.test.ts`.

**Backend swap: sim ↔ serial, same source.** The interpreter only sees
string-keyed `read`/`write` channels. `07_arm_sim.tq` runs unchanged under
`--backend sim` and `--backend serial`. The serial backend speaks the documented
wire protocol (`T <ch> <pulse_us>` out, `A <ch> <angle_cdeg>` feedback in) and
prefers device feedback when streamed, echoing last commands otherwise (it does
not invent data).

**LLM tool export.** `#[tool("...")]` functions emit JSON with both
`input_schema` (Anthropic Messages API) and `inputSchema` (MCP) spellings;
unit-typed parameters become numbers whose descriptions carry the physical
meaning. Verified: `torque tools examples/08_tools.tq`.

**Live tuning.** `live kp = 1.5` + REPL (`set kp 8`) or automated
`--tune "kp=8@600ms"` (repeatable). Assignments go through the real parser and
evaluator, so full expressions work and typed slots stay checked. Verified:
`09_live.tq`, runtime CLI tests.

**Allocation lint (transitive).** Array/map literals, `push/pop/str`, and string
concatenation inside armed loop bodies are rejected by `torque check`; calls
into user functions are followed transitively (cycle-guarded). Geometry
constructors and pure math are allowed. Verified: `11_alloc_lint.tq`.

**Zero runtime dependencies.** `package.json` declares none; everything is
Node ≥ 22.6 built-ins plus TypeScript type-stripping. `git clone` and go holds.

---

## Verification summary

* `npm test` — 35 tests: unit semantics (10+7 language tests incl. regressions
  for map literals, deep equality, pose accessors, `t1 * t2`, `.to(%)`,
  for-in typing, topic-rate parsing), backend dynamics and pulse mapping (8),
  end-to-end CLI behavior (10) including a **socat PTY-pair serial test**
  against fake firmware (skipped gracefully if socat/python3 are absent).
* `bash demo/run_demo.sh` — guided tour capturing a transcript to
  `demo/demo_output.txt`.
* All 11 examples run; `02` exits 1 by design, `11` is rejected by design.

---

## What is partial

**Units are checked at runtime, not compile time.** `1m + 45deg` fails when the
line executes, not when the file loads. A static pass could catch most of these
before running; it doesn't exist yet. `torque check` currently runs only the
allocation lint, not a unit checker.

**"Deterministic" means measured, not proven.** This is best-effort soft
real-time on a GC'd runtime: Node can pause for GC, timers fire late under load,
and there is no WCET analysis, no RT priority, no lock-free anything. What you
get is drift-free *scheduling*, per-tick overrun *detection*, and honest exit
reports — enough to notice jitter, not to eliminate it. `spin()` is a busy-wait;
a long tick blocks the whole event loop (loops are cooperative).

**The allocation lint is syntactic.** It follows direct calls transitively but
does not track aliasing, reassignment, or values escaping through maps/arrays
built outside the loop; it cannot see allocations inside host builtins other
than the ones it special-cases. Treat it as a style guard, not a borrow checker.

**Serial hardware is PTY-verified, not servo-verified.** The serial backend and
the Arduino sketch agree on the wire protocol, and end-to-end bytes-through-a-
PTY-pair is tested against a fake Python firmware. No physical PCA9685/servo
rig was exercised during development. Expect calibration friction (pulse rails,
slew limits) on real metal.

**Sim backend is fixed at 3 joints** with a hard-coded slew rate (~162°/s) and
optional Gaussian noise that no CLI flag exposes yet. `read("angles")` on the
serial side also assumes 3 components regardless of configured joint count.

**Topic advisory rates are decorative.** `@ 25hz` is parsed and stored but
nothing enforces or shapes traffic to it. Queues bound memory, not rate.

**The checker doesn't know types.** Beyond the lint, there is no static
type/dimension checker; annotated slots (`let x: Length`) are checked at
assignment time at runtime.

---

## Known sharp edges

* `%` is ambiguous between "percent suffix" and modulo; the lexer disambiguates
  by adjacency (`5% 2` fuses percent into the number). Prefer spaces around
  modulo.
* Keywords are not reserved inside topic paths or after `.`; exotic programs
  can mislex division as a topic path (the lexer uses an operand-position
  heuristic).
* Map equality is order-independent structural equality; array equality is
  element-wise. Both are deep.
* `for x in v` requires an array (anything else is a type error).
* Handlers share globals with everything else; a handler that throws logs and
  drops the message rather than failing the program.

## Future work (in rough priority order)

1. Static dimension/type checker wired into `torque check`.
2. Physical-hardware bring-up: verify pulse rails/slew on a real PCA9685 rig,
   expose sensor-noise and joint-count knobs on the CLI.
3. Enforce topic advisory rates (shaping or rejection) and surface queue-drop
   stats in the loop report.
4. WCET hints per loop body (measure + report p99 tick time alongside max).
5. Multi-loop priorities (currently all loops are peers in one event loop).
6. A `--profile` mode exporting tick-time histograms.
