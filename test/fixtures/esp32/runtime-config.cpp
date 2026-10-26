#include "Adafruit_NeoPixel.h"
#include <assert.h>
#include "../../../firmware/esp32-simple-matrix/esp32-simple-matrix.ino"
void command(std::string text) { std::vector<char> line(text.begin(),text.end()); line.push_back(0); handleLine(line.data()); }
std::string config(const char *id,uint32_t revision,int count,const std::vector<int> &map) {
  std::string routing;
  for(int i=0;i<64;i++) {char digit[3];snprintf(digit,3,"%02x",i<(int)map.size()?map[i]:0);routing+=digit;}
  char rev[9];snprintf(rev,9,"%08x",revision);
  std::string payload=std::string(id)+" "+rev+" "+std::to_string(count)+" "+routing;
  char crc[9];snprintf(crc,9,"%08x",groupCrc(("ESP32-01 configure "+payload).c_str()));
  return "to ESP32-01 configure "+payload+" "+crc;
}
int main(int argc,char **argv) {
  setup();assert(!configurationFault);assert(MODULES==4);
  std::vector<int> twenty;for(int i=1;i<=20;i++)twenty.push_back(i);
  auto initial=config("0000000000000001",0,20,twenty);
  if(argc>1 && strcmp(argv[1],"--usb-status")==0) {
    const auto busBefore=RS485.output;
    usbMaintenance=true;
    command("to ESP32-01 config-status 0123456789abcdef");
    const auto reply=Serial.output;
    const int shows=pixels.shows;
    command("to ESP32-01 blink 1 green 100 5000");
    assert(pixels.shows==shows);assert(RS485.output==busBefore);
    assert(Serial.output.find("usb-maintenance-only")!=std::string::npos);
    printf("%s",reply.c_str());
    return 0;
  }
  if(argc>1) {assert(initial==argv[1]);return 0;}
  command(initial);assert(runtimeConfig.revision==1);assert(runtimeConfig.physicalCount==20);assert(MODULES==20);
  assert(Preferences::writes==1);assert(pixels.colors.size()==20*64);
  auto shows=pixels.shows;command(initial);assert(Preferences::writes==1);assert(pixels.shows==shows);
  auto removed=twenty;removed[10]=0;for(int i=11;i<20;i++)removed[i]--;
  command(config("0000000000000002",1,19,removed));
  assert(runtimeConfig.physicalCount==19);assert(MODULES==20);assert(!mappedModule(10));
  assert(pixelIndex(11,0,0)/64==10); // Logical cell 12 still addresses its LED, now at physical position 11.
  assert(pixelIndex(19,0,0)/64==18);
  auto revision=runtimeConfig.revision;
  command(config("0000000000000003",0,20,twenty));assert(runtimeConfig.revision==revision);
  auto duplicate=removed;duplicate[1]=duplicate[0];command(config("0000000000000003",revision,19,duplicate));assert(runtimeConfig.revision==revision);
  auto corrupt=config("0000000000000003",revision,19,removed);corrupt.back()=corrupt.back()=='0'?'1':'0';command(corrupt);assert(runtimeConfig.revision==revision);
  Adafruit_NeoPixel::failAllocation=true;
  command(config("0000000000000003",revision,20,twenty));assert(runtimeConfig.revision==revision);assert(runtimeConfig.physicalCount==19);
  Adafruit_NeoPixel::failAllocation=false;
  Preferences::failWrite=true;command(config("0000000000000003",revision,20,twenty));assert(runtimeConfig.revision==revision);assert(runtimeConfig.physicalCount==19);Preferences::failWrite=false;
  // Insert new logical slot 21 at physical position 4; existing logical slots keep their identity.
  auto inserted=removed;for(auto &p:inserted)if(p>=4)p++;inserted.push_back(4);
  command(config("0000000000000004",revision,20,inserted));assert(runtimeConfig.revision==revision+1);
  assert(runtimeConfig.routing[20]==4);assert(runtimeConfig.routing[3]==5);assert(runtimeConfig.routing[10]==0);
  // Saved routing survives reboot, and a retry after reboot does not write flash again.
  auto saved=runtimeConfig;runtimeConfig=defaultControllerConfig();loadControllerConfig();resetConfiguredModules();
  assert(memcmp(&runtimeConfig,&saved,sizeof(saved))==0);
  auto writes=Preferences::writes;command(config("0000000000000004",revision,20,inserted));assert(Preferences::writes==writes);
  command(config("0000000000000004",revision,20,twenty));assert(Preferences::writes==writes); // Same ID, changed payload.
  // New configuration cannot interrupt active guidance.
  command("to ESP32-01 blink 1 green 100 5000");
  command(config("0000000000000005",runtimeConfig.revision,20,twenty));assert(Preferences::writes==writes);
  command("to ESP32-01 clear");
  // No broadcasts, even with a valid packet checksum.
  auto broadcast=config("0000000000000005",runtimeConfig.revision,20,twenty);broadcast.replace(3,8,"*");command(broadcast);assert(Preferences::writes==writes);
  command("to ESP32-01 config-status");assert(RS485.output.find("\"physicalModules\":20")!=std::string::npos);
  std::vector<int> empty;command(config("0000000000000006",runtimeConfig.revision,0,empty));assert(runtimeConfig.physicalCount==0);assert(MODULES==0);
  command(config("0000000000000007",runtimeConfig.revision,20,twenty));assert(runtimeConfig.physicalCount==20);
  command("to ESP32-01 clear");
  std::vector<int> maximum;for(int i=1;i<=64;i++)maximum.push_back(i);
  command(config("0000000000000009",runtimeConfig.revision,64,maximum));
  assert(runtimeConfig.physicalCount==64);assert(MODULES==64);assert(pixels.colors.size()==4096);
  command(config("000000000000000a",runtimeConfig.revision,20,twenty));assert(runtimeConfig.physicalCount==20);
  // Invalid stored data disables outputs instead of guessing an identity mapping.
  Preferences::saved[0]^=1;loadControllerConfig();assert(configurationFault);assert(MODULES==0);
  command(config("0000000000000008",0,20,twenty));assert(!configurationFault);assert(runtimeConfig.physicalCount==20);
  Preferences::failOpen=true;loadControllerConfig();assert(configurationFault);assert(MODULES==0);

}
