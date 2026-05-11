#include <Adafruit_NeoPixel.h>

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

#define MODULES LED_MODULE_COUNT
#define FIRMWARE_PROTOCOL "simple-matrix-v7-idle-scan"
#define W 8
#define H 8
#define LEDS_PER_MODULE 64
#define LED_COUNT (MODULES * LEDS_PER_MODULE)
#define DEFAULT_BRIGHTNESS_PERCENT 8
#define DEFAULT_TASK_BRIGHTNESS_PERCENT 80
#define DEFAULT_TEST_BRIGHTNESS_PERCENT 80
#define DEFAULT_TEST_DURATION_MS 1200
#define DEFAULT_LOCATE_DURATION_MS 120000
#define RIPPLE_STEP_MS 150
#define IDLE_HEARTBEAT_STEP_MS 5000
#define DEFAULT_SCROLL_MS 120
#define DEFAULT_LAYOUT 3
#define CHAR_ADVANCE_STATIC 6
#define CHAR_ADVANCE_SCROLL 7

#define MODE_OFF 0
#define MODE_IDLE 1
#define MODE_STATIC 2
#define MODE_SCROLL 3

HardwareSerial RS485(2);
Adafruit_NeoPixel pixels(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

struct ModuleState {
  int mode;
  char text[56];
  uint32_t color;
  int brightness;
  int scrollOffset;
  int scrollSpeedMs;
  unsigned long lastStepAt;
  unsigned long testUntil;
  unsigned long testStartedAt;
  uint32_t testColor;
  int testBrightness;
  int lastTestStep;
  unsigned long locateUntil;
  bool statusActive;
  uint32_t statusColor;
};

ModuleState modules[MODULES];

char line[160];
int linePos = 0;
int layoutMode = DEFAULT_LAYOUT;
int heartbeatColumn = 0;
unsigned long lastHeartbeatAt = 0;

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
  return module * LEDS_PER_MODULE + mappedLocalIndex(x, y);
}

void send485(const char *msg) {
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
  if (module >= MODULES) {
    return;
  }
  for (int i = 0; i < LEDS_PER_MODULE; i++) {
    pixels.setPixelColor(module * LEDS_PER_MODULE + i, 0);
  }
}

void drawGlyph(int module, char ch, int ox, int oy, uint32_t color, bool bold) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
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

void drawStatusRow(int module) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }
  if (!modules[module].statusActive) {
    return;
  }

  for (int x = 0; x < W; x++) {
    pixels.setPixelColor(pixelIndex(module, x, H - 1), modules[module].statusColor);
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
  drawStatusRow(module);
}

void renderScrollModule(int module) {
  clearModulePixels(module);

  int x = modules[module].scrollOffset;
  for (int i = 0; modules[module].text[i] != 0; i++) {
    drawGlyph(module, modules[module].text[i], x, 0, modules[module].color, false);
    x += CHAR_ADVANCE_SCROLL;
  }
  drawStatusRow(module);
}

void renderIdleModule(int module) {
  clearModulePixels(module);
  pixels.setPixelColor(pixelIndex(module, heartbeatColumn, H - 1), pixels.Color(32, 0, 0));
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

void renderRippleModule(int module, int step) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }

  clearModulePixels(module);
  int ring = step % 5;
  if (ring > 3) {
    return;
  }

  int minRing = ring - 1;
  if (minRing < 0) {
    minRing = 0;
  }

  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      int pixelRing = rippleRingFor(x, y);
      if (pixelRing >= minRing && pixelRing <= ring) {
        pixels.setPixelColor(pixelIndex(module, x, y), modules[module].testColor);
      }
    }
  }
}

void renderModule(int module) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
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

void showOrScroll(int module, const char *text, uint32_t color, int speedMs, int brightness, bool forceScroll) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }

  strncpy(modules[module].text, text, sizeof(modules[module].text) - 1);
  modules[module].text[sizeof(modules[module].text) - 1] = 0;
  modules[module].color = scaleColor(color, brightness);
  modules[module].brightness = clampBrightness(brightness);
  modules[module].scrollSpeedMs = speedMs;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].statusActive = false;
  if (modules[module].scrollSpeedMs <= 0) {
    modules[module].scrollSpeedMs = DEFAULT_SCROLL_MS;
  }
  modules[module].lastStepAt = 0;

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
  pixels.show();
}

