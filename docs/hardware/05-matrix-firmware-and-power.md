# Matrix Firmware and Power Reference

## Purpose

This document records the current ESP32 matrix firmware behavior, RS-485 command inputs, and power-sizing assumptions for the 8x8 WS2812 matrix module prototype.

## Firmware file

Current firmware:

```text
firmware/esp32-simple-matrix/esp32-simple-matrix.ino
```

Current firmware assumptions:

```text
RS485_DE_RE = D4 / GPIO4
RS485_RX    = RX2 / GPIO16
RS485_TX    = TX2 / GPIO17
LED_PIN     = D18 / GPIO18
MODULES     = 4
DEFAULT_BRIGHTNESS_PERCENT = 8
```

## RS-485 command format

All commands are newline-terminated.

### Display on a module

```text
<module> <text> <color> <speed-ms> <brightness-percent>
```

Examples:

```text
0 6 red
1 0987654321 green
2 "GOOD MORNING" cyan 80
3 A+B ff00aa 100 8
```

Rules:
- module indexes are `0`, `1`, `2`, and `3` for the current four-module prototype,
- if the text fits in one 8x8 module, it stays static,
- if the text is too wide, it scrolls automatically,
- text with spaces must be wrapped in double quotes,
- speed is optional and defaults to `120` ms per pixel step,
- brightness is optional and defaults to `8` percent,
- brightness is clamped from `0` to `100`,
- each module keeps its own state, so changing module `3` does not stop module `1`.

### Control commands

```text
ping
layout <0-15>
clear
clear <module>
stop <module>
off
off <module>
pixel <module> <row> <column> <color>
```

Examples:

```text
ping
layout 3
clear 1
off 2
pixel 0 8 8 green
```

`clear` / `stop` returns a module to the idle heartbeat. `off` turns it fully dark.

## Supported colors

Named colors:

```text
red
green
blue
cyan
magenta
pink
purple
amber
yellow
orange
white
```

Hex colors are also supported:

```text
ff00aa
00ffff
ffb000
```

Use hex without `#` in shell commands to avoid shell/comment parsing issues.

## Example Pi commands

```bash
printf '%s\n' '0 6 red' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
printf '%s\n' '1 0987654321 green 80' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
printf '%s\n' '2 "GOOD MORNING" cyan 80 8' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
printf '%s\n' '3 A+B ff00aa 100 8' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
```

For four modules physically in a row, stagger the commands by one module width:

```bash
printf '%s\n' '0 "GOOD MORNING" green 80 8' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
sleep 0.64
printf '%s\n' '1 "GOOD MORNING" green 80 8' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
sleep 0.64
printf '%s\n' '2 "GOOD MORNING" green 80 8' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
sleep 0.64
printf '%s\n' '3 "GOOD MORNING" green 80 8' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
```

Delay formula:

```text
sleep seconds = 8 * speed-ms / 1000
```

## Current display power estimate

The current firmware default uses:

```text
DEFAULT_BRIGHTNESS_PERCENT = 8%
```

The firmware does not normally light all 64 pixels in a module. It lights only the pixels needed for the displayed character/string.

Calculated from the current font and render modes:

```text
max static digit pixels per module: 28
max static letter/symbol pixels per module: 34
max visible scrolling digit pixels per module: 22
max visible scrolling letter/symbol pixels per module: 27
```

Estimated LED color current, not including WS2812 idle/quiescent current:

```text
current = lit_pixels * 20mA * color_channel_factor * brightness_percent / 100
```

Color channel factor:

```text
red/green/blue = 1
cyan/magenta/yellow/amber/orange/purple = about 2 or less
white = 3
```

| Display case | Lit pixels | Green/blue at 8% | Green/blue at 100% | White at 8% | White at 100% |
| --- | ---: | ---: | ---: | ---: | ---: |
| Static digit | 28 | ~45mA | ~560mA | ~134mA | ~1.68A |
| Static letter/symbol | 34 | ~54mA | ~680mA | ~163mA | ~2.04A |
| Scrolling digits | 22 | ~35mA | ~440mA | ~106mA | ~1.32A |
| Scrolling letters/symbols | 27 | ~43mA | ~540mA | ~130mA | ~1.62A |

Real module current is higher than this because each WS2812 package also has control electronics. For planning current text-only operation, use a conservative module budget of:

```text
0.20A per module for green/blue/cyan text at 8% brightness
0.35A per module if white text is allowed at 8% brightness
```

