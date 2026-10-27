#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <stddef.h>
#include <new>

#define RS485_DE_RE 4
#define RS485_RX 16
#define RS485_TX 17
#define LED_PIN 18

#ifndef LED_MODULE_COUNT
#define LED_MODULE_COUNT 4
#endif

#ifndef CONTROLLER_NAME
#define CONTROLLER_NAME "ESP32-01"
#endif

#ifndef CONTROLLER_ADDRESS
#define CONTROLLER_ADDRESS CONTROLLER_NAME
#endif

#define MAX_CONTROLLER_MODULES 64
#define MODULES runtimeConfig.logicalCount
#define FIRMWARE_PROTOCOL "simple-matrix-v15-rs485-addressed"
#define W 8
#define H 8
#define LEDS_PER_MODULE 64
#define LED_COUNT (runtimeConfig.physicalCount * LEDS_PER_MODULE)
#define DEFAULT_BRIGHTNESS_PERCENT 100
#define DEFAULT_TASK_BRIGHTNESS_PERCENT 100
#define DEFAULT_TEST_BRIGHTNESS_PERCENT 100
#define DEFAULT_TEST_DURATION_MS 5000
#define DEFAULT_LOCATE_DURATION_MS 300000
#define RIPPLE_STEP_MS 150
#define RIPPLE_STEP_COUNT 5
#define IDLE_HEARTBEAT_STEP_MS 5000
#define IDLE_HEARTBEAT_PULSE_MS 500
#define DEFAULT_SCROLL_MS 120
#define DEFAULT_LAYOUT 3
#define CHAR_ADVANCE_STATIC 6
#define CHAR_ADVANCE_SCROLL 7

#define MODE_OFF 0
#define MODE_IDLE 1
#define MODE_STATIC 2
#define MODE_SCROLL 3

struct ControllerConfig {
  uint32_t magic;
  uint32_t revision;
  uint32_t owner;
  uint32_t requestCrc;
  uint8_t physicalCount;
  uint8_t logicalCount;
  uint8_t routing[MAX_CONTROLLER_MODULES]; // Stable logical output -> 1-based physical position; 0 disables it.
  char request[17];
  uint8_t reserved;
  uint32_t crc;
};

ControllerConfig defaultControllerConfig() {
  ControllerConfig config = {};
  config.magic = 0x4c594301;
  config.physicalCount = LED_MODULE_COUNT;
  config.logicalCount = LED_MODULE_COUNT;
  for (int i = 0; i < LED_MODULE_COUNT && i < MAX_CONTROLLER_MODULES; i++) config.routing[i] = i + 1;
  return config;
}
static_assert(LED_MODULE_COUNT >= 0 && LED_MODULE_COUNT <= MAX_CONTROLLER_MODULES, "Invalid initial module count");
ControllerConfig runtimeConfig = defaultControllerConfig();
bool configurationFault = false;
Preferences controllerPreferences;
bool preferencesReady = false;
bool usbMaintenance = false;
char usbLine[320];
int usbLinePos = 0;
bool usbLineOverflow = false;

bool mappedModule(int module) {
  return module >= 0 && module < MODULES && runtimeConfig.routing[module] > 0;
}
int modulePixelBase(int module) {
  return mappedModule(module) ? (runtimeConfig.routing[module] - 1) * LEDS_PER_MODULE : -LEDS_PER_MODULE;
}

