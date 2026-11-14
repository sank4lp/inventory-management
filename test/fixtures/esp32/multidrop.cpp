#include <iostream>
#include <iomanip>
#include <sstream>
#include "Adafruit_NeoPixel.h"
#include "../../../firmware/esp32-simple-matrix/esp32-simple-matrix.ino"

std::string hex(const std::string &text) {
  std::ostringstream result;
  for (unsigned char ch : text) result << std::hex << std::setw(2) << std::setfill('0') << unsigned(ch);
  return result.str();
}

void report() {
  std::cout << "{\"bus\":\"" << hex(RS485.output)
    << "\",\"usb\":\"" << hex(Serial.output)
    << "\",\"mode\":" << modules[0].mode
    << ",\"replyAllowed\":" << (rs485ReplyAllowed ? "true" : "false") << "}\n";
  RS485.output.clear(); Serial.output.clear();
}

int main() {
  setup(); report();
  std::string incoming;
  while (std::getline(std::cin, incoming)) {
    if (incoming.rfind("USB:", 0) == 0) Serial.input += incoming.substr(4) + "\n";
    else RS485.input += incoming + "\n";
    loop(); report();
  }
}
