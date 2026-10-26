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
inline void digitalWrite(int,int) {}
inline void delayMicroseconds(int) {}
struct HardwareSerial {
  std::string output;
  HardwareSerial(int=0) {}
  void begin(int,int=0,int=0,int=0) {}
  void print(const char *s) { output += s; }
  void flush() {}
  int available() { return 0; }
  char read() { return 0; }
};
inline HardwareSerial Serial;
struct Adafruit_NeoPixel {
  int shows = 0;
  std::vector<uint32_t> colors;
  Adafruit_NeoPixel(int n,int,int): colors(n) {}
  void begin() {}
  void setBrightness(int) {}
  uint32_t Color(int r,int g,int b) { return (r<<16)|(g<<8)|b; }
  void setPixelColor(int n,uint32_t c) { colors.at(n)=c; }
  void show() { shows++; }
};