HardwareSerial RS485(2);
Adafruit_NeoPixel *pixelDriver = new Adafruit_NeoPixel(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
#define pixels (*pixelDriver)

struct ModuleState {
  int mode;
  char text[56];
  uint32_t color;
  int brightness;
  int scrollOffset;
  int scrollSpeedMs;
  bool scrollOnce;
  unsigned long lastStepAt;
  unsigned long testUntil;
  unsigned long testStartedAt;
  uint32_t testColor;
  int testBrightness;
  int lastTestStep;
  unsigned long locateUntil;
  unsigned long locateStartedAt;
  uint32_t locateColor;
  int lastLocateStep;
};

ModuleState modules[MAX_CONTROLLER_MODULES];

char line[9216];
int linePos = 0;
bool lineOverflow = false;
int layoutMode = DEFAULT_LAYOUT;
int heartbeatColumn = 0;
bool heartbeatPulseOn = true;
unsigned long lastHeartbeatAt = 0;
unsigned long heartbeatPulseStartedAt = 0;

void setGlyph(byte out[7], byte a, byte b, byte c, byte d, byte e, byte f, byte g) {
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = e;
  out[5] = f;
  out[6] = g;
}

char upperChar(char c) {
  if (c >= 'a' && c <= 'z') {
    return c - 32;
  }
  return c;
}

void glyphFor(char ch, byte out[7]) {
  ch = upperChar(ch);

  switch (ch) {
    case ' ': setGlyph(out, 0,0,0,0,0,0,0); break;
    case '!': setGlyph(out, 4,4,4,4,4,0,4); break;
    case '"': setGlyph(out, 10,10,10,0,0,0,0); break;
    case '#': setGlyph(out, 10,31,10,10,31,10,0); break;
    case '$': setGlyph(out, 4,15,20,14,5,30,4); break;
    case '%': setGlyph(out, 24,25,2,4,8,19,3); break;
    case '&': setGlyph(out, 12,18,20,8,21,18,13); break;
    case '\'': setGlyph(out, 4,4,8,0,0,0,0); break;
    case '(': setGlyph(out, 2,4,8,8,8,4,2); break;
    case ')': setGlyph(out, 8,4,2,2,2,4,8); break;
    case '*': setGlyph(out, 0,4,21,14,21,4,0); break;
    case '+': setGlyph(out, 0,4,4,31,4,4,0); break;
    case ',': setGlyph(out, 0,0,0,0,4,4,8); break;
    case '-': setGlyph(out, 0,0,0,31,0,0,0); break;
    case '.': setGlyph(out, 0,0,0,0,0,12,12); break;
    case '/': setGlyph(out, 1,2,2,4,8,8,16); break;
    case '0': setGlyph(out, 14,17,17,17,17,17,14); break;
    case '1': setGlyph(out, 4,12,4,4,4,4,14); break;
    case '2': setGlyph(out, 14,17,1,2,4,8,31); break;
    case '3': setGlyph(out, 30,1,1,14,1,1,30); break;
    case '4': setGlyph(out, 2,6,10,18,31,2,2); break;
    case '5': setGlyph(out, 31,16,16,30,1,1,30); break;
    case '6': setGlyph(out, 6,8,16,30,17,17,14); break;
    case '7': setGlyph(out, 31,1,2,4,8,8,8); break;
    case '8': setGlyph(out, 14,17,17,14,17,17,14); break;
    case '9': setGlyph(out, 14,17,17,15,1,2,12); break;
    case ':': setGlyph(out, 0,12,12,0,12,12,0); break;
    case ';': setGlyph(out, 0,12,12,0,12,4,8); break;
    case '<': setGlyph(out, 2,4,8,16,8,4,2); break;
    case '=': setGlyph(out, 0,0,31,0,31,0,0); break;
    case '>': setGlyph(out, 8,4,2,1,2,4,8); break;
    case '?': setGlyph(out, 14,17,1,2,4,0,4); break;
    case '@': setGlyph(out, 14,17,1,13,21,21,14); break;
    case 'A': setGlyph(out, 14,17,17,31,17,17,17); break;
    case 'B': setGlyph(out, 30,17,17,30,17,17,30); break;
    case 'C': setGlyph(out, 14,17,16,16,16,17,14); break;
    case 'D': setGlyph(out, 30,17,17,17,17,17,30); break;
    case 'E': setGlyph(out, 31,16,16,30,16,16,31); break;
    case 'F': setGlyph(out, 31,16,16,30,16,16,16); break;
    case 'G': setGlyph(out, 14,17,16,23,17,17,15); break;
    case 'H': setGlyph(out, 17,17,17,31,17,17,17); break;
    case 'I': setGlyph(out, 14,4,4,4,4,4,14); break;
    case 'J': setGlyph(out, 7,2,2,2,18,18,12); break;
    case 'K': setGlyph(out, 17,18,20,24,20,18,17); break;
    case 'L': setGlyph(out, 16,16,16,16,16,16,31); break;
    case 'M': setGlyph(out, 17,27,21,21,17,17,17); break;
    case 'N': setGlyph(out, 17,25,21,19,17,17,17); break;
    case 'O': setGlyph(out, 14,17,17,17,17,17,14); break;
    case 'P': setGlyph(out, 30,17,17,30,16,16,16); break;
    case 'Q': setGlyph(out, 14,17,17,17,21,18,13); break;
    case 'R': setGlyph(out, 30,17,17,30,20,18,17); break;
    case 'S': setGlyph(out, 15,16,16,14,1,1,30); break;
    case 'T': setGlyph(out, 31,4,4,4,4,4,4); break;
    case 'U': setGlyph(out, 17,17,17,17,17,17,14); break;
    case 'V': setGlyph(out, 17,17,17,17,17,10,4); break;
    case 'W': setGlyph(out, 17,17,17,21,21,21,10); break;
    case 'X': setGlyph(out, 17,17,10,4,10,17,17); break;
    case 'Y': setGlyph(out, 17,17,10,4,4,4,4); break;
    case 'Z': setGlyph(out, 31,1,2,4,8,16,31); break;
    case '[': setGlyph(out, 14,8,8,8,8,8,14); break;
    case '\\': setGlyph(out, 16,8,8,4,2,2,1); break;
    case ']': setGlyph(out, 14,2,2,2,2,2,14); break;
    case '^': setGlyph(out, 4,10,17,0,0,0,0); break;
    case '_': setGlyph(out, 0,0,0,0,0,0,0); break;
    case '`': setGlyph(out, 8,4,2,0,0,0,0); break;
    case '{': setGlyph(out, 2,4,4,8,4,4,2); break;
    case '|': setGlyph(out, 4,4,4,4,4,4,4); break;
    case '}': setGlyph(out, 8,4,4,2,4,4,8); break;
    case '~': setGlyph(out, 0,0,8,21,2,0,0); break;
    default: setGlyph(out, 14,17,1,2,4,0,4); break;
  }
}

int mappedLocalIndex(int x, int y) {
  int mode = layoutMode;
  if (mode < 0) {
    mode = 0;
  }
  mode = mode % 16;

  int major = mode / 8;
  int rest = mode % 8;
  int serpentine = rest / 4;
  int flips = rest % 4;
  int flipX = flips / 2;
  int flipY = flips % 2;

  if (flipX == 1) {
    x = W - 1 - x;
  }
  if (flipY == 1) {
    y = H - 1 - y;
  }

  if (major == 0) {
    if (serpentine == 1) {
      if (y % 2 == 1) {
        x = W - 1 - x;
      }
    }
    return y * W + x;
  }

  if (serpentine == 1) {
    if (x % 2 == 1) {
      y = H - 1 - y;
    }
  }
  return x * H + y;
}

int pixelIndex(int module, int x, int y) {
  return modulePixelBase(module) + mappedLocalIndex(x, y);
}

void send485(const char *msg) {
  if (usbMaintenance) { Serial.print(msg); Serial.flush(); return; }
  digitalWrite(RS485_DE_RE, HIGH);
  delayMicroseconds(100);
  RS485.print(msg);
  RS485.flush();
  delayMicroseconds(100);
  digitalWrite(RS485_DE_RE, LOW);
}

int clampBrightness(int value) {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

uint32_t scaleColor(uint32_t color, int brightnessPercent) {
  int brightness = clampBrightness(brightnessPercent);
  uint8_t r = (color >> 16) & 0xff;
  uint8_t g = (color >> 8) & 0xff;
  uint8_t b = color & 0xff;
  r = (uint8_t)((int)r * brightness / 100);
  g = (uint8_t)((int)g * brightness / 100);
  b = (uint8_t)((int)b * brightness / 100);
  return pixels.Color(r, g, b);
}

void ack(const char *command, int module) {
  char msg[80];
  snprintf(msg, sizeof(msg), "{\"type\":\"ack\",\"command\":\"%s\",\"module\":%d}\n", command, module + 1);
  send485(msg);
}

int hexNibble(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

uint32_t colorFor(const char *c) {
  if (strcmp(c, "red") == 0) {
    return pixels.Color(255, 0, 0);
  }
  if (strcmp(c, "green") == 0) {
    return pixels.Color(0, 255, 0);
  }
  if (strcmp(c, "blue") == 0) {
    return pixels.Color(0, 0, 255);
  }
  if (strcmp(c, "cyan") == 0) {
    return pixels.Color(0, 255, 255);
  }
  if (strcmp(c, "magenta") == 0 || strcmp(c, "pink") == 0) {
    return pixels.Color(255, 0, 255);
  }
  if (strcmp(c, "purple") == 0) {
    return pixels.Color(120, 0, 255);
  }
  if (strcmp(c, "amber") == 0) {
    return pixels.Color(255, 120, 0);
  }
  if (strcmp(c, "yellow") == 0) {
    return pixels.Color(255, 180, 0);
  }
  if (strcmp(c, "orange") == 0) {
    return pixels.Color(255, 80, 0);
  }
  if (strcmp(c, "white") == 0) {
    return pixels.Color(255, 255, 255);
  }

  int start = 0;
  if (c[0] == '#') {
    start = 1;
  }

  int len = strlen(c + start);
  if (len == 6) {
    int r1 = hexNibble(c[start]);
    int r2 = hexNibble(c[start + 1]);
    int g1 = hexNibble(c[start + 2]);
    int g2 = hexNibble(c[start + 3]);
    int b1 = hexNibble(c[start + 4]);
    int b2 = hexNibble(c[start + 5]);
    if (r1 >= 0) {
      if (r2 >= 0) {
        if (g1 >= 0) {
          if (g2 >= 0) {
            if (b1 >= 0) {
              if (b2 >= 0) {
                return pixels.Color(r1 * 16 + r2, g1 * 16 + g2, b1 * 16 + b2);
              }
            }
          }
        }
      }
    }
  }

  return pixels.Color(255, 0, 0);
}

void clearModulePixels(int module) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }
  for (int i = 0; i < LEDS_PER_MODULE; i++) {
    pixels.setPixelColor(modulePixelBase(module) + i, 0);
  }
}

void drawGlyph(int module, char ch, int ox, int oy, uint32_t color, bool bold) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  byte glyph[7];
  glyphFor(ch, glyph);

  for (int y = 0; y < 7; y++) {
    byte row = glyph[y];
    for (int x = 0; x < 5; x++) {
      int mask = 1 << (4 - x);
      if ((row & mask) == 0) {
        continue;
      }

      int tx = ox + x;
      int ty = oy + y;

      if (tx < 0) {
        continue;
      }
      if (tx >= W) {
        continue;
      }
      if (ty < 0) {
        continue;
      }
      if (ty >= H) {
        continue;
      }

      pixels.setPixelColor(pixelIndex(module, tx, ty), color);

      if (bold) {
        int boldX = tx + 1;
        if (boldX < W) {
          pixels.setPixelColor(pixelIndex(module, boldX, ty), color);
        } else {
          int leftX = tx - 1;
          if (leftX >= 0) {
            pixels.setPixelColor(pixelIndex(module, leftX, ty), color);
          }
        }
      }
    }
  }
}

