const DEFAULT_DAY_BRIGHTNESS_PERCENT = 20;
const DEFAULT_NIGHT_BRIGHTNESS_PERCENT = 8;
const DEFAULT_DAY_START_HOUR = 6;
const DEFAULT_NIGHT_START_HOUR = 18;

function boundedInteger(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function hourIsInRange(hour, startHour, endHour) {
  if (startHour === endHour) {
    return true;
  }
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

export function ledBrightnessSettings(config = {}) {
  return {
    dayBrightnessPercent: boundedInteger(
      config.ledDayBrightnessPercent,
      DEFAULT_DAY_BRIGHTNESS_PERCENT,
      { min: 1, max: 100 },
    ),
    nightBrightnessPercent: boundedInteger(
      config.ledNightBrightnessPercent,
      DEFAULT_NIGHT_BRIGHTNESS_PERCENT,
      { min: 1, max: 100 },
    ),
    dayStartHour: boundedInteger(config.ledDayStartHour, DEFAULT_DAY_START_HOUR, {
      min: 0,
      max: 23,
    }),
    nightStartHour: boundedInteger(config.ledNightStartHour, DEFAULT_NIGHT_START_HOUR, {
      min: 0,
      max: 23,
    }),
  };
}

export function resolveLedBrightness(config = {}, at = new Date()) {
  const settings = ledBrightnessSettings(config);
  const hour = at.getHours();
  const mode = hourIsInRange(hour, settings.dayStartHour, settings.nightStartHour)
    ? "day"
    : "night";

  return {
    ...settings,
    mode,
    brightnessPercent:
      mode === "day"
        ? settings.dayBrightnessPercent
        : settings.nightBrightnessPercent,
  };
}
