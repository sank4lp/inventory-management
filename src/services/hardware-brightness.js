// Normal illuminated displays use full brightness, regardless of time or legacy settings.
const MAX_LED_BRIGHTNESS_PERCENT = 100;

export function resolveLedBrightness() {
  return {
    mode: "maximum",
    brightnessPercent: MAX_LED_BRIGHTNESS_PERCENT,
  };
}

export function resolveTestBrightness(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Brightness must be a whole number from 0 to 100.');
  return {mode: 'test', brightnessPercent: value};
}