int textPixelWidth(const char *text) {
  int length = strlen(text);
  if (length <= 0) {
    return 0;
  }
  return (length * CHAR_ADVANCE_STATIC) - 1;
}

void renderStaticModule(int module) {
  clearModulePixels(module);

  if (strlen(modules[module].text) == 1) {
    drawGlyph(module, modules[module].text[0], 1, 0, modules[module].color, true);
  } else {
    int x = 0;
    for (int i = 0; modules[module].text[i] != 0; i++) {
      drawGlyph(module, modules[module].text[i], x, 0, modules[module].color, true);
      x += CHAR_ADVANCE_STATIC;
    }
  }
}

void renderScrollModule(int module) {
  clearModulePixels(module);

  int x = modules[module].scrollOffset;
  for (int i = 0; modules[module].text[i] != 0; i++) {
    drawGlyph(module, modules[module].text[i], x, 0, modules[module].color, false);
    x += CHAR_ADVANCE_SCROLL;
  }
}

void renderIdleModule(int module) {
  clearModulePixels(module);
  if (heartbeatPulseOn) {
    pixels.setPixelColor(pixelIndex(module, heartbeatColumn, H - 1), pixels.Color(255, 0, 0));
  }
}

int rippleRingFor(int x, int y) {
  int dx = 0;
  int dy = 0;

  if (x < 3) {
    dx = 3 - x;
  } else if (x > 4) {
    dx = x - 4;
  }

  if (y < 3) {
    dy = 3 - y;
  } else if (y > 4) {
    dy = y - 4;
  }

  return dx > dy ? dx : dy;
}

void renderRippleModule(int module, int step, bool reverse) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  clearModulePixels(module);
  int phase = step % RIPPLE_STEP_COUNT;
  int leadingRing = reverse ? 3 - phase : phase;
  int trailingRing = reverse ? leadingRing + 1 : leadingRing - 1;

  if (trailingRing < 0) {
    trailingRing = leadingRing;
  }
  if (trailingRing > 3) {
    trailingRing = leadingRing;
  }

  int minRing = leadingRing < trailingRing ? leadingRing : trailingRing;
  int maxRing = leadingRing > trailingRing ? leadingRing : trailingRing;
  uint32_t color = reverse ? modules[module].locateColor : modules[module].testColor;

  if (minRing < 0) {
    minRing = 0;
  }
  if (maxRing > 3) {
    maxRing = 3;
  }

  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      int pixelRing = rippleRingFor(x, y);
      if (pixelRing >= minRing && pixelRing <= maxRing) {
        pixels.setPixelColor(pixelIndex(module, x, y), color);
      }
    }
  }
}

void renderModule(int module) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  if (modules[module].mode == MODE_OFF) {
    clearModulePixels(module);
    return;
  }

  if (modules[module].mode == MODE_IDLE) {
    renderIdleModule(module);
    return;
  }

  if (modules[module].mode == MODE_STATIC) {
    renderStaticModule(module);
    return;
  }

  if (modules[module].mode == MODE_SCROLL) {
    renderScrollModule(module);
  }
}

void showOrScroll(int module, const char *text, uint32_t color, int speedMs, int brightness, bool forceScroll, bool scrollOnce, bool showNow = true) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  strncpy(modules[module].text, text, sizeof(modules[module].text) - 1);
  modules[module].text[sizeof(modules[module].text) - 1] = 0;
  modules[module].color = scaleColor(color, brightness);
  modules[module].brightness = clampBrightness(brightness);
  modules[module].scrollSpeedMs = speedMs;
  modules[module].scrollOnce = scrollOnce;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;
  if (modules[module].scrollSpeedMs <= 0) {
    modules[module].scrollSpeedMs = DEFAULT_SCROLL_MS;
  }
  modules[module].lastStepAt = scrollOnce ? millis() : 0;

  if (forceScroll) {
    modules[module].mode = MODE_SCROLL;
  } else {
    if (textPixelWidth(text) <= W) {
      modules[module].mode = MODE_STATIC;
    } else {
      modules[module].mode = MODE_SCROLL;
    }
  }

  modules[module].scrollOffset = W;
  renderModule(module);
  if (showNow) pixels.show();
}

void showTaskModule(int module, const char *text, uint32_t color, int brightness, bool showNow = true) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  strncpy(modules[module].text, text, sizeof(modules[module].text) - 1);
  modules[module].text[sizeof(modules[module].text) - 1] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].color = scaleColor(color, modules[module].brightness);
  modules[module].scrollSpeedMs = DEFAULT_SCROLL_MS;
  modules[module].scrollOnce = false;
  modules[module].lastStepAt = 0;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;

  if (textPixelWidth(text) <= W) {
    modules[module].mode = MODE_STATIC;
    modules[module].scrollOffset = W;
  } else {
    modules[module].mode = MODE_SCROLL;
    modules[module].scrollOffset = 0;
  }

  renderModule(module);
  if (showNow) pixels.show();
}

void setModuleIdle(int module) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }
  modules[module].mode = MODE_IDLE;
  modules[module].brightness = DEFAULT_BRIGHTNESS_PERCENT;
  modules[module].text[0] = 0;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;
  renderModule(module);
}

void setModuleOff(int module) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }
  modules[module].mode = MODE_OFF;
  modules[module].brightness = 0;
  modules[module].text[0] = 0;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;
  renderModule(module);
}

bool parseModuleNumber(const char *s, int *moduleIndex) {
  if (s == NULL) {
    return false;
  }

  int value = 0;
  for (int i = 0; s[i] != 0; i++) {
    if (s[i] < '0' || s[i] > '9') {
      return false;
    }
    value = (value * 10) + (s[i] - '0');
  }

  if (value < 1 || value > MODULES || !mappedModule(value - 1)) {
    return false;
  }

  *moduleIndex = value - 1;
  return true;
}

void lowerToken(char *s) {
  for (int i = 0; s[i] != 0; i++) {
    if (s[i] >= 'A' && s[i] <= 'Z') {
      s[i] = s[i] + 32;
    }
  }
}

bool equalsIgnoreCase(const char *a, const char *b) {
  int i = 0;
  while (a[i] != 0 && b[i] != 0) {
    char ca = a[i];
    char cb = b[i];
    if (ca >= 'A' && ca <= 'Z') {
      ca = ca + 32;
    }
    if (cb >= 'A' && cb <= 'Z') {
      cb = cb + 32;
    }
    if (ca != cb) {
      return false;
    }
    i++;
  }
  return a[i] == 0 && b[i] == 0;
}

bool isControllerTarget(const char *target) {
  return strcmp(target, "*") == 0 ||
    equalsIgnoreCase(target, "all") ||
    equalsIgnoreCase(target, "broadcast") ||
    equalsIgnoreCase(target, CONTROLLER_ADDRESS);
}

int splitLine(char *src, char *tokens[], int maxTokens) {
  int count = 0;
  char *cursor = src;

  while (*cursor != 0) {
    while (*cursor == ' ') {
      cursor++;
    }

    if (*cursor == 0) {
      break;
    }

    if (count >= maxTokens) {
      break;
    }

    if (*cursor == '"') {
      cursor++;
      tokens[count] = cursor;
      count++;

      while (*cursor != 0 && *cursor != '"') {
        cursor++;
      }

      if (*cursor == '"') {
        *cursor = 0;
        cursor++;
      }
    } else {
      tokens[count] = cursor;
      count++;

      while (*cursor != 0 && *cursor != ' ') {
        cursor++;
      }

      if (*cursor == ' ') {
        *cursor = 0;
        cursor++;
      }
    }
  }

  return count;
}

