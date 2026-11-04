#pragma once
#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <string>
#include <vector>
using esp_err_t=int;
using gpio_num_t=int;
constexpr int ESP_OK=0,ESP_FAIL=-1,ESP_ERR_INVALID_ARG=258,ESP_ERR_NO_MEM=257,ESP_ERR_TIMEOUT=263,RMT_CLK_SRC_DEFAULT=0;
struct rmt_tx_channel_config_t {int gpio_num,clk_src;uint32_t resolution_hz;size_t mem_block_symbols,trans_queue_depth;};
struct rmt_transmit_config_t {int loop_count;struct {unsigned eot_level,queue_nonblocking;} flags;};
struct rmt_symbol_word_t {unsigned level0,duration0,level1,duration1;};
struct rmt_bytes_encoder_config_t {rmt_symbol_word_t bit0,bit1;struct {unsigned msb_first;} flags;};
struct TestChannel {bool enabled=false;};
struct TestEncoder {rmt_bytes_encoder_config_t config;};
using rmt_channel_handle_t=TestChannel*;
using rmt_encoder_handle_t=TestEncoder*;
namespace RmtTest {
inline std::string failAt;
inline int creates=0,deletes=0,encoderCreates=0,encoderDeletes=0,transmits=0,timeout=0;
inline const uint8_t *borrowed=nullptr;
inline size_t borrowedLength=0;
inline std::vector<uint8_t> received;
inline void reset() {failAt="";creates=deletes=encoderCreates=encoderDeletes=transmits=timeout=0;borrowed=nullptr;borrowedLength=0;received.clear();}
}
inline esp_err_t rmt_new_tx_channel(const rmt_tx_channel_config_t *config,rmt_channel_handle_t *out) {
  assert(config->gpio_num==18);assert(config->resolution_hz==10000000);
  assert(config->mem_block_symbols==128 && config->trans_queue_depth==1);
  if(RmtTest::failAt=="channel")return ESP_ERR_NO_MEM;
  *out=new TestChannel;RmtTest::creates++;return ESP_OK;
}
inline esp_err_t rmt_new_bytes_encoder(const rmt_bytes_encoder_config_t *config,rmt_encoder_handle_t *out) {
  assert(config->flags.msb_first==1);
  assert(config->bit0.level0==1 && config->bit0.duration0==4 && config->bit0.level1==0 && config->bit0.duration1==8);
  assert(config->bit1.level0==1 && config->bit1.duration0==8 && config->bit1.level1==0 && config->bit1.duration1==4);
  if(RmtTest::failAt=="encoder")return ESP_ERR_NO_MEM;
  *out=new TestEncoder{*config};RmtTest::encoderCreates++;return ESP_OK;
}
inline esp_err_t rmt_enable(rmt_channel_handle_t channel) {
  if(RmtTest::failAt=="enable")return ESP_FAIL;
  channel->enabled=true;return ESP_OK;
}
inline esp_err_t rmt_disable(rmt_channel_handle_t channel) {
  if(RmtTest::failAt=="disable")return ESP_FAIL;
  channel->enabled=false;RmtTest::borrowed=nullptr;return ESP_OK;
}
inline esp_err_t rmt_del_channel(rmt_channel_handle_t channel) {
  assert(!channel->enabled);delete channel;RmtTest::deletes++;return ESP_OK;
}
inline esp_err_t rmt_del_encoder(rmt_encoder_handle_t encoder) {
  delete encoder;RmtTest::encoderDeletes++;return ESP_OK;
}
inline esp_err_t rmt_transmit(rmt_channel_handle_t channel,rmt_encoder_handle_t,const void *data,size_t length,const rmt_transmit_config_t *config) {
  assert(channel->enabled);assert(config->flags.eot_level==0 && config->flags.queue_nonblocking==1 && config->loop_count==0);
  RmtTest::transmits++;
  if(RmtTest::failAt=="transmit")return ESP_FAIL;
  RmtTest::borrowed=(const uint8_t*)data;RmtTest::borrowedLength=length;return ESP_OK;
}
inline esp_err_t rmt_tx_wait_all_done(rmt_channel_handle_t,int timeout) {
  assert(timeout>=100 && timeout<=218);RmtTest::timeout=timeout;
  if(RmtTest::failAt=="wait" || RmtTest::failAt=="disable")return ESP_ERR_TIMEOUT;
  RmtTest::received.assign(RmtTest::borrowed,RmtTest::borrowed+RmtTest::borrowedLength);
  RmtTest::borrowed=nullptr;return ESP_OK;
}
