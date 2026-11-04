#include "Adafruit_NeoPixel.h"
#include <assert.h>
#include "../../../firmware/esp32-simple-matrix/esp32-simple-matrix.ino"

void usbStatus() {
  Serial.output.clear();
  Serial.input += "to ESP32-01 config-status 0123456789abcdef\n";
  loop();
}

int main(int argc,char **argv) {
  RS485.failBegin=argc>1 && strcmp(argv[1],"--failed-uart")==0;
  setup();
  if(argc>1 && strcmp(argv[1],"--quantized-baud")==0) {
    // Match ESP32's integer/fractional divider at a 1 MHz source clock.
    const uint32_t scaledClock=1000000UL*16;
    RS485.reportedBaud=scaledClock/(scaledClock/115200);
    usbStatus();printf("%s",Serial.output.c_str());return 0;
  }
  if(RS485.failBegin) {
    assert(RS485.output.empty());assert(rs485TxBytes==0);
    usbStatus();
    assert(Serial.output.find("\"ready\":false")!=std::string::npos);
    assert(Serial.output.find("\"baud\":0")!=std::string::npos);
    printf("%s",Serial.output.c_str());return 0;
  }
  assert(RS485.uart==2 && RS485.baud==115200 && RS485.rx==16 && RS485.tx==17 && RS485.rxBuffer==10240);
  assert(RS485.output.empty());
  assert(Serial.output.find("\"type\":\"boot\"")!=std::string::npos);
  RS485.output.clear();serialEvents.clear();
  auto bootBytes=rs485TxBytes;
  RS485.input="to ESP32-01 pi";loop();assert(RS485.output.empty());assert(rs485RxBytes==14);
  RS485.input+="ng\r\n";loop();
  assert(RS485.output.find("\"type\":\"pong\"")!=std::string::npos);
  assert(rs485RxBytes==18 && rs485RxLines==1 && rs485PingRequests==1);
  assert(rs485TxBytes==bootBytes+RS485.output.size());
  assert((serialEvents==std::vector<std::string>{"gpio:4:1","write:2","flush:2","gpio:4:0"}));
  RS485.output.clear();
  RS485.input+="to WRONG ping\n";loop();assert(RS485.output.empty());assert(rs485PingRequests==1);
  RS485.input+="to ESP32-01 ping\n";loop();assert(rs485PingRequests==2);
  const auto rx=rs485RxBytes,tx=rs485TxBytes,lines=rs485RxLines;
  usbStatus();assert(rs485RxBytes==rx && rs485TxBytes==tx && rs485RxLines==lines);
  printf("%s",Serial.output.c_str());
  // Even a lost UART remains diagnosable through the separate USB port.
  RS485.running=false;usbStatus();assert(Serial.output.find("\"ready\":false")!=std::string::npos);
}