void showTaskModule(int module, const char *text, uint32_t color, int brightness) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }

  strncpy(modules[module].text, text, sizeof(modules[module].text) - 1);
  modules[module].text[sizeof(modules[module].text) - 1] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].color = scaleColor(color, modules[module].brightness);
  modules[module].statusColor = modules[module].color;
  modules[module].statusActive = true;
  modules[module].scrollSpeedMs = DEFAULT_SCROLL_MS;
  modules[module].lastStepAt = 0;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;

  if (textPixelWidth(text) <= W) {
    modules[module].mode = MODE_STATIC;
    modules[module].scrollOffset = W;
  } else {
    modules[module].mode = MODE_SCROLL;
    modules[module].scrollOffset = 0;
  }

  renderModule(module);
  pixels.show();
}

void setModuleIdle(int module) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }
  modules[module].mode = MODE_IDLE;
  modules[module].brightness = DEFAULT_BRIGHTNESS_PERCENT;
  modules[module].text[0] = 0;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].statusActive = false;
  renderModule(module);
}

void setModuleOff(int module) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }
  modules[module].mode = MODE_OFF;
  modules[module].brightness = 0;
  modules[module].text[0] = 0;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].statusActive = false;
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

  if (value < 1 || value > MODULES) {
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
  if (module >= MODULES) {
    return;
  }

  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].color = color;
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].statusActive = false;
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
  if (module >= MODULES) {
    return;
  }

  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].testUntil = 0;
  modules[module].locateUntil = 0;
  modules[module].statusActive = false;
  uint32_t scaled = scaleColor(color, modules[module].brightness);
  for (int i = 0; i < LEDS_PER_MODULE; i++) {
    pixels.setPixelColor(module * LEDS_PER_MODULE + i, scaled);
  }
  pixels.show();
}

void blinkModule(int module, uint32_t color, int brightness, unsigned long durationMs) {
  if (module < 0) {
    return;
  }
  if (module >= MODULES) {
    return;
  }
  if (durationMs == 0) {
    durationMs = DEFAULT_TEST_DURATION_MS;
  }
  unsigned long now = millis();
  modules[module].mode = MODE_STATIC;
  modules[module].text[0] = 0;
  modules[module].brightness = clampBrightness(brightness);
  modules[module].testColor = scaleColor(color, modules[module].brightness);
  modules[module].testBrightness = modules[module].brightness;
  modules[module].testStartedAt = now;
  modules[module].testUntil = now + durationMs;
  modules[module].lastTestStep = -1;
  modules[module].locateUntil = 0;
  modules[module].statusActive = false;
  renderRippleModule(module, 0);
  pixels.show();
}

void locateModule(int module, uint32_t color, int brightness, unsigned long durationMs) {
  if (durationMs == 0) {
    durationMs = DEFAULT_LOCATE_DURATION_MS;
  }
  fillModule(module, color, brightness);
  if (module >= 0) {
    if (module < MODULES) {
      modules[module].locateUntil = millis() + durationMs;
    }
  }
}