void setSinglePixel(int module, int row, int column, uint32_t color) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].color = color;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;
  clearModulePixels(module);

  int y = row - 1;
  int x = column - 1;
  if (x >= 0) {
    if (x < W) {
      if (y >= 0) {
        if (y < H) {
          pixels.setPixelColor(pixelIndex(module, x, y), scaleColor(color, modules[module].brightness));
        }
      }
    }
  }

  pixels.show();
}

void fillModule(int module, uint32_t color, int brightness) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }

  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;
  uint32_t scaled = scaleColor(color, modules[module].brightness);
  for (int i = 0; i < LEDS_PER_MODULE; i++) {
    pixels.setPixelColor(modulePixelBase(module) + i, scaled);
  }
  pixels.show();
}

void blinkModule(int module, uint32_t color, int brightness, unsigned long durationMs, bool showNow = true, unsigned long startedAt = 0) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }
  if (durationMs == 0) {
    durationMs = DEFAULT_TEST_DURATION_MS;
  }
  unsigned long now = showNow ? millis() : startedAt;
  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].testColor = scaleColor(color, modules[module].brightness);
  modules[module].testBrightness = modules[module].brightness;
  modules[module].testStartedAt = now;
  modules[module].testUntil = now + durationMs;
  modules[module].lastTestStep = -1;
  modules[module].locateUntil = 0;
  modules[module].lastLocateStep = -1;
  renderRippleModule(module, 0, false);
  if (showNow) pixels.show();
}

void locateModule(int module, uint32_t color, int brightness, unsigned long durationMs, bool showNow = true, unsigned long startedAt = 0) {
  if (module < 0) {
    return;
  }
  if (!mappedModule(module)) {
    return;
  }
  if (durationMs == 0) {
    durationMs = DEFAULT_LOCATE_DURATION_MS;
  }
  unsigned long now = showNow ? millis() : startedAt;
  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].locateColor = scaleColor(color, modules[module].brightness);
  modules[module].locateStartedAt = now;
  modules[module].locateUntil = now + durationMs;
  modules[module].lastLocateStep = -1;
  modules[module].testUntil = 0;
  modules[module].lastTestStep = -1;
  renderRippleModule(module, 0, true);
  if (showNow) pixels.show();
}

void updateModuleTests() {
  unsigned long now = millis();
  bool changed = false;

  for (int module = 0; module < MODULES; module++) {
    if (modules[module].testUntil == 0) {
      continue;
    }
    if ((long)(now - modules[module].testUntil) < 0) {
      int step = (int)((now - modules[module].testStartedAt) / RIPPLE_STEP_MS) % RIPPLE_STEP_COUNT;
      if (step != modules[module].lastTestStep) {
        modules[module].lastTestStep = step;
        renderRippleModule(module, step, false);
        changed = true;
      }
      continue;
    }
    modules[module].testUntil = 0;
    modules[module].lastTestStep = -1;
    setModuleIdle(module);
    changed = true;
  }

  if (changed) {
    pixels.show();
  }
}

void updateLocateTimeouts() {
  unsigned long now = millis();
  bool changed = false;

  for (int module = 0; module < MODULES; module++) {
    if (modules[module].locateUntil == 0) {
      continue;
    }
    if ((long)(now - modules[module].locateUntil) < 0) {
      int step = (int)((now - modules[module].locateStartedAt) / RIPPLE_STEP_MS) % RIPPLE_STEP_COUNT;
      if (step != modules[module].lastLocateStep) {
        modules[module].lastLocateStep = step;
        renderRippleModule(module, step, true);
        changed = true;
      }
      continue;
    }
    modules[module].locateUntil = 0;
    modules[module].lastLocateStep = -1;
    setModuleIdle(module);
    changed = true;
  }

  if (changed) {
    pixels.show();
  }
}

void updateScrolls() {
  unsigned long now = millis();
  bool changed = false;

  for (int module = 0; module < MODULES; module++) {
    if (modules[module].mode != MODE_SCROLL) {
      continue;
    }

    if (now - modules[module].lastStepAt < (unsigned long)modules[module].scrollSpeedMs) {
      continue;
    }

    modules[module].lastStepAt = now;
    modules[module].scrollOffset--;

    int width = strlen(modules[module].text) * CHAR_ADVANCE_SCROLL;
    if (modules[module].scrollOffset < -width) {
      if (modules[module].scrollOnce) {
        modules[module].mode = MODE_OFF;
        clearModulePixels(module);
        changed = true;
        continue;
      }
      modules[module].scrollOffset = W;
    }

    renderModule(module);
    changed = true;
  }

  if (changed) {
    pixels.show();
  }
}

void updateHeartbeat() {
  unsigned long now = millis();
  bool changed = false;

  if (heartbeatPulseOn && now - heartbeatPulseStartedAt >= IDLE_HEARTBEAT_PULSE_MS) {
    heartbeatPulseOn = false;
    for (int module = 0; module < MODULES; module++) {
      if (modules[module].mode == MODE_IDLE) {
        renderModule(module);
        changed = true;
      }
    }
  }

  if (now - lastHeartbeatAt >= IDLE_HEARTBEAT_STEP_MS) {
    lastHeartbeatAt = now;
    heartbeatPulseStartedAt = now;
    heartbeatPulseOn = true;
    heartbeatColumn = (heartbeatColumn + 1) % W;

    for (int module = 0; module < MODULES; module++) {
      if (modules[module].mode == MODE_IDLE) {
        renderModule(module);
        changed = true;
      }
    }
  }

  if (changed) {
    pixels.show();
  }
}

void syncHeartbeat(int column) {
  unsigned long now = millis();
  if (column < 0) {
    column = 0;
  }
  heartbeatColumn = column % W;
  lastHeartbeatAt = now;
  heartbeatPulseStartedAt = now;
  heartbeatPulseOn = true;

  for (int module = 0; module < MODULES; module++) {
    if (modules[module].mode == MODE_IDLE) {
      renderModule(module);
    }
  }
  pixels.show();
}

int groupHex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

