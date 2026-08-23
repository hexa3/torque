// Torque servo firmware reference — Arduino + PCA9685 (16ch, I2C 0x40).
// Implements the wire protocol Torque's SerialBackend speaks:
//
//   receives:  "T <channel> <pulse_us>\n"   -> set servo pulse
//   sends:     "A <channel> <angle_cdeg>\n" -> feedback (here: commanded
//               position slewed toward target, standing in for encoders)
//
// Wiring: PCA9685 VCC->5V, GND->GND, SDA->A4, SCL->A5 (Uno), servos on
// channels 0..2. Upload, then:
//   torque run examples/07_arm_sim.tq --backend serial --port /dev/ttyACM0

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

const uint8_t N_JOINTS = 3;
const int PULSE_MIN = 500;    // us at -90 deg
const int PULSE_MAX = 2500;   // us at +90 deg

float curDeg[N_JOINTS]  = {0, 0, 0};
float tgtDeg[N_JOINTS]  = {0, 0, 0};

unsigned long lastStepMs = 0;
unsigned long lastReportMs = 0;
String rxBuf = "";

void setup() {
  Serial.begin(115200);
  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(50);          // standard servo update rate
  Wire.setClock(400000);
}

int angleToPulse(float deg) {
  float f = constrain(deg, -90.0, 90.0) / 90.0;   // -1..1
  return PULSE_MIN + (int)((f + 1.0) * 0.5 * (PULSE_MAX - PULSE_MIN));
}

void applyAll() {
  for (uint8_t ch = 0; ch < N_JOINTS; ch++) {
    pwm.writeMicroseconds(ch, angleToPulse(curDeg[ch]));
  }
}

void loop() {
  unsigned long now = millis();

  // Parse one line per loop iteration at most.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      int sp1 = rxBuf.indexOf(' ');
      int sp2 = rxBuf.indexOf(' ', sp1 + 1);
      if (rxBuf.startsWith("T ") && sp2 > 0) {
        int ch = rxBuf.substring(2, sp1).toInt();
        int us = rxBuf.substring(sp2 + 1).toInt();
        if (ch >= 0 && ch < N_JOINTS) {
          tgtDeg[ch] = ((us - PULSE_MIN) * 180.0 / (PULSE_MAX - PULSE_MIN)) - 90.0;
        }
      }
      rxBuf = "";
    } else {
      rxBuf += c;
    }
  }

  // Slew toward targets (~160 deg/s), then push pulses.
  if (now - lastStepMs >= 20) {
    float dt = (now - lastStepMs) / 1000.0;
    lastStepMs = now;
    for (uint8_t ch = 0; ch < N_JOINTS; ch++) {
      float d = tgtDeg[ch] - curDeg[ch];
      float step = constrain(d, -160.0 * dt, 160.0 * dt);
      curDeg[ch] += step;
    }
    applyAll();
  }

  // Stream feedback at ~20 Hz.
  if (now - lastReportMs >= 50) {
    lastReportMs = now;
    for (uint8_t ch = 0; ch < N_JOINTS; ch++) {
      Serial.print("A "); Serial.print(ch); Serial.print(' ');
      Serial.println((int)(curDeg[ch] * 100));   // centi-degrees
    }
  }
}