void updateModuleTests() {
  unsigned long now = millis();
  bool changed = false;

  for (int module = 0; module < MODULES; module++) {
    if (modules[module].testUntil == 0) {
      continue;
    }
    if ((long)(now - modules[module].testUntil) < 0) {
      int step = (int)((now - modules[module].testStartedAt) / RIPPLE_STEP_MS) % 5;
      if (step != modules[module].lastTestStep) {
        modules[module].lastTestStep = step;
        renderRippleModule(module, step);
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
      continue;
    }
    modules[module].locateUntil = 0;
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
  if (now - lastHeartbeatAt < IDLE_HEARTBEAT_STEP_MS) {
    return;
  }

  lastHeartbeatAt = now;
  heartbeatColumn = (heartbeatColumn + 1) % W;

  bool changed = false;
  for (int module = 0; module < MODULES; module++) {
    if (modules[module].mode == MODE_IDLE) {
      renderModule(module);
      changed = true;
    }
  }

  if (changed) {
    pixels.show();
  }
}

void handleLine(char *cmdLine) {
  char local[160];
  strncpy(local, cmdLine, sizeof(local) - 1);
  local[sizeof(local) - 1] = 0;

  char *tokens[8];
  int count = splitLine(local, tokens, 8);

  if (count == 0) {
    return;
  }

  char command[20];
  strncpy(command, tokens[0], sizeof(command) - 1);
  command[sizeof(command) - 1] = 0;
  lowerToken(command);

  if (strcmp(command, "ping") == 0) {
    char msg[128];
    snprintf(msg, sizeof(msg), "{\"type\":\"pong\",\"protocol\":\"%s\",\"controller\":\"%s\",\"modules\":%d}\n", FIRMWARE_PROTOCOL, CONTROLLER_NAME, MODULES);
    send485(msg);
    return;
  }

  if (strcmp(command, "version") == 0 || strcmp(command, "status") == 0) {
    char msg[128];
    snprintf(msg, sizeof(msg), "{\"type\":\"status\",\"protocol\":\"%s\",\"controller\":\"%s\",\"modules\":%d}\n", FIRMWARE_PROTOCOL, CONTROLLER_NAME, MODULES);
    send485(msg);
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
      showOrScroll(module, text, colorFor(color), speed, brightness, forceScroll);
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
      showOrScroll(module, text, colorFor(color), speed, brightness, false);
      ack("display", module);
      return;
    }
  }

  const char *color = "red";
  int speed = DEFAULT_SCROLL_MS;
  int brightness = DEFAULT_BRIGHTNESS_PERCENT;
  if (count >= 2) {
    color = tokens[1];
  }
  if (count >= 3) {
    speed = atoi(tokens[2]);
  }
  if (count >= 4) {
    brightness = atoi(tokens[3]);
  }
  showOrScroll(0, tokens[0], colorFor(color), speed, brightness, false);
  ack("display", 0);
}

void setup() {
  pinMode(RS485_DE_RE, OUTPUT);
  digitalWrite(RS485_DE_RE, LOW);

  Serial.begin(115200);
  RS485.begin(115200, SERIAL_8N1, RS485_RX, RS485_TX);

  pixels.begin();
  pixels.setBrightness(255);

  for (int module = 0; module < MODULES; module++) {
    modules[module].mode = MODE_IDLE;
    modules[module].text[0] = 0;
    modules[module].color = pixels.Color(255, 0, 0);
    modules[module].brightness = DEFAULT_BRIGHTNESS_PERCENT;
    modules[module].scrollOffset = W;
    modules[module].scrollSpeedMs = DEFAULT_SCROLL_MS;
    modules[module].lastStepAt = 0;
    modules[module].testUntil = 0;
    modules[module].testStartedAt = 0;
    modules[module].testColor = 0;
    modules[module].testBrightness = DEFAULT_TEST_BRIGHTNESS_PERCENT;
    modules[module].lastTestStep = -1;
    modules[module].locateUntil = 0;
    modules[module].statusActive = false;
    modules[module].statusColor = 0;
    renderModule(module);
  }
  pixels.show();

  char bootMsg[128];
  snprintf(bootMsg, sizeof(bootMsg), "{\"type\":\"boot\",\"mode\":\"simple-matrix-v7\",\"protocol\":\"%s\",\"controller\":\"%s\",\"modules\":%d}\n", FIRMWARE_PROTOCOL, CONTROLLER_NAME, MODULES);
  send485(bootMsg);
}

void loop() {
  while (RS485.available()) {
    char c = RS485.read();
    if (c == '\n') {
      line[linePos] = 0;
      handleLine(line);
      linePos = 0;
    } else {
      if (c != '\r') {
        if (linePos < (int)sizeof(line) - 1) {
          line[linePos] = c;
          linePos++;
        }
      }
    }
  }

  updateModuleTests();
  updateLocateTimeouts();
  updateScrolls();
  updateHeartbeat();
}