uint32_t groupCrc(const char *text) {
  uint32_t crc = 0xffffffff;
  while (*text) {
    crc ^= (uint8_t)*text++;
    for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}

bool groupUnsigned(const char *text, unsigned long minValue, unsigned long maxValue, unsigned long *value) {
  if (!*text) return false;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return false;
  char *end;
  *value = strtoul(text, &end, 10);
  return !*end && *value >= minValue && *value <= maxValue && strlen(text) <= 6;
}

// Remember recent requests so delivery retries cannot restart or resurrect an animation.
char groupRequests[8][17] = {};
uint32_t groupChecksums[8] = {};
int groupRequestSlot = 0;

void blinkGroup(char **tokens, int count) {
  bool valid = count == 7;
  unsigned long brightness = 0, duration = 0;
  if (valid) valid = strlen(tokens[1]) == 16 && strlen(tokens[2]) == 64 && strlen(tokens[6]) == 8 &&
    strcmp(tokens[3], "green") == 0 && groupUnsigned(tokens[4], 0, 100, &brightness) &&
    groupUnsigned(tokens[5], 1, 300000, &duration);
  if (valid) {
    for (const char *p = tokens[1]; *p; p++) if (groupHex(*p) < 0) valid = false;
    for (const char *p = tokens[2]; *p; p++) if (groupHex(*p) < 0) valid = false;
    for (const char *p = tokens[6]; *p; p++) if (groupHex(*p) < 0) valid = false;
  }
  bool any = false;
  if (valid) {
    for (int i = 0; i < 256; i++) {
      if (groupHex(tokens[2][i / 4]) & (1 << (i % 4))) {
        any = true;
        if (i >= MAX_CONTROLLER_MODULES || !mappedModule(i)) valid = false;
      }
    }
  }
  char payload[256];
  uint32_t checksum = 0;
  if (valid && any) {
    char address[96];
    strncpy(address, CONTROLLER_ADDRESS, sizeof(address) - 1);
    address[sizeof(address) - 1] = 0;
    for (char *p = address; *p; p++) *p = toupper(*p);
    snprintf(payload, sizeof(payload), "%s %s %s %s %s %s", address, tokens[1], tokens[2], tokens[3], tokens[4], tokens[5]);
    checksum = groupCrc(payload);
    valid = checksum == (uint32_t)strtoul(tokens[6], NULL, 16);
  } else valid = false;
  bool duplicate = false;
  if (valid) for (int i = 0; i < 8; i++) {
    if (strcmp(groupRequests[i], tokens[1]) == 0) {
      duplicate = true;
      if (groupChecksums[i] != checksum) valid = false;
    }
  }
  if (!valid) {
    send485("{\"type\":\"error\",\"message\":\"invalid-blink-group\"}\n");
    return;
  }
  if (!duplicate) {
    unsigned long startedAt = millis();
    for (int module = 0; module < MODULES && module < 255; module++) {
      if (groupHex(tokens[2][module / 4]) & (1 << (module % 4)))
        blinkModule(module, colorFor("green"), brightness, duration, false, startedAt);
    }
    pixels.show();
    strcpy(groupRequests[groupRequestSlot], tokens[1]);
    groupChecksums[groupRequestSlot] = checksum;
    groupRequestSlot = (groupRequestSlot + 1) % 8;
  }
  char reply[240];
  snprintf(reply, sizeof(reply), "{\"type\":\"ack\",\"command\":\"blink-group\",\"request\":\"%s\",\"address\":\"%s\"}\n", tokens[1], CONTROLLER_ADDRESS);
  send485(reply);
}

// Versioned, checksummed display frames: validate every output, then latch the chain once.
// 1-byte count, then per-output: channel, mode, brightness, RGB, speed u16,
// duration u32, flags, text length, printable ASCII text (all integers big-endian).
struct DisplayEntry {
  uint8_t channel, mode, brightness, flags;
  uint32_t color, duration;
  uint16_t speed;
  char text[56];
};
DisplayEntry frameEntries[MAX_CONTROLLER_MODULES];
char frameRequests[8][17] = {};
uint32_t frameChecksums[8] = {};
int frameRequestSlot = 0;

uint32_t displayFrameCrc(const char *request, const char *data) {
  char address[96];
  strncpy(address, CONTROLLER_ADDRESS, sizeof(address)-1); address[sizeof(address)-1]=0;
  for(char *p=address;*p;p++)*p=toupper(*p);
  const char *parts[]={address," display-frame ",request," ",data};
  uint32_t crc=0xffffffff;
  for(const char *part:parts)while(*part){crc^=(uint8_t)*part++;for(int bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1)?0xedb88320:0);}
  return crc^0xffffffff;
}
bool frameReadByte(const char *data, size_t length, size_t *pos, uint8_t *value) {
  if(*pos+2>length)return false;
  int high=groupHex(data[*pos]),low=groupHex(data[*pos+1]);
  if(high<0||low<0)return false;
  *value=(high<<4)|low;*pos+=2;return true;
}
void handleDisplayFrame(char *input) {
  if(usbMaintenance)return;
  char *tokens[7];int count=splitLine(input,tokens,7);
  if(count<2||!equalsIgnoreCase(tokens[1],CONTROLLER_ADDRESS))return;
  bool valid=count==6&&strcmp(tokens[0],"to")==0&&strcmp(tokens[2],"display-frame")==0&&
    strlen(tokens[3])==16&&strlen(tokens[5])==8&&!configurationFault;
  if(valid)for(const char *p=tokens[3];*p;p++)if(groupHex(*p)<0)valid=false;
  if(valid)for(const char *p=tokens[5];*p;p++)if(groupHex(*p)<0)valid=false;
  uint32_t checksum=valid?displayFrameCrc(tokens[3],tokens[4]):0;
  if(valid)valid=checksum==(uint32_t)strtoul(tokens[5],NULL,16);
  size_t pos=0,length=valid?strlen(tokens[4]):0;
  uint8_t entries=0;
  if(valid)valid=length<=8834&&frameReadByte(tokens[4],length,&pos,&entries)&&entries>0&&entries<=MAX_CONTROLLER_MODULES;
  bool seen[MAX_CONTROLLER_MODULES]={};
  for(int i=0;valid&&i<entries;i++){
    uint8_t fields[14];
    for(int n=0;n<14;n++)if(!frameReadByte(tokens[4],length,&pos,&fields[n]))valid=false;
    if(!valid)break;
    DisplayEntry &entry=frameEntries[i];
    entry.channel=fields[0];entry.mode=fields[1];entry.brightness=fields[2];
    entry.color=pixels.Color(fields[3],fields[4],fields[5]);entry.speed=(fields[6]<<8)|fields[7];
    entry.duration=((uint32_t)fields[8]<<24)|((uint32_t)fields[9]<<16)|(fields[10]<<8)|fields[11];entry.flags=fields[12];
    int textLength=fields[13];
    valid=entry.channel>=1&&entry.channel<=MAX_CONTROLLER_MODULES&&mappedModule(entry.channel-1)&&!seen[entry.channel-1]&&
      entry.mode>=1&&entry.mode<=5&&entry.brightness<=100&&entry.speed>=20&&entry.speed<=1000&&entry.flags<=1&&(entry.flags==0||entry.mode==1)&&textLength<=55&&
      ((entry.mode<=2&&entry.duration==0)||(entry.mode==3&&textLength==0&&entry.duration==0)||(entry.mode>=4&&textLength==0&&entry.duration>0&&entry.duration<=300000));
    if(!valid)break;
    seen[entry.channel-1]=true;
    for(int n=0;n<textLength;n++){uint8_t ch;if(!frameReadByte(tokens[4],length,&pos,&ch)||ch<32||ch>126){valid=false;break;}entry.text[n]=ch;}
    entry.text[textLength]=0;
  }
  valid=valid&&pos==length;
  bool duplicate=false;
  if(valid)for(int i=0;i<8;i++)if(strcmp(frameRequests[i],tokens[3])==0){duplicate=true;if(frameChecksums[i]!=checksum)valid=false;}
  if(!valid){send485("{\"type\":\"error\",\"message\":\"invalid-display-frame\"}\n");return;}
  if(!duplicate){
    unsigned long startedAt=millis();
    for(int i=0;i<entries;i++){
      DisplayEntry &e=frameEntries[i];int module=e.channel-1;
      if(e.mode==1)showOrScroll(module,e.text,e.color,e.speed,e.brightness,false,e.flags==1,false);
      else if(e.mode==2)showTaskModule(module,e.text,e.color,e.brightness,false);
      else if(e.mode==3)setModuleIdle(module);
      else if(e.mode==4)blinkModule(module,e.color,e.brightness,e.duration,false,startedAt);
      else locateModule(module,e.color,e.brightness,e.duration,false,startedAt);
      if(e.mode<=2)modules[module].lastStepAt=startedAt;
    }
    pixels.show();
    strcpy(frameRequests[frameRequestSlot],tokens[3]);frameChecksums[frameRequestSlot]=checksum;frameRequestSlot=(frameRequestSlot+1)%8;
  }
  char reply[256];snprintf(reply,sizeof(reply),"{\"type\":\"ack\",\"command\":\"display-frame\",\"request\":\"%s\",\"address\":\"%s\",\"checksum\":\"%08lx\"}\n",tokens[3],CONTROLLER_ADDRESS,(unsigned long)checksum);send485(reply);
}

