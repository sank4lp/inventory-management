#pragma once

// Bench experiment requested for the separate-supply LED setup. Set to 0 and
// reflash to restore the previous timings. This changes pulse widths, not GPIO
// voltage, and is not a qualified timing profile for every WS2812 revision.
#ifndef LYTGUIDE_LED_MAX_HIGH_EXPERIMENT
#define LYTGUIDE_LED_MAX_HIGH_EXPERIMENT 1
#endif
#if LYTGUIDE_LED_MAX_HIGH_EXPERIMENT != 0 && LYTGUIDE_LED_MAX_HIGH_EXPERIMENT != 1
#error "LYTGUIDE_LED_MAX_HIGH_EXPERIMENT must be 0 or 1"
#endif

// Encode bytes into the ESP32 RMT peripheral as it consumes them. Expanding a
// whole strip into 32-bit symbols costs 6 KB per matrix, even when it is dark.
// This transmitter has a fixed 12 KB payload and a fixed hardware symbol FIFO.
#if defined(ARDUINO_ARCH_ESP32) || defined(LYTGUIDE_RMT_TEST)
#include <Arduino.h>
#include <driver/rmt_tx.h>
#include <driver/rmt_encoder.h>
#include <string.h>

class MatrixLedOutput {
public:
  static constexpr size_t MaxBytes = 64 * 64 * 3;
  static constexpr size_t SymbolCount = 128;
#if LYTGUIDE_LED_MAX_HIGH_EXPERIMENT
  // 50 ns ticks: T0H=550 ns, T0L=700 ns; T1H=1000 ns, T1L=250 ns.
  // HIGH maxima / LOW minima from WORLDSEMI WS2812B Jan 2016, page 5.
  // Both bits remain 1.25 us (800 kbit/s). These are tolerance boundaries.
  static constexpr uint32_t ResolutionHz = 20000000;
  static constexpr unsigned ZeroHigh = 11, ZeroLow = 14, OneHigh = 20, OneLow = 5;
#else
  static constexpr uint32_t ResolutionHz = 10000000;
  static constexpr unsigned ZeroHigh = 4, ZeroLow = 8, OneHigh = 8, OneLow = 4;
#endif
  static constexpr unsigned MaxBitTicks =
    ZeroHigh + ZeroLow > OneHigh + OneLow ? ZeroHigh + ZeroLow : OneHigh + OneLow;
  int error() const { return lastError; }

  bool write(const uint8_t *bytes, size_t length, int pin) {
    if (length > MaxBytes || (length && !bytes)) return fail(ESP_ERR_INVALID_ARG);
    if (poisoned) return false; // Never reuse a payload the hardware may still own.
    if (!length) { lastError = ESP_OK; return true; }
    if (lastError && (int32_t)(millis() - retryAt) < 0) return false;
    if (!prepare(pin)) return false;
    memcpy(payload, bytes, length);
    rmt_transmit_config_t transmit = {};
    transmit.flags.eot_level = 0;
    transmit.flags.queue_nonblocking = 1;
    esp_err_t result = rmt_transmit(channel, encoder, payload, length, &transmit);
    if (result == ESP_OK) {
      // Actual profile's bit time, plus a scheduling margin. Never wait indefinitely and
      // starve the independent RS485/USB command loop after an output failure.
      const int timeoutMs = 100 + (length * 8ULL * MaxBitTicks * 1000 + ResolutionHz - 1) / ResolutionHz;
      result = rmt_tx_wait_all_done(channel, timeoutMs);
    }
    if (result != ESP_OK) {
      release();
      return fail(result);
    }
    // The peripheral holds LOW after the final bit. Latch the ENTIRE chain;
    // splitting it into separate show() calls would repeatedly overwrite cell 1.
    delayMicroseconds(300);
    lastError = ESP_OK;
    return true;
  }

private:
  rmt_channel_handle_t channel = nullptr;
  rmt_encoder_handle_t encoder = nullptr;
  uint8_t payload[MaxBytes] = {};
  bool enabled = false, poisoned = false;
  int activePin = -1;
  esp_err_t lastError = ESP_OK;
  uint32_t retryAt = 0;

  bool fail(esp_err_t error) {
    lastError = error;
    retryAt = millis() + 1000;
    return false;
  }

  void release() {
    if (enabled) {
      if (rmt_disable(channel) != ESP_OK) { poisoned = true; return; }
      enabled = false;
    }
    if (channel) {
      if (rmt_del_channel(channel) != ESP_OK) { poisoned = true; return; }
      channel = nullptr;
    }
    if (encoder) {
      if (rmt_del_encoder(encoder) != ESP_OK) { poisoned = true; return; }
      encoder = nullptr;
    }
    activePin = -1;
  }

  bool prepare(int pin) {
    if (channel && enabled && activePin == pin) return true;
    if (channel || encoder) release();
    if (poisoned) return false;
    rmt_tx_channel_config_t config = {};
    config.gpio_num = (gpio_num_t)pin;
    config.clk_src = RMT_CLK_SRC_DEFAULT;
    config.resolution_hz = ResolutionHz;
    config.mem_block_symbols = SymbolCount;
    config.trans_queue_depth = 1;
    esp_err_t result = rmt_new_tx_channel(&config, &channel);
    if (result == ESP_OK) {
      rmt_bytes_encoder_config_t bytes = {};
      // Keep GRB/MSB-first ordering; only the selected timing profile changes.
      bytes.bit0.level0 = 1; bytes.bit0.duration0 = ZeroHigh;
      bytes.bit0.level1 = 0; bytes.bit0.duration1 = ZeroLow;
      bytes.bit1.level0 = 1; bytes.bit1.duration0 = OneHigh;
      bytes.bit1.level1 = 0; bytes.bit1.duration1 = OneLow;
      bytes.flags.msb_first = 1;
      result = rmt_new_bytes_encoder(&bytes, &encoder);
    }
    if (result == ESP_OK) {
      result = rmt_enable(channel);
      enabled = result == ESP_OK;
    }
    if (result != ESP_OK) { release(); return fail(result); }
    activePin = pin;
    return true;
  }
};

static MatrixLedOutput matrixLedOutput;

// Retain NeoPixel's compact GRB buffer, colour API and brightness behaviour,
// but never call its large-buffer ESP32 show(). Pin -1 prevents its destructor
// or begin() from disconnecting the persistent streaming transmitter.
class MatrixPixels : public Adafruit_NeoPixel {
public:
  MatrixPixels(uint16_t count, int16_t pin, uint16_t type)
    : Adafruit_NeoPixel(count, -1, type), outputPin(pin), byteLength((size_t)count * 3) {}
  void begin() {}
  bool show() { return matrixLedOutput.write(getPixels(), byteLength, outputPin); }
private:
  int outputPin;
  size_t byteLength;
};
#else
// Existing host-side sketch tests emulate the NeoPixel pixel buffer.
using MatrixPixels = Adafruit_NeoPixel;
#endif
