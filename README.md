<div align="center">

# Torque

**A real-time robotics control language where physical units are first-class,
control loops declare their deadlines, pub/sub is built in, the same source
drives sim or real hardware — and your functions export themselves as LLM tool schemas.**

[![tests](https://img.shields.io/badge/tests-35%2F35_passing-brightgreen)](#testing)
[![runtime deps](https://img.shields.io/badge/runtime_dependencies-0-blueviolet)](#zero-runtime-dependencies)
[![node](https://img.shields.io/badge/node-%E2%A5%A522.6-brightgreen?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![language](https://img.shields.io/badge/language-Torque_.tq-orange)](#language-reference)
[![LOC](https://img.shields.io/badge/source-~3.5k_lines-informational)](#repository-layout)

```torque
loop control @ 50hz, deadline: 4ms {
    let cur = read("angles")                    // Vec3 of Angles from the backend
    let cmd = cur + (waypoint - cur) * 0.5      // dimensional arithmetic
    write("targets", cmd)                       // same source runs sim OR serial hardware
    publish(/joint_state, cur)
}
```

*Interpreted on Node.js. `git clone` and go — nothing to install.*

</div>

---

## Quickstart

Requires **Node.js ≥ 22.6** (`node --version`). Nothing else.

```bash
git clone https://github.com/hexa3/torque && cd torque

# Flagship demo: closed-loop control of a simulated 3-DOF arm (~50hz, zero overruns)
node src/cli.ts run examples/07_arm_sim.tq --for 3s

# Or take the full guided tour of every feature (~15s):
npm run demo

# Run the test suite (35 tests covering all seven pillars):
npm test
```

CLI:

```
torque run   FILE.tq [--backend sim|serial] [--port /dev/ttyUSB0] [--for 2s]
                   [--tune kp=8@600ms ...] [--quiet]
torque check FILE.tq        # parse + memory-safety lint only
torque ast   FILE.tq        # dump AST as JSON
torque tools FILE.tq        # emit #[tool] functions as LLM tool JSON
```

---

## The seven pillars, each with a runnable proof

| # | Pillar | Proof |
|---|--------|-------|
| 1 | Deterministic loops w/ deadline tracking | `examples/04_blink.tq` (clean), `05_overrun.tq` (warnings); loop report at exit shows ticks/overruns/achieved-hz |
| 2 | Physical units & frames as first-class types | `examples/01_units.tq`, `10_frames.tq`; `02_unit_error.tq` is *rejected* with `cannot add Length and Angle` |
| 3 | Memory-safe-by-convention execution | `torque check examples/11_alloc_lint.tq` → rejected; lint is transitive through user functions |
| 4 | Native pub/sub | `examples/06_topics.tq` — topics, `on` handlers, `publish()` over an in-process bus with typed payloads |
| 5 | Sim/hardware backend swap | `examples/07_arm_sim.tq` runs unchanged under `--backend sim` **and** `--backend serial --port …` (verified end-to-end against kernel PTY pairs; see [RESULTS.md](RESULTS.md) for real-hardware status) |
| 6 | LLM tool-calling export | `node src/cli.ts tools examples/08_tools.tq` emits Anthropic-API *and* MCP-shaped JSON |
| 7 | Live-tunable parameters | `examples/09_live.tq` + stdin REPL (`set kp 8`) or `--tune "kp=8@600ms"` |

---

## The numbers

Everything below is measured, not aspirational — reproduce it yourself.

### Codebase

| Metric | Value |
|---|---|
| Interpreter source | **20 files, ~3,500 lines of TypeScript** |
| Runtime dependencies | **0** (`git clone` + Node is the whole install) |
| Test suite | **35 tests**, ~11 s wall time, incl. an end-to-end serial test over a kernel PTY pair |
| Example programs | **11** `.tq` files — they double as the spec; two are deliberate negative tests |
| Built-in functions | **36** (math, trig, geometry/frames, containers, timing, I/O) |
| Unit suffixes | **22** fused into numeric literals at lex time |
| Type names | Length · Angle · Duration · Mass · Frequency · Velocity · AngularVelocity · Force · Torque · number · f64 · int · Bool · String · Vec3 · Pose · Transform3 · Frame · Any · `[T]` |
| Reference firmware | 89-line Arduino sketch (`firmware/torque_servo.ino`, Adafruit PCA9685) |

### Determinism (measured from the demo transcript)

| Loop | Declared | Achieved | Overruns | Deadline |
|---|---|---|---|---|
| `heartbeat` (blink) | 50 hz | 49.63 hz | 0 | 2000 µs, max tick 1119 µs |
| `control` (arm sim) | 50 hz | 49.95 hz | 0 | 4000 µs, max tick 2021 µs |
| `osc` (live tuning) | 100 hz | 99.80 hz | 0 | 2000 µs, max tick 780 µs |
| `too_slow` (deliberate) | 200 hz | 154.76 hz | **40 detected & counted** | 500 µs vs 5147 µs ticks |

Ticks are scheduled drift-free against absolute time (`period × k`, never
`now + period`). Each tick's wall time is measured against your declared
deadline; violations print a throttled `[overrun]` warning, increment a
counter, and land in the exit report. Beating a deadline is *measured*,
not promised — see [RESULTS.md](RESULTS.md).

### Dimensional analysis, enforced at runtime

```
120mm + 30cm   = 420 mm          # cross-scale arithmetic
1500mm > 1m    = true            # comparisons convert scales
10m / 2s       = 5 m/s           # derived dimensions (Velocity)
(90).deg       = 1.5708 rad      # unit-member sugar
1m + 45deg     ✗ "cannot add Length and Angle"
5 + 3m         ✗ bare numbers don't mix by addition
let x: Length = 45deg            ✗ typed slots check dimensions
```

---

## Language reference

### Program structure

A program is a sequence of declarations and top-level statements. Execution order:
top-level statements run first, then all `loop`s are armed, then `fn main()` runs.
**The program ends when `main` returns** (loops keep spinning while it does), or — with
no `main` — until Ctrl-C or every loop stops.

```
program     := decl*
decl        := annotation? fnDecl | loopDecl | topicDecl | onDecl | stmt

fnDecl      := "fn" IDENT "(" params? ")" ("->" type)? block
params      := IDENT ":" type ("," IDENT ":" type)* [","]
annotation  := "#[" "tool" "(" STRING ")" "]"          // only on fn

loopDecl    := "loop" IDENT "@" expr "," "deadline" ":" expr block
topicDecl   := "topic" "/" PATH ":" type ("@" NUMBER "hz")?
onDecl      := "on" "/" PATH "->" IDENT block
PATH        := SEGMENT ("/" SEGMENT)*                  // e.g. joint/state
```

### Units (the fun part)

Numeric literals fuse with unit suffixes into dimensioned quantities:

| suffixes | type |
|----------|------|
| `mm cm m km inch ft` | Length |
| `deg rad rev` | Angle |
| `us ms s min` | Duration |
| `g kg` | Mass |
| `hz` | Frequency |
| `N` | Force |
| `Nm` | Torque |
| `%` | percent → plain number (50% == 0.5) |

Dimensional rules enforced at runtime:

* `1m + 45deg` → **error**: `cannot add Length and Angle`
* `5 + 3m` → **error**: bare numbers are dimensionless and don't mix by addition
* `10m / 2s` → Velocity (prints as `5 m/s`)
* comparisons convert across scales: `1500mm > 1m` is `true`
* typed slots check dimensions: `let x: Length = 45deg` is rejected
* `.to(unit)` converts: `(1500mm).to(ft)`, `(50).to(%)` → `0.5`
* unit-name members work on any quantity or bare number: `(90).deg`, `x.rad`
* trig is strict: `sin()` takes an **Angle**, returns a bare number; `atan2(y, x)` returns radians

### Statements & expressions

```
stmt    := letStmt | assign | if | while | for | return | break | continue | exprStmt
letStmt := ("let"|"live") IDENT (":" type)? "=" expr
assign  := (IDENT | expr "[" expr "]" | map "." IDENT) ("="|"+="|"-="|"*="|"/=") expr
expr    := literals | idents | unary(- !) | binary(|| && == != < > <= >= + - * / %)
         | calls f(x) | index a[i] | member m.f | arraylit [..] | maplit {k: v, ...}
```

Comments: `// line` and `/* block */`. Semicolons optional. Strings are `"double quoted"`
with `\n \t \" \\` escapes. Arrays and maps compare structurally (deep equality).

### Loops

```
loop heartbeat @ 50hz, deadline: 2ms { ... }
```

* Frequency must be a Frequency literal (`50hz`); deadline a Duration (`2ms`).
  Default deadline if omitted: half the period.
* Inside the body: `tick` (0-based counter) and `tick_count()` are available.
* Ticks are scheduled drift-free against absolute time. Each tick's wall time is measured;
  exceeding the deadline prints a throttled `[overrun]` warning and increments the counter.
  A per-loop report (ticks, overruns, missed resyncs, max tick, achieved hz) prints at exit.
* Builtins useful here: `now()` (Duration since start), `spin(5ms)` (busy-wait CPU burner,
  for overrun demos), `run_for(3s)` (pump everything for a duration), `stop("name")`.

### Topics & handlers

```
topic /joint_state: Vec3 @ 25hz          // declared payload type + advisory rate
on /joint_state -> js { print(js.x) }    // handler runs when a message arrives
publish(/joint_state, angles)            // from anywhere
```

Publishing checks the payload against the declaration (`publish(/a, 1m)` onto an `Angle`
topic is rejected). Handlers share globals with everything else and dispatch serially per
subscriber with bounded queues (oldest dropped at 64 pending).

### Backends

The active backend (chosen by CLI flag, default `sim`) serves string-keyed channels:

```
read("angles") -> Vec3<Angle>       current joint angles
read("angle<i>") -> Angle           one joint
write("targets", Vec3<Angle>)      command target angles
```

* **SimBackend**: three joints slewing toward targets at ~162°/s with catch-up capping.
* **SerialBackend**: encodes each joint to PCA9685 servo pulses over the wire protocol
  below; uses device feedback when streamed, otherwise echoes last commands (open-loop).

Wire protocol (line-based ASCII):

```
host -> device :  "T <channel> <pulse_us>\n"     # [-90°,+90°] -> [500us,2500us]
device -> host :  "A <channel> <angle_cdeg>\n"   # optional feedback stream
```

`firmware/torque_servo.ino` is a working Arduino + Adafruit PWM Servo Driver sketch that
speaks this protocol. Real-hardware status: see [RESULTS.md](RESULTS.md).

### Frames & transforms

```
let base = frame("base")
let link1 = frame("link1", base, transform(vec3(0mm, 0mm, 80mm),
                                           vec3(0deg, js.x, 0deg)))   // parent-linked
place(link1, transform(...))               // re-place a frame; children follow
let p = apply(world_transform(link1), vec3(100mm, 0mm, 0mm))  // FK through the chain
compose(t1, t2)                            // also written t1 * t2
pose(pos_vec3, rpy_vec3)                   // .pos / .rpy accessors
```

Rotation convention: ZYX Euler (yaw·pitch·roll applied in that order).

### Tool export

```
#[tool("Move the robot end-effector to a target position")]
fn move_to(x: Length, y: Length, z: Length) -> String { ... }
```

`torque tools file.tq` emits one JSON object per annotated function with both
`input_schema` (Anthropic Messages API) and `inputSchema` (MCP). Unit-typed parameters
become `number` properties whose descriptions carry the physical meaning
(`"Length — length in meters"`), so an LLM knows what it's passing.

### Live tuning

Declare `live kp = 1.5`. While the program runs:

```
set kp 8          # or: set kp = 8   or:   kp = 8
get kp
vars              # list live variables
stats             # live loop report
quit              # SIGINT -> graceful shutdown with report
```

Or automate it: `--tune "kp=8@600ms"` (repeatable). Values are parsed and evaluated with
the full Torque expression grammar (`set kp 2*pi()` works), REPL commands are applied in
order even when stdin is piped, and typed slots stay type-checked.

---

## Testing

```
npm test        # 35 tests, ~11s
```

| Suite | Coverage |
|---|---|
| `lang.test.ts` (17) | unit dims, dimensional rejections, derived units, cross-scale compare, `.to()`, typed slots, recursion/control-flow, Vec3 ops, hand-computed FK, plus regressions: multi-entry map literals, deep equality, pose/frame accessors, `t1 * t2`, `.to(%)`, for-in typing, topic-rate parsing |
| `backends.test.ts` (8) | sim slew dynamics, channel/payload rejection, pulse mapping at rails + round-trip, wire encoding, feedback adoption, bus ordering, bus payload enforcement, unit formatting |
| `runtime.test.ts` (10) | black-box CLI runs of the examples: output, exit codes, loop reports, overrun counting, alloc-lint rejection, `check`, tool-export shape, mid-run `--tune` behavior change, arm-sim end-to-end, and a **socat PTY-pair serial test against fake firmware** (skips gracefully if socat/python3 absent) |

`bash demo/run_demo.sh` captures a full guided-tour transcript to `demo/demo_output.txt`.

---

## Repository layout

```
src/
  lexer.ts parser.ts tokens.ts ast.ts front.ts   hand-written lexer + recursive-descent parser
  units.ts values.ts types.ts                    dimensional-analysis core + runtime values
  interpreter.ts builtins.ts                     async tree-walking evaluator + 36 builtins
  scheduler.ts bus.ts checker.ts                 fixed-tick loops, pub/sub, alloc lint
  backends/{backend,sim,serial}.ts               swappable I/O backends
  tools.ts live.ts runtime.ts cli.ts             tool export, REPL/tuner, orchestration, CLI
examples/*.tq                                    the spec-as-examples (01…11)
tests/*.test.ts                                  35 tests; `npm test`
firmware/torque_servo.ino                        Arduino+PCA9685 reference firmware
demo/run_demo.sh                                 one-command guided tour
RESULTS.md                                       what's real, what's partial — no marketing
```

## Zero runtime dependencies

`package.json` declares none. Everything is Node ≥ 22.6 built-ins plus native
TypeScript type-stripping — no transpiler step, no bundler, no node_modules
at runtime. The only devDependency is `@types/node`.

---

## Honest limitations

Read [RESULTS.md](RESULTS.md) for the no-marketing version: what is real, what is partial,
what is future work. Headlines: units are checked at runtime not compile time; determinism
is best-effort scheduling with measurement, not WCET proof; the allocation lint is syntactic
and transitive, not a borrow checker; the serial backend was verified against kernel PTYs
with fake firmware, not against physical servos.

---

## License

[MIT](LICENSE)

Part of a robotics & simulation series with [helios](https://github.com/hexa3/helios), [drag_sim](https://github.com/hexa3/drag_sim), and [block_craftz](https://github.com/hexa3/block_craftz).

---

<p align="center">Built by <a href="https://sheheryar.xyz">Sheheryar</a> · <a href="https://github.com/hexa3">github.com/hexa3</a></p>
