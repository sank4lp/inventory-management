#include <Adafruit_NeoPixel.h>

constexpr int RS485_DE_RE = 4;  // D4, tied to MAX485 DE + RE
constexpr int RS485_RX = 16;    // RX2, from MAX485 RO through 10k/20k divider
constexpr int RS485_TX = 17;    // TX2, to MAX485 DI
constexpr int LED_PIN = 18;     // D18, to first WS2812 matrix IN through 330R

constexpr int MODULE_COUNT = 4;
constexpr int MODULE_WIDTH = 8;
constexpr int MODULE_HEIGHT = 8;
constexpr int LEDS_PER_MODULE = MODULE_WIDTH * MODULE_HEIGHT;
constexpr int LED_COUNT = MODULE_COUNT * LEDS_PER_MODULE;
constexpr int BRIGHTNESS = 20;

constexpr bool MATRIX_SERPENTINE = true;
constexpr bool FLIP_X = false;
constexpr bool FLIP_Y = false;

HardwareSerial RS485(2);
Adafruit_NeoPixel pixels(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

String inputLine;

struct ScrollState {
  bool active = false;
  int module = 0;
  String text;
  uint32_t color = 0;
  int offset = MODULE_WIDTH;
  unsigned long lastStepAt = 0;
};

ScrollState scrollState;

const uint8_t DIGITS[10][7] = {
  {0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110}, // 0
  {0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110}, // 1
  {0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111}, // 2
  {0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110}, // 3
  {0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010}, // 4
  {0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110}, // 5
  {0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110}, // 6
  {0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000}, // 7
  {0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110}, // 8
  {0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100}, // 9
};

int modulePixelIndex(int module, int x, int y) {
  if (FLIP_X) x = MODULE_WIDTH - 1 - x;
  if (FLIP_Y) y = MODULE_HEIGHT - 1 - y;

  int localIndex;
  if (MATRIX_SERPENTINE && (y % 2 == 1)) {
    localIndex = y * MODULE_WIDTH + (MODULE_WIDTH - 1 - x);
  } else {
    localIndex = y * MODULE_WIDTH + x;
  }

  return module * LEDS_PER_MODULE + localIndex;
}

void rs485Send(const char *message) {
  digitalWrite(RS485_DE_RE, HIGH);
  delayMicroseconds(100);
  RS485.print(message);
  RS485.flush();
  delayMicroseconds(100);
  digitalWrite(RS485_DE_RE, LOW);
}

void clearModule(int module) {
  if (module < 0 || module >= MODULE_COUNT) return;
  for (int i = 0; i < LEDS_PER_MODULE; i++) {
    pixels.setPixelColor(module * LEDS_PER_MODULE + i, 0);
  }
}

void clearAll() {
  scrollState.active = false;
  pixels.clear();
  pixels.show();
}

uint32_t colorFromName(String name) {
  name.toLowerCase();
  if (name == "red") return pixels.Color(255, 0, 0);
  if (name == "green") return pixels.Color(0, 255, 0);
  if (name == "blue") return pixels.Color(0, 0, 255);
  if (name == "amber" || name == "yellow") return pixels.Color(255, 140, 0);
  if (name == "white") return pixels.Color(255, 255, 255);
  return pixels.Color(255, 0, 0);
}

void drawDigitAt(int module, int digit, int originX, int originY, uint32_t color) {
  if (module < 0 || module >= MODULE_COUNT || digit < 0 || digit > 9) return;

  for (int y = 0; y < 7; y++) {
    uint8_t row = DIGITS[digit][y];
    for (int x = 0; x < 5; x++) {
      if (!(row & (1 << (4 - x)))) continue;

      int targetX = originX + x;
      int targetY = originY + y;
      if (targetX < 0 || targetX >= MODULE_WIDTH || targetY < 0 || targetY >= MODULE_HEIGHT) {
        continue;
      }

      pixels.setPixelColor(modulePixelIndex(module, targetX, targetY), color);
    }
  }
}

void showDigit(int module, int digit, uint32_t color) {
  scrollState.active = false;
  clearModule(module);
  drawDigitAt(module, digit, 1, 0, color);
  pixels.show();
}

void renderScrollFrame() {
  clearModule(scrollState.module);

  int cursor = scrollState.offset;
  for (int i = 0; i < scrollState.text.length(); i++) {
    char ch = scrollState.text.charAt(i);
    if (ch >= '0' && ch <= '9') {
      drawDigitAt(scrollState.module, ch - '0', cursor, 0, scrollState.color);
    }
    cursor += 6;
  }

  pixels.show();
}

void startScroll(int module, String text, uint32_t color) {
  scrollState.active = true;
  scrollState.module = module;
  scrollState.text = text;
  scrollState.color = color;
  scrollState.offset = MODULE_WIDTH;
  scrollState.lastStepAt = 0;
  renderScrollFrame();
}

void updateScroll() {
  if (!scrollState.active) return;

  unsigned long now = millis();
  if (now - scrollState.lastStepAt < 120) return;
  scrollState.lastStepAt = now;

  scrollState.offset -= 1;
  int textWidth = scrollState.text.length() * 6;
  if (scrollState.offset < -textWidth) {
    scrollState.offset = MODULE_WIDTH;
  }

  renderScrollFrame();
}

String tokenAt(String line, int index) {
  line.trim();
  int start = 0;
  int token = 0;

  while (start < line.length()) {
    while (start < line.length() && line.charAt(start) == ' ') start++;
    int end = line.indexOf(' ', start);
    if (end < 0) end = line.length();
    if (token == index) return line.substring(start, end);
    token++;
    start = end + 1;
  }

  return "";
}

void handleCommand(String line) {
  line.trim();
  if (!line.length()) return;

  Serial.print("RX ");
  Serial.println(line);

  String command = tokenAt(line, 0);
  command.toLowerCase();

  if (command == "ping") {
    rs485Send("{\"type\":\"pong\",\"controller\":\"bench-1\"}\n");
    return;
  }

  if (command == "clear") {
    clearAll();
    rs485Send("{\"type\":\"ack\",\"command\":\"clear\"}\n");
    return;
  }

  if (command == "digit") {
    int module = tokenAt(line, 1).toInt();
    int digit = tokenAt(line, 2).toInt();
    String colorName = tokenAt(line, 3);
    if (!colorName.length()) colorName = "red";

    showDigit(module, digit, colorFromName(colorName));

    char payload[96];
    snprintf(payload, sizeof(payload), "{\"type\":\"ack\",\"command\":\"digit\",\"module\":%d,\"digit\":%d}\n", module, digit);
    rs485Send(payload);
    return;
  }

  if (command == "scroll") {
    int module = tokenAt(line, 1).toInt();
    String text = tokenAt(line, 2);
    String colorName = tokenAt(line, 3);
    if (!colorName.length()) colorName = "red";

    startScroll(module, text, colorFromName(colorName));

    char payload[96];
    snprintf(payload, sizeof(payload), "{\"type\":\"ack\",\"command\":\"scroll\",\"module\":%d}\n", module);
    rs485Send(payload);
    return;
  }

  rs485Send("{\"type\":\"error\",\"message\":\"unknown-command\"}\n");
}

void setup() {
  pinMode(RS485_DE_RE, OUTPUT);
  digitalWrite(RS485_DE_RE, LOW);

  Serial.begin(115200);
  RS485.begin(115200, SERIAL_8N1, RS485_RX, RS485_TX);

  pixels.begin();
  pixels.setBrightness(BRIGHTNESS);
  clearAll();

  Serial.println("ESP32 RS485 matrix digit firmware booted");
  rs485Send("{\"type\":\"boot\",\"controller\":\"bench-1\",\"mode\":\"matrix-digit\"}\n");
}

void loop() {
  while (RS485.available()) {
    char ch = RS485.read();
    if (ch == '\n') {
      handleCommand(inputLine);
      inputLine = "";
    } else if (ch != '\r') {
      inputLine += ch;
      if (inputLine.length() > 160) inputLine = "";
    }
  }

  updateScroll();
}