For a quick estimate at another brightness, scale these budgets by:

```text
budget_at_new_brightness = 8_percent_budget * new_brightness / 8
```

Example: if the 8% text budget is `0.20A`, then a rough 20% brightness budget is `0.20A * 20 / 8 = 0.50A` per module.

Do not use these text-only numbers as the sole safety limit. A firmware bug, test command, or future mode could still turn many more pixels on.

## Full-module worst case

One 8x8 WS2812 matrix has:

```text
64 LEDs
```

Worst-case full white at full brightness:

```text
64 * 60mA = 3.84A per module at 5V
```

At the current default brightness:

```text
3.84A * 8% = about 0.31A per module
```

Use this `0.30A` per module as the minimum design expectation if a module might ever be commanded full-white at the current default brightness.

If a command uses `100` percent brightness:

```text
one 8x8 module can draw up to 3.84A at full-white
```

Use 100% brightness only for brief tests unless the power zone is sized for it.

## 24V 5A SMPS limit

Current SMPS:

```text
24V * 5A = 120W maximum
```

Assuming 85% buck converter efficiency:

```text
120W * 0.85 = about 102W usable at 5V
102W / 5V = about 20A total 5V output across all buck converters
```

This is the total across all buck converters combined, not per buck.

Recommended practical ceiling for continuous use:

```text
15A to 16A total at 5V
```

## Buck converter planning

Multiple buck converter inputs can share the same 24V SMPS:

```text
SMPS +V -> buck 1 IN+, buck 2 IN+, buck 3 IN+
SMPS -V -> buck 1 IN-, buck 2 IN-, buck 3 IN-
```

Do not tie separate buck converter `5V OUT+` terminals together unless the converters are designed for parallel operation.

Recommended power zones:

```text
one buck output powers one group of modules
all grounds/common negatives are connected
5V positives stay separated by zone
each zone should be fused
```

### Conservative module count per buck

For text-only green/blue/cyan operation at current brightness:

```text
budget = 0.20A per module
```

For a buck converter, keep continuous load around 70% of its rating:

```text
recommended modules = floor((buck current rating * 0.70) / 0.20)
```

Examples:

| Buck rating | Recommended modules for text-only use | Safer if white/full-module test modes may be used |
| ---: | ---: | ---: |
| 3A | 10 modules | 5 modules |
| 5A | 17 modules | 10 modules |
| 10A | 35 modules | 20 modules |

### M and N planning formula

Use:

```text
M = number of buck converters
N = number of LED modules per buck converter
I_module = conservative current budget per LED module
I_total_5V = practical total 5V current available from the 24V 5A SMPS
```

For this 24V 5A SMPS, use:

```text
I_total_5V = 16A practical continuous limit
```

Per buck check:

```text
N * I_module <= buck_current_rating * 0.70
```

Whole SMPS check:

```text
M * N * I_module <= 16A
```

If total module count is fixed:

```text
M = ceil(total_modules / N)
```

If `N = 10` modules per buck:

| Planning case | I_module | Current per 10-module buck | Minimum practical buck | Max 10-module buck groups from SMPS |
| --- | ---: | ---: | ---: | ---: |
| 8% normal text, green/blue/cyan/amber/magenta | 0.20A | 2.0A | 5V 3A minimum, 5A preferred | 8 groups, 80 modules |
| 8% white text or possible full-module 8% test | 0.35A | 3.5A | 5V 5A minimum | 4 groups, 40 modules |
| 100% full-white mode | 3.84A | 38.4A | not suitable | not suitable |

For 27 modules with `N = 10`:

```text
M = ceil(27 / 10) = 3 buck converters
zone split = 10 modules, 10 modules, 7 modules
```

This is acceptable for current 8% text-only operation if each 10-module zone uses a good 5V 5A buck and the firmware does not allow long 100% full-white output.

Safer production split for 27 modules:

```text
M = 4 buck converters
zone split = 7 modules, 7 modules, 7 modules, 6 modules
```

This keeps each buck cooler and gives more voltage-drop margin.

For production, prefer smaller fused zones even if the current math says a buck can support more modules. Smaller zones are easier to troubleshoot and safer when wiring is damaged.

Recommended production starting point for 8x8 matrix modules:

```text
1 buck converter per 4 to 8 modules
```

Use the lower end if wiring is long or converter quality is unknown.
