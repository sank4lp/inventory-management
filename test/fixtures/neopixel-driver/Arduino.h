#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <assert.h>
#define ESP_IDF_VERSION_VAL(a,b,c) (((a)<<16)|((b)<<8)|(c))
#define ESP_IDF_VERSION ESP_IDF_VERSION_VAL(5,1,4)
using boolean=bool;
using SemaphoreHandle_t=int*;
inline int testMutex=0;
#define pdTRUE 1
#define portTICK_PERIOD_MS 1
#define RMT_TX_MODE 1
#define RMT_MEM_NUM_BLOCKS_1 1
#define RMT_WAIT_FOR_EVER 0xffffffff
union rmt_data_t {
  struct {uint32_t duration0:15;uint32_t level0:1;uint32_t duration1:15;uint32_t level1:1;};
  uint32_t val;
};
static_assert(sizeof(rmt_data_t)==4,"Match ESP32 RMT item size");
inline size_t fixtureWrites=0,fixtureItems=0;
inline uint8_t *fixturePixels=nullptr;
inline SemaphoreHandle_t xSemaphoreCreateMutex(){return &testMutex;}
inline int xSemaphoreTake(SemaphoreHandle_t,int){assert(testMutex==0);testMutex=1;return pdTRUE;}
inline void xSemaphoreGive(SemaphoreHandle_t){assert(testMutex==1);testMutex=0;}
inline bool rmtInit(uint8_t,int,int,int){return true;}
inline void rmtDeinit(int){}
inline void log_e(const char *,...){}
inline void rmtWrite(uint8_t pin,rmt_data_t *items,size_t count,uint32_t){
  assert(pin==18);assert(items);assert(count%8==0);fixtureWrites++;fixtureItems=count;
  for(size_t i=0;i<count;i++){
    const bool high=fixturePixels[i/8]&(1<<(7-i%8));
    assert(items[i].level0==1 && items[i].level1==0);
    assert(items[i].duration0==(high?8:4));assert(items[i].duration1==(high?4:8));
  }
}
