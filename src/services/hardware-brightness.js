// All illuminated displays use full brightness, regardless of time or legacy settings.
const MAX_LED_BRIGHTNESS_PERCENT = 100;

export function resolveLedBrightness() {
  return {
    mode: "maximum",
    brightnessPercent: MAX_LED_BRIGHTNESS_PERCENT,
  };
}
