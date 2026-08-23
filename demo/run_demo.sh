#!/usr/bin/env bash
# Torque end-to-end demo.
#
# Runs every pillar of the language and captures the full transcript to
# demo/demo_output.txt. No arguments needed; socat+python3 unlock the
# serial-backend segment but everything else is dependency-free.

set -u
cd "$(dirname "$0")/.."

TQ="node src/cli.ts"
OUT="demo/demo_output.txt"

say() { printf '\n\033[1;36m═══ %s ═══\033[0m\n' "$1" | tee -a "$OUT"; }

: > "$OUT"

say "1. Physical units (examples/01_units.tq)"
$TQ run examples/01_units.tq 2>&1 | tee -a "$OUT"

say "2. Dimensional analysis rejects nonsense (examples/02_unit_error.tq)"
$TQ run examples/02_unit_error.tq 2>&1 | tee -a "$OUT"
echo "   -> exit code: ${PIPESTATUS[0]}" | tee -a "$OUT"

say "3. Deterministic control loop, deadline met (examples/04_blink.tq --for 400ms)"
$TQ run examples/04_blink.tq --for 400ms 2>&1 | tee -a "$OUT"

say "4. Deadline overrun detection (examples/05_overrun.tq --for 250ms)"
$TQ run examples/05_overrun.tq --for 250ms 2>&1 | tee -a "$OUT"

say "5. THE FLAGSHIP — closed-loop 3-DOF arm on the sim backend (examples/07_arm_sim.tq)"
$TQ run examples/07_arm_sim.tq --for 2s 2>&1 | tail -n +2 | head -30 | tee -a "$OUT"

say "6. Same arm source over REAL serial bytes to a fake PCA9685 firmware"
if command -v socat >/dev/null && command -v python3 >/dev/null; then
  P0=/tmp/opencode/tq_demo0; P1=/tmp/opencode/tq_demo1
  rm -f "$P0" "$P1" 2>/dev/null || true
  socat -d -d "pty,raw,echo=0,link=$P0" "pty,raw,echo=0,link=$P1" </dev/null >/dev/null 2>&1 &
  SOCAT_PID=$!
  sleep 0.7
  cat > /tmp/opencode/tq_demo_fw.py << 'PYEOF'
import os, time
fd = os.open("/tmp/opencode/tq_demo1", os.O_RDWR | os.O_NONBLOCK)
buf = b""
angles = [0.0, 0.0, 0.0]
deadline = time.time() + 5
while time.time() < deadline:
    try:
        data = os.read(fd, 512)
        if data:
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                parts = line.decode(errors="replace").split()
                if len(parts) == 3 and parts[0] == "T":
                    ch, us = int(parts[1]), int(parts[2])
                    ang = ((us - 500) / 2000 * 2 - 1) * 90
                    angles[ch] += max(-45, min(45, ang - angles[ch]))
                    os.write(fd, ("A %d %d\n" % (ch, int(angles[ch] * 100))).encode())
    except OSError:
        pass
    time.sleep(0.005)
PYEOF
  python3 /tmp/opencode/tq_demo_fw.py &
  FW_PID=$!
  sleep 0.3
  $TQ run examples/07_arm_sim.tq --backend serial --port "$P0" --for 1500ms 2>&1 \
    | grep -E "^\[(ee|control)\]" | head -12 | tee -a "$OUT"
  kill $FW_PID 2>/dev/null
  kill $SOCAT_PID 2>/dev/null
else
  echo "   (skipped: socat/python3 not found)" | tee -a "$OUT"
fi

say "7. LLM tool-calling export (torque tools examples/08_tools.tq)"
$TQ tools examples/08_tools.tq 2>/dev/null > /tmp/opencode/tq_tools.json
if command -v python3 >/dev/null && python3 -c "import json; tools=json.load(open('/tmp/opencode/tq_tools.json')); print(json.dumps(tools[0], indent=2))" 2>/dev/null | tee -a "$OUT"; then
  : # pretty-printed above
else
  head -25 /tmp/opencode/tq_tools.json | tee -a "$OUT"
fi

say "8. Live-tunable parameter changes a running loop (--tune kp=8@600ms)"
$TQ run examples/09_live.tq --tune "kp=8@600ms" 2>&1 | grep -E "\[tune\]|\[osc\]" | sed -n '1,4p;9,14p' | tee -a "$OUT"

say "9. Memory-safety lint rejects allocation inside armed loops"
$TQ check examples/11_alloc_lint.tq 2>&1 | tee -a "$OUT"
echo "   -> exit code: ${PIPESTATUS[0]}" | tee -a "$OUT"

say "Demo complete. Full transcript in $OUT"