void configureController(char **tokens, int count);
void controllerConfigStatus(const char *request);

void handleLine(char *cmdLine) {
  char *firstSpace=strchr(cmdLine,' '),*secondSpace=firstSpace?strchr(firstSpace+1,' '):NULL;
  if(secondSpace&&strncmp(secondSpace+1,"display-frame ",14)==0){handleDisplayFrame(cmdLine);return;}
  if(strlen(cmdLine)>=320)return;
  char local[320];
  strncpy(local, cmdLine, sizeof(local) - 1);
  local[sizeof(local) - 1] = 0;

  char *tokens[10];
  int count = splitLine(local, tokens, 10);

  if (count == 0) {
    return;
  }

  char command[20];
  strncpy(command, tokens[0], sizeof(command) - 1);
  command[sizeof(command) - 1] = 0;
  lowerToken(command);

  bool exactTarget = false;
  if (strcmp(command, "to") == 0 || strcmp(command, "target") == 0) {
    if (count < 3) {
      send485("{\"type\":\"error\",\"message\":\"missing-target-command\"}\n");
      return;
    }
    exactTarget = equalsIgnoreCase(tokens[1], CONTROLLER_ADDRESS);
    if (!isControllerTarget(tokens[1])) {
      return;
    }
    for (int i = 0; i < count - 2; i++) {
      tokens[i] = tokens[i + 2];
    }
    count -= 2;
    strncpy(command, tokens[0], sizeof(command) - 1);
    command[sizeof(command) - 1] = 0;
    lowerToken(command);
  }

  if (usbMaintenance && strcmp(command, "configure") != 0 && strcmp(command, "config-status") != 0) {
    send485("{\"type\":\"error\",\"message\":\"usb-maintenance-only\"}\n"); return;
  }

  if (strcmp(command, "configure") == 0) {
    if (!exactTarget) { send485("{\"type\":\"error\",\"message\":\"configuration-requires-exact-address\"}\n"); return; }
    configureController(tokens, count);
    return;
  }
  if (strcmp(command, "config-status") == 0) {
    bool validRequest = count == 1 || (count == 2 && strlen(tokens[1]) == 16);
    if (count == 2 && validRequest) for (const char *p = tokens[1]; *p; p++) if (groupHex(*p) < 0) validRequest = false;
    if (exactTarget && validRequest) controllerConfigStatus(count == 2 ? tokens[1] : "-");
    return;
  }

  if (strcmp(command, "blink-group") == 0) {
    blinkGroup(tokens, count);
    return;
  }

  if (strcmp(command, "ping") == 0) {
    char msg[512];
    snprintf(msg, sizeof(msg), "{\"type\":\"pong\",\"protocol\":\"%s\",\"controller\":\"%s\",\"address\":\"%s\",\"modules\":%d,\"groupBlink\":1,\"displayFrame\":1,\"runtimeConfig\":1,\"physicalModules\":%d,\"configRevision\":%lu,\"configFault\":%s}\n", FIRMWARE_PROTOCOL, CONTROLLER_NAME, CONTROLLER_ADDRESS, MODULES, runtimeConfig.physicalCount, (unsigned long)runtimeConfig.revision, configurationFault ? "true" : "false");
    send485(msg);
    return;
  }

  if (strcmp(command, "version") == 0 || strcmp(command, "status") == 0) {
    char msg[512];
    snprintf(msg, sizeof(msg), "{\"type\":\"status\",\"protocol\":\"%s\",\"controller\":\"%s\",\"address\":\"%s\",\"modules\":%d,\"groupBlink\":1,\"displayFrame\":1,\"runtimeConfig\":1,\"physicalModules\":%d,\"configRevision\":%lu,\"configFault\":%s}\n", FIRMWARE_PROTOCOL, CONTROLLER_NAME, CONTROLLER_ADDRESS, MODULES, runtimeConfig.physicalCount, (unsigned long)runtimeConfig.revision, configurationFault ? "true" : "false");
    send485(msg);
    return;
  }

  if (strcmp(command, "sync-heartbeat") == 0 || strcmp(command, "heartbeat-sync") == 0) {
    int column = heartbeatColumn;
    if (count >= 2) {
      column = atoi(tokens[1]);
    }
    syncHeartbeat(column);
    return;
  }

  if (strcmp(command, "layout") == 0) {
    if (count >= 2) {
      layoutMode = atoi(tokens[1]);
    }
    for (int module = 0; module < MODULES; module++) {
      renderModule(module);
    }
    pixels.show();
    send485("{\"type\":\"ack\",\"command\":\"layout\"}\n");
    return;
  }

  if (strcmp(command, "clear") == 0 || strcmp(command, "stop") == 0) {
    int module = 0;
    if (count >= 2 && parseModuleNumber(tokens[1], &module)) {
      setModuleIdle(module);
      pixels.show();
      ack("idle", module);
      return;
    }
    for (int module = 0; module < MODULES; module++) {
      setModuleIdle(module);
    }
    pixels.show();
    send485("{\"type\":\"ack\",\"command\":\"idle-all\"}\n");
    return;
  }

  if (strcmp(command, "off") == 0) {
    int module = 0;
    if (count >= 2 && parseModuleNumber(tokens[1], &module)) {
      setModuleOff(module);
      pixels.show();
      ack("off", module);
      return;
    }
    for (int module = 0; module < MODULES; module++) {
      setModuleOff(module);
    }
    pixels.show();
    send485("{\"type\":\"ack\",\"command\":\"off-all\"}\n");
    return;
  }

  if (strcmp(command, "pixel") == 0) {
    if (count >= 4) {
      int module = 0;
      if (!parseModuleNumber(tokens[1], &module)) {
        send485("{\"type\":\"error\",\"message\":\"invalid-module\"}\n");
        return;
      }
      int row = atoi(tokens[2]);
      int column = atoi(tokens[3]);
      const char *color = "red";
      int brightness = DEFAULT_BRIGHTNESS_PERCENT;
      if (count >= 5) {
        color = tokens[4];
      }
      if (count >= 6) {
        brightness = atoi(tokens[5]);
      }
      modules[module].brightness = clampBrightness(brightness);
      setSinglePixel(module, row, column, colorFor(color));
      ack("pixel", module);
      return;
    }
  }

  if (strcmp(command, "test") == 0 || strcmp(command, "fill") == 0 || strcmp(command, "blink") == 0) {
    if (count >= 2) {
      int module = 0;
      if (!parseModuleNumber(tokens[1], &module)) {
        send485("{\"type\":\"error\",\"message\":\"invalid-module\"}\n");
        return;
      }
      const char *color = "green";
      int brightness = DEFAULT_TEST_BRIGHTNESS_PERCENT;
      unsigned long durationMs = DEFAULT_TEST_DURATION_MS;
      if (count >= 3) {
        color = tokens[2];
      }
      if (count >= 4) {
        brightness = atoi(tokens[3]);
      }
      if (count >= 5) {
        durationMs = (unsigned long)atol(tokens[4]);
      }
      if (strcmp(command, "fill") == 0) {
        fillModule(module, colorFor(color), brightness);
      } else {
        blinkModule(module, colorFor(color), brightness, durationMs);
      }
      ack(command, module);
      return;
    }
  }

  if (strcmp(command, "locate") == 0) {
    if (count >= 2) {
      int module = 0;
      if (!parseModuleNumber(tokens[1], &module)) {
        send485("{\"type\":\"error\",\"message\":\"invalid-module\"}\n");
        return;
      }
      const char *color = "red";
      int brightness = DEFAULT_TEST_BRIGHTNESS_PERCENT;
      unsigned long durationMs = DEFAULT_LOCATE_DURATION_MS;
      if (count >= 3) {
        color = tokens[2];
      }
      if (count >= 4) {
        brightness = atoi(tokens[3]);
      }
      if (count >= 5) {
        durationMs = (unsigned long)atol(tokens[4]);
      }
      locateModule(module, colorFor(color), brightness, durationMs);
      ack("locate", module);
      return;
    }
  }

  if (strcmp(command, "task") == 0) {
    if (count >= 4) {
      int module = 0;
      if (!parseModuleNumber(tokens[1], &module)) {
        send485("{\"type\":\"error\",\"message\":\"invalid-module\"}\n");
        return;
      }
      const char *text = tokens[2];
      const char *color = tokens[3];
      int brightness = DEFAULT_TASK_BRIGHTNESS_PERCENT;
      if (count >= 5) {
        brightness = atoi(tokens[4]);
      }
      showTaskModule(module, text, colorFor(color), brightness);
      ack("task", module);
      return;
    }
  }

  if (strcmp(command, "digit") == 0 || strcmp(command, "text") == 0 || strcmp(command, "scroll") == 0) {
    if (count >= 3) {
      int module = 0;
      if (!parseModuleNumber(tokens[1], &module)) {
        send485("{\"type\":\"error\",\"message\":\"invalid-module\"}\n");
        return;
      }
      const char *text = tokens[2];
      const char *color = "red";
      int speed = DEFAULT_SCROLL_MS;
      int brightness = DEFAULT_BRIGHTNESS_PERCENT;
      if (count >= 4) {
        color = tokens[3];
      }
      if (count >= 5) {
        speed = atoi(tokens[4]);
      }
      if (count >= 6) {
        brightness = atoi(tokens[5]);
      }
      bool forceScroll = strcmp(command, "scroll") == 0;
      if (strcmp(command, "digit") == 0) {
        showTaskModule(module, text, colorFor(color), brightness);
      } else {
        showOrScroll(module, text, colorFor(color), speed, brightness, forceScroll, count >= 7 && strcmp(tokens[6], "once") == 0);
      }
      ack(command, module);
      return;
    }
  }

  int explicitModule = 0;
  if (parseModuleNumber(tokens[0], &explicitModule)) {
    if (count >= 2) {
      int module = explicitModule;
      const char *text = tokens[1];
      const char *color = "red";
      int speed = DEFAULT_SCROLL_MS;
      int brightness = DEFAULT_BRIGHTNESS_PERCENT;
      if (count >= 3) {
        color = tokens[2];
      }
      if (count >= 4) {
        speed = atoi(tokens[3]);
      }
      if (count >= 5) {
        brightness = atoi(tokens[4]);
      }
      showOrScroll(module, text, colorFor(color), speed, brightness, false, false);
      ack("display", module);
      return;
    }
  }

  send485("{\"type\":\"error\",\"message\":\"unknown-command\"}\n");
}

