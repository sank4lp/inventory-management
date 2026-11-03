#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <string>
#include <vector>
using byte = unsigned char;
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define SERIAL_8N1 0
#define NEO_GRB 0
#define NEO_KHZ800 0
inline unsigned long fakeMillis = 1000;
inline unsigned long millis() { return fakeMillis; }
inline void pinMode(int,int) {}
inline std::vector<std::string> serialEvents;
inline void digitalWrite(int pin,int value) { serialEvents.push_back("gpio:"+std::to_string(pin)+":"+std::to_string(value)); }
inline void delayMicroseconds(int) {}
struct HardwareSerial {
  std::string output, input;
  size_t cursor=0, rxBuffer=0;
  int uart=0, baud=0, rx=-1, tx=-1;
  bool running=true, failBegin=false;
  HardwareSerial(int number=0):uart(number) {}
  size_t setRxBufferSize(size_t length) { rxBuffer=length; return length; }
  void begin(int speed,int=0,int rxPin=-1,int txPin=-1) { baud=speed; rx=rxPin; tx=txPin; running=!failBegin; }
  explicit operator bool() const { return running; }
  uint32_t baudRate() { return running?baud:0; }
  size_t print(const char *s) { serialEvents.push_back("write:"+std::to_string(uart)); if(!running)return 0; output+=s; return strlen(s); }
  void flush() { serialEvents.push_back("flush:"+std::to_string(uart)); }
  int available() { return running?input.size()-cursor:0; }
  char read() { return input.at(cursor++); }
};
inline HardwareSerial Serial;
struct Adafruit_NeoPixel {
  inline static bool failAllocation = false;
  int shows = 0;
  std::vector<uint32_t> colors;
  Adafruit_NeoPixel(int n,int,int): colors(n) {}
  uint8_t *getPixels() { return (failAllocation || colors.empty()) ? nullptr : reinterpret_cast<uint8_t *>(colors.data()); }
  void begin() {}
  void setBrightness(int) {}
  uint32_t Color(int r,int g,int b) { return (r<<16)|(g<<8)|b; }
  void setPixelColor(int n,uint32_t c) { colors.at(n)=c; }
  void show() { shows++; }
};
