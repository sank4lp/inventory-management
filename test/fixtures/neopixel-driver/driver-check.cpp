// Executes the upstream ESP-IDF 5 driver, with only the peripheral/mutex mocked.
#include "Arduino.h"
#include <vector>
#include <algorithm>
#include <stdio.h>
static bool failAllocation=false;
static size_t largestAllocation=0;
void *fixtureMalloc(size_t size){largestAllocation=std::max(largestAllocation,size);return failAllocation?nullptr:malloc(size);}
void fixtureFree(void *value){free(value);}
#define malloc fixtureMalloc
#define free fixtureFree
#include NEO_DRIVER_SOURCE
#undef malloc
#undef free
int main(){
  espInit();
  for(int modules:{1,4,20,64}){
    std::vector<uint8_t> pixels(modules*64*3);
    for(size_t i=0;i<pixels.size();i++)pixels[i]=i%2?0xa5:0x5a;
    fixturePixels=pixels.data();const auto before=fixtureWrites;
    espShow(18,pixels.data(),pixels.size(),true);
    assert(fixtureWrites==before+1);assert(fixtureItems==pixels.size()*8);assert(testMutex==0);
  }
  assert(largestAllocation==64*64*3*8*sizeof(rmt_data_t));
  // Release the shared allocation, then verify allocation failure and retry.
  espShow(18,nullptr,0,true);const auto writes=fixtureWrites;
  std::vector<uint8_t> four(4*64*3,0x5a);fixturePixels=four.data();
  failAllocation=true;espShow(18,four.data(),four.size(),true);
  assert(fixtureWrites==writes);assert(testMutex==0);
  failAllocation=false;espShow(18,four.data(),four.size(),true);
  assert(fixtureWrites==writes+1);assert(testMutex==0);
  printf("PASS actual fixed driver: 1/4/20/64 matrices, bit timings, heap failure, retry; four matrices need %zu bytes off the loop stack\n",four.size()*8*sizeof(rmt_data_t));
}
