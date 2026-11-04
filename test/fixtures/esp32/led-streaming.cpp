#include "Adafruit_NeoPixel.h"
#define LYTGUIDE_RMT_TEST 1
#include "../../../firmware/esp32-simple-matrix/matrix-led-output.h"
#include <assert.h>

int main() {
  static_assert(sizeof(MatrixLedOutput)<13000,"output storage must not scale to a symbol for every LED bit");
  RmtTest::reset();
  MatrixLedOutput output;
  for(int modules:{1,4,17,18,22,64,15,0,22}) {
    std::vector<uint8_t> data(modules*64*3);
    for(size_t i=0;i<data.size();i++)data[i]=(i*29+modules)%256;
    int before=RmtTest::transmits;
    assert(output.write(data.data(),data.size(),18));assert(output.error()==0);
    assert(RmtTest::transmits==before+(modules?1:0));
    if(modules)assert(RmtTest::received==data); // Includes the last pixel in the last matrix.
  }
  assert(RmtTest::creates==1 && RmtTest::encoderCreates==1);
  assert(!output.write(nullptr,1,18));assert(output.error()==ESP_ERR_INVALID_ARG);
  std::vector<uint8_t> data(22*64*3,123);
  assert(!output.write(data.data(),MatrixLedOutput::MaxBytes+1,18));
  for(const char *stage:{"channel","encoder","enable","transmit","wait"}) {
    RmtTest::reset();fakeMillis+=2000;
    MatrixLedOutput failing;RmtTest::failAt=stage;
    assert(!failing.write(data.data(),data.size(),18));assert(failing.error()!=0);
    assert(RmtTest::creates==RmtTest::deletes && RmtTest::encoderCreates==RmtTest::encoderDeletes);
    int attempts=RmtTest::transmits;
    assert(!failing.write(data.data(),data.size(),18));assert(RmtTest::transmits==attempts);
    RmtTest::failAt="";fakeMillis+=2000;
    assert(failing.write(data.data(),data.size(),18));assert(RmtTest::received==data);
    // Clean up the test-owned fake channel through the same timeout path.
    RmtTest::failAt="wait";assert(!failing.write(data.data(),data.size(),18));
  }
  RmtTest::reset();fakeMillis+=2000;
  MatrixLedOutput poisoned;RmtTest::failAt="disable";
  assert(!poisoned.write(data.data(),data.size(),18));
  const auto *pending=RmtTest::borrowed;
  assert(pending && pending!=data.data());
  std::fill(data.begin(),data.end(),99);fakeMillis+=2000;RmtTest::failAt="";
  assert(!poisoned.write(data.data(),data.size(),18));
  assert(pending[0]==123 && RmtTest::transmits==1); // Never overwrite/free an in-flight payload.
}
