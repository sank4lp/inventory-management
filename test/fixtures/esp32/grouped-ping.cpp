#include "Adafruit_NeoPixel.h"
#include <assert.h>
#include "../../../firmware/esp32-simple-matrix/esp32-simple-matrix.ino"
void command(std::string text) { std::vector<char> line(text.begin(),text.end()); line.push_back(0); handleLine(line.data()); }
std::string group(const char *id, const char *mask, const char *duration="5000") {
  std::string payload=std::string(id)+" "+mask+" green 100 "+duration;
  char crc[9]; snprintf(crc,sizeof(crc),"%08x",groupCrc((std::string("ESP32-01 ")+payload).c_str()));
  return "to ESP32-01 blink-group "+payload+" "+crc;
}
int main() {
  assert(groupCrc("123456789")==0xcbf43926);
  std::string all="f"+std::string(63,'0');
  auto first=group("0123456789abcdef",all.c_str());
  command(first);
  assert(pixels.shows==1);
  for (int i=0;i<4;i++) { assert(modules[i].testStartedAt==1000); assert(modules[i].testUntil==6000); }
  fakeMillis=2000; command(first);
  assert(pixels.shows==1); assert(modules[0].testUntil==6000);
  assert(RS485.output.find("\"request\":\"0123456789abcdef\"")!=std::string::npos);
  auto corrupt=group("1123456789abcdef",all.c_str()); corrupt.back()=corrupt.back()=='0'?'1':'0'; command(corrupt);
  assert(pixels.shows==1);
  std::string bad="0f"+std::string(62,'0'); command(group("2123456789abcdef",bad.c_str()));
  assert(pixels.shows==1); // Invalid member rejects the entire group.
  command(group("3123456789abcdef",all.c_str(),"-1")); assert(pixels.shows==1);
  command(group("0123456789abcdef",all.c_str(),"4000")); assert(pixels.shows==1); // ID collision.
  auto before=modules[1].testUntil;
  std::string subset="5"+std::string(63,'0'); command(group("4123456789abcdef",subset.c_str()));
  assert(pixels.shows==2); assert(modules[0].testStartedAt==2000); assert(modules[2].testStartedAt==2000);
  assert(modules[1].testUntil==before);
  fakeMillis=7000; command(first); assert(pixels.shows==2); // Old retry cannot resurrect expired ping.
  command("to OTHER blink-group ignored"); assert(pixels.shows==2);
}