uint32_t controllerConfigCrc(const void *data, size_t length) {
  const uint8_t *bytes = (const uint8_t *)data;
  uint32_t crc = 0xffffffff;
  for (size_t i = 0; i < length; i++) {
    crc ^= bytes[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}

bool validControllerRouting(const ControllerConfig &config) {
  if (config.physicalCount > MAX_CONTROLLER_MODULES || config.logicalCount > MAX_CONTROLLER_MODULES) return false;
  bool used[MAX_CONTROLLER_MODULES + 1] = {};
  int logicalCount = 0;
  for (int i = 0; i < MAX_CONTROLLER_MODULES; i++) {
    int physical = config.routing[i];
    if (physical > config.physicalCount || (physical && used[physical])) return false;
    if (physical) { used[physical] = true; logicalCount = i + 1; }
  }
  for (int i = 1; i <= config.physicalCount; i++) if (!used[i]) return false;
  return config.logicalCount == logicalCount;
}

bool replacePixelDriver(int physicalCount) {
  Adafruit_NeoPixel *candidate = new (std::nothrow) Adafruit_NeoPixel(physicalCount * LEDS_PER_MODULE, LED_PIN, NEO_GRB + NEO_KHZ800);
  if (!candidate || (physicalCount && !candidate->getPixels())) { delete candidate; return false; }
  delete pixelDriver;
  pixelDriver = candidate;
  return true;
}

void loadControllerConfig() {
  preferencesReady = controllerPreferences.begin("lyt-controller", false);
  configurationFault = !preferencesReady;
  if (preferencesReady && controllerPreferences.getBytesLength("configuration")) {
    ControllerConfig saved = {};
    bool valid = controllerPreferences.getBytesLength("configuration") == sizeof(saved) &&
      controllerPreferences.getBytes("configuration", &saved, sizeof(saved)) == sizeof(saved) &&
      saved.magic == runtimeConfig.magic && saved.owner == groupCrc(CONTROLLER_ADDRESS) &&
      saved.crc == controllerConfigCrc(&saved, offsetof(ControllerConfig, crc)) && validControllerRouting(saved);
    if (valid) runtimeConfig = saved; else configurationFault = true;
  }
  if (configurationFault) {
    runtimeConfig = {};
    runtimeConfig.magic = 0x4c594301;
  }
  if (!replacePixelDriver(runtimeConfig.physicalCount)) {
    runtimeConfig = {};
    runtimeConfig.magic = 0x4c594301;
    configurationFault = true;
    // The previous buffer is still owned and remains blank; outputs are disabled.
  }
}

void resetConfiguredModules();

void controllerConfigStatus(const char *request) {
  char map[129];
  for (int i = 0; i < MAX_CONTROLLER_MODULES; i++) snprintf(map + i * 2, 3, "%02x", runtimeConfig.routing[i]);
  char address[96];
  strncpy(address, CONTROLLER_ADDRESS, sizeof(address) - 1); address[sizeof(address) - 1] = 0;
  for (char *p = address; *p; p++) *p = toupper(*p);
  char payload[300];
  snprintf(payload, sizeof(payload), "%s config-status %s %08lx %d %s %d", address, request, (unsigned long)runtimeConfig.revision, runtimeConfig.physicalCount, map, configurationFault ? 1 : 0);
  char reply[512];
  snprintf(reply, sizeof(reply), "{\"type\":\"controller-config\",\"address\":\"%s\",\"request\":\"%s\",\"revision\":%lu,\"physicalModules\":%d,\"logicalModules\":%d,\"routing\":\"%s\",\"maxModules\":64,\"fault\":%s,\"checksum\":\"%08lx\"}\n", CONTROLLER_ADDRESS, request, (unsigned long)runtimeConfig.revision, runtimeConfig.physicalCount, MODULES, map, configurationFault ? "true" : "false", (unsigned long)groupCrc(payload));
  send485(reply);
}

void configureController(char **tokens, int count) {
  bool valid = count == 6;
  unsigned long physicalCount = 0;
  if (valid) valid = strlen(tokens[1]) == 16 && strlen(tokens[2]) == 8 && strlen(tokens[4]) == 128 && strlen(tokens[5]) == 8 &&
    groupUnsigned(tokens[3], 0, MAX_CONTROLLER_MODULES, &physicalCount);
  const int hexFields[] = {1, 2, 4, 5};
  if (valid) for (int field : hexFields) {
    for (const char *p = tokens[field]; *p; p++) if (groupHex(*p) < 0) valid = false;
  }
  if (!valid) { send485("{\"type\":\"error\",\"message\":\"invalid-controller-config\"}\n"); return; }
  char address[96];
  strncpy(address, CONTROLLER_ADDRESS, sizeof(address) - 1); address[sizeof(address) - 1] = 0;
  for (char *p = address; *p; p++) *p = toupper(*p);
  char payload[300];
  snprintf(payload, sizeof(payload), "%s configure %s %s %s %s", address, tokens[1], tokens[2], tokens[3], tokens[4]);
  uint32_t checksum = groupCrc(payload);
  if (checksum != (uint32_t)strtoul(tokens[5], NULL, 16)) { send485("{\"type\":\"error\",\"message\":\"config-checksum\"}\n"); return; }
  bool duplicate = !configurationFault && strcmp(runtimeConfig.request, tokens[1]) == 0;
  if (duplicate && runtimeConfig.requestCrc != checksum) { send485("{\"type\":\"error\",\"message\":\"config-request-conflict\"}\n"); return; }
  uint32_t expected = (uint32_t)strtoul(tokens[2], NULL, 16);
  if (!duplicate && (expected != runtimeConfig.revision || expected == 0xffffffff)) {
    send485("{\"type\":\"error\",\"message\":\"config-revision-conflict\"}\n"); return;
  }
  if (!duplicate) {
    for (int module = 0; module < MODULES; module++) {
      if (mappedModule(module) && (modules[module].mode == MODE_STATIC || modules[module].mode == MODE_SCROLL || modules[module].testUntil || modules[module].locateUntil)) {
        send485("{\"type\":\"error\",\"message\":\"configuration-busy-stop-displays-first\"}\n"); return;
      }
    }
    ControllerConfig next = {};
    next.magic = 0x4c594301;
    next.owner = groupCrc(CONTROLLER_ADDRESS);
    next.revision = expected + 1;
    next.physicalCount = physicalCount;
    next.requestCrc = checksum;
    strcpy(next.request, tokens[1]);
    for (int i = 0; i < MAX_CONTROLLER_MODULES; i++) {
      next.routing[i] = groupHex(tokens[4][i * 2]) * 16 + groupHex(tokens[4][i * 2 + 1]);
      if (next.routing[i]) next.logicalCount = i + 1;
    }
    if (!validControllerRouting(next)) { send485("{\"type\":\"error\",\"message\":\"invalid-routing\"}\n"); return; }
    Adafruit_NeoPixel *candidate = new (std::nothrow) Adafruit_NeoPixel(physicalCount * LEDS_PER_MODULE, LED_PIN, NEO_GRB + NEO_KHZ800);
    if (!candidate || (physicalCount && !candidate->getPixels())) {
      delete candidate; send485("{\"type\":\"error\",\"message\":\"config-allocation-failed\"}\n"); return;
    }
    next.crc = controllerConfigCrc(&next, offsetof(ControllerConfig, crc));
    if (!preferencesReady || controllerPreferences.putBytes("configuration", &next, sizeof(next)) != sizeof(next)) {
      delete candidate; send485("{\"type\":\"error\",\"message\":\"config-storage-failed\"}\n"); return;
    }
    // Commit one complete NVS blob before activating its routing. Never persist fields separately.
    for (int i = 0; i < runtimeConfig.physicalCount * LEDS_PER_MODULE; i++) pixels.setPixelColor(i, 0);
    pixels.show();
    delete pixelDriver;
    pixelDriver = candidate;
    pixels.begin(); pixels.setBrightness(255);
    runtimeConfig = next;
    configurationFault = false;
    resetConfiguredModules();
  }
  char reply[300];
  snprintf(reply, sizeof(reply), "{\"type\":\"ack\",\"command\":\"configure\",\"address\":\"%s\",\"request\":\"%s\",\"revision\":%lu,\"physicalModules\":%d}\n", CONTROLLER_ADDRESS, tokens[1], (unsigned long)runtimeConfig.revision, runtimeConfig.physicalCount);
  send485(reply);
}

void resetConfiguredModules() {
  memset(modules, 0, sizeof(modules));
  for (int module = 0; module < MODULES; module++) {
    modules[module].mode = MODE_IDLE;
    modules[module].text[0] = 0;
    modules[module].color = pixels.Color(255, 0, 0);
    modules[module].brightness = DEFAULT_BRIGHTNESS_PERCENT;
    modules[module].scrollOffset = W;
    modules[module].scrollSpeedMs = DEFAULT_SCROLL_MS;
    modules[module].scrollOnce = false;
    modules[module].lastStepAt = 0;
    modules[module].testUntil = 0;
    modules[module].testStartedAt = 0;
    modules[module].testColor = 0;
    modules[module].testBrightness = DEFAULT_TEST_BRIGHTNESS_PERCENT;
    modules[module].lastTestStep = -1;
    modules[module].locateUntil = 0;
    modules[module].locateStartedAt = 0;
    modules[module].locateColor = 0;
    modules[module].lastLocateStep = -1;
    renderModule(module);
  }
  pixels.show();
}

void setup() {
  pinMode(RS485_DE_RE, OUTPUT);
  digitalWrite(RS485_DE_RE, LOW);

  Serial.setRxBufferSize(1024);
  Serial.begin(115200);
  RS485.setRxBufferSize(10240); // Receive full configuration frames while LEDs are refreshing.
  RS485.begin(115200, SERIAL_8N1, RS485_RX, RS485_TX);

  loadControllerConfig();
  pixels.begin();
  pixels.setBrightness(255);
  lastHeartbeatAt = millis();
  heartbeatPulseStartedAt = lastHeartbeatAt;

  resetConfiguredModules();

  char bootMsg[512];
  snprintf(bootMsg, sizeof(bootMsg), "{\"type\":\"boot\",\"mode\":\"simple-matrix-v15\",\"protocol\":\"%s\",\"controller\":\"%s\",\"address\":\"%s\",\"modules\":%d,\"groupBlink\":1,\"displayFrame\":1,\"runtimeConfig\":1,\"physicalModules\":%d,\"configRevision\":%lu,\"configFault\":%s}\n", FIRMWARE_PROTOCOL, CONTROLLER_NAME, CONTROLLER_ADDRESS, MODULES, runtimeConfig.physicalCount, (unsigned long)runtimeConfig.revision, configurationFault ? "true" : "false");
  send485(bootMsg);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      usbLine[usbLinePos] = 0;
      usbMaintenance = true;
      if (!usbLineOverflow) handleLine(usbLine);
      usbMaintenance = false;
      usbLinePos = 0; usbLineOverflow = false;
    } else if (c != '\r') {
      if (usbLinePos < (int)sizeof(usbLine) - 1) usbLine[usbLinePos++] = c;
      else usbLineOverflow = true;
    }
  }
  while (RS485.available()) {
    char c = RS485.read();
    if (c == '\n') {
      line[linePos] = 0;
      if (!lineOverflow) handleLine(line);
      linePos = 0;
      lineOverflow = false;
    } else {
      if (c != '\r') {
        if (linePos < (int)sizeof(line) - 1) {
          line[linePos] = c;
          linePos++;
        } else {
          lineOverflow = true;
        }
      }
    }
  }

  updateModuleTests();
  updateLocateTimeouts();
  updateScrolls();
  updateHeartbeat();
}
