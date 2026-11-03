export const ESP32_FIRMWARE_PROTOCOL = "simple-matrix-v15-rs485-addressed";
export const DEFAULT_ESP32_FQBN = "esp32:esp32:esp32";
export const MIN_LED_MODULES = 1;
export const MAX_LED_MODULES = 64;
// 1.12.3 puts the ESP32 RMT buffer on the 8 KB loop stack: four 8x8 RGB
// modules require 24 KB. 1.12.4 moves that buffer to checked heap allocation.
export const NEOPIXEL_LIBRARY_VERSION = "1.12.4";
export const NEOPIXEL_ESP_DRIVER_SHA256 = "514d70194921cdb696a46ad266beb1cce1c91e41107cd5979c51a05ab424ddaf";
