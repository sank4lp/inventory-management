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
DEFAULT_BRIGHTNESS_PERCENT = 100
```

## RS-485 command format

All commands are newline-terminated.

### Long LED chains

The current sketch uses a streaming ESP-IDF RMT byte encoder. NeoPixel still
provides its compact GRB pixel buffer, but its ESP32 `show()` path is bypassed.
That older path expands every bit into a four-byte symbol: 104,448 bytes for
17 matrices, 110,592 for 18, and 135,168 for 22, even if only one pixel per
matrix is on. Failure to allocate that contiguous buffer can silently leave
the whole chain dark. The exact threshold depends on the running controller's
available memory; 17 is not a fixed protocol or LED-count limit.

The streaming transmitter uses one fixed 12,288-byte payload and a 128-symbol
hardware buffer. It sends the entire chain continuously, then holds the data
line low for 300 microseconds to latch it. Brightness, colours, GPIO18, matrix
routing and RS485 addressing are unchanged. There are no separate per-matrix
transmissions that could accidentally restart at the first physical matrix.

Transmission has a length-aware timeout (at most 218 ms with the original
timings, or 223 ms with the maximum-HIGH experiment, at 64 matrices).
Allocation/transmission failures are reported separately from RS485 health;
failed display frames are not acknowledged or remembered as successfully
delivered. USB configuration verification also rejects failed LED output while
permitting explicit recovery of the existing setup. No saved cell mapping or
inventory data is cleared by this change.

Software checks cover 17, 18, 22 and 64 matrices, full payload delivery, output
failure/recovery, retained routing and the two-controller reply discipline.
These are protocol/driver checks with emulated peripherals; they do not certify
the LED power supply, physical signal quality or a particular attached chain.

Validation on 2026-11-04: all 108 targeted LED, controller configuration,
replacement, USB, reconnect and RS485 tests passed. The 22-matrix sketch also
compiled for ESP32 core 3.0.7 / NeoPixel 1.12.4 (installer toolchain) and core
3.3.8 / NeoPixel 1.15.4 (the reported browser toolchain versions). These build
checks did not flash a controller; the corrected output still needs validation
on the physical 22-matrix chain.

### Maximum-HIGH pulse experiment (2026-11-12)

This checkout enables `LYTGUIDE_LED_MAX_HIGH_EXPERIMENT=1` in
`firmware/esp32-simple-matrix/matrix-led-output.h`. The next firmware build
uses these timings; existing flashed controllers do not change automatically.
This is a bench experiment, not a production-qualified fix for bad wiring or
3.3 V signalling into a 5 V matrix.

| Bit | Previous HIGH / LOW | Experimental HIGH / LOW |
| --- | --- | --- |
| 0 | 0.40 / 0.80 microseconds | 0.55 / 0.70 microseconds |
| 1 | 0.80 / 0.40 microseconds | 1.00 / 0.25 microseconds |

The experimental profile uses a 20 MHz RMT clock (50 ns ticks). Both bits are
1.25 microseconds long, so the data rate remains 800 kbit/s. The 300 microsecond
latch, pixel order, brightness, module routing and RS485 communication are
unchanged. Its HIGH durations sit at the upper tolerance boundaries of the
[WORLDSEMI WS2812B January 2016 specification, page 5](https://files.waveshare.com/upload/9/94/WS2812B_datasheet_EN.pdf).
The exact installed pixel revision is unverified; other revisions can have
different limits, and hardware clock error can put a boundary setting outside
the specified range. A longer HIGH does not raise GPIO voltage to 5 V or prove
that downstream matrices reproduce the requested timings exactly.

To test:

1. Update firmware on **one existing controller** using the normal firmware-update
   flow, preserving its identity, LED count and mappings. Do not choose fresh setup.
2. Keep the same power, common ground and cable arrangement. Compare changing
   numbers, colours, Ping and clear commands with the previous firmware. Check
   the first and last matrices and continued controller health.
3. If output worsens, change the header's `#define LYTGUIDE_LED_MAX_HIGH_EXPERIMENT 1`
   to `0`, rebuild and update that same controller again. A compile flag
   `-DLYTGUIDE_LED_MAX_HIGH_EXPERIMENT=0` also selects the original profile.

The driver tests exercise both profiles, full 64-matrix payloads, calculated
timeouts and output failure/recovery. They emulate RMT; a real ESP32 build and
on-device/oscilloscope checks are separate verification steps. Do not distribute
this experimental build to other installations until the experiment is assessed.

### Shared-bus replies

Use `to <controller-address> <command>` for any command that needs a reply,
including health checks: `to ESP32-01 ping`. Only that controller replies.
Legacy unaddressed/broadcast display commands still apply, but do not return
acknowledgements. The broadcast heartbeat sync also stays silent.

Controllers ignore JSON responses from other controllers. Previously, a peer's
`pong` or ACK could trigger `unknown-command`, and the two controllers could
then repeatedly answer each other's errors. This could work with one powered
controller yet interfere with health checks and LED updates when two shared
the bus. Boot announcements now use USB only, avoiding unsolicited RS485
transmissions when several controllers power up together.

The fix requires **updating firmware on every existing controller**, preserving
its saved identity, LED count and routing. Pulling the application code or
restarting the Pi service alone does not update ESP32 firmware. Use the existing
controller's firmware-update flow, not fresh-controller setup. No database
migration or cell remapping is needed.

`test/rs485-multidrop.test.js` compiles two instances of the actual sketch with
four and fifteen modules and forwards their replies to the other receiver. It
covers alternating health queries, addressed errors, display acknowledgements,
configuration reads, silent broadcasts and USB maintenance. Peripheral operations
are simulated: this verifies protocol behaviour, not electrical signal quality,
power capacity or the separate 22-module LED-driver issue.

### Display on a module

```text
<module> <text> <color> <speed-ms> <brightness-percent>
```

Examples:

```text
0 6 red
1 0987654321 green
2 "GOOD MORNING" cyan 80
3 A+B ff00aa 100 100
```

Rules:
- module indexes are `0`, `1`, `2`, and `3` for the current four-module prototype,
- if the text fits in one 8x8 module, it stays static,
- if the text is too wide, it scrolls automatically,
- text with spaces must be wrapped in double quotes,
- speed is optional and defaults to `120` ms per pixel step,
- brightness is optional and defaults to `100` percent,
- brightness is clamped from `0` to `100`,
- each module keeps its own state, so changing module `3` does not stop module `1`.

### Mixed-product quantities

The app uses cyan, white and bright pink at 100% brightness for alternating
mixed-product quantities. It does not reuse the yellow/red/green/blue/orange
workflow colours. A single digit stays visible for four seconds. Longer
numbers make one right-to-left pass at 120 ms per pixel before changing to
the next product: about 2.76 seconds for two digits, 3.60 for three.

The addressed command can add the optional `once` argument:

```text
to ESP32-01 text 1 "10" cyan 120 100 once
```

Rebuild and flash the updated `esp32-simple-matrix` sketch to enable exactly
one scrolling pass. Existing sketches accept the normal text arguments but
ignore `once` and may begin repeating while waiting for the next command.
Regular task numbers and text commands without `once` keep their existing
behaviour. Display ownership, expiry and restoring task lights still belong
to the Pi app.

## Software brightness policy

The application sends **100% brightness** for Pick, Put, stocktaking, Locate,
Ping, quantity/capacity displays, setup and adjustment previews. Time of day
and legacy `LED_DAY_*` / `LED_NIGHT_*` settings cannot reduce it. Hardware
logs identify this policy as `maximum`.

The current firmware uses 100% defaults for text, tasks and test patterns,
and full red for the idle heartbeat. The older `esp32-rs485-matrix` sketch
uses NeoPixel brightness `255` (its 0–255 maximum). Firmware-only defaults
and idle heartbeat changes require reflashing; explicit app commands at
100% already work with firmware supporting the brightness argument.

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
printf '%s\n' '3 A+B ff00aa 100 100' > /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
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
DEFAULT_BRIGHTNESS_PERCENT = 100%
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

Real module current is higher than this because each WS2812 package also has control electronics. The following budgets are historical 8% text-only estimates, not the current 100% operating budget:

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
3.84A * 100% = 3.84A per module
```

Use `3.84A` per module as the full-white planning estimate at the current default brightness. The 8% estimates do not size the current operating power requirements.

If a command uses `100` percent brightness:

```text
one 8x8 module can draw up to 3.84A at full-white
```

The application now uses 100% continuously; size the power zone for the actual simultaneously lit modules, with full-white operation included in the worst case.

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

### Historical module count per buck at 8%

These examples used the old 8% brightness budget and must not be used for the current 100% setting. Use the full-brightness estimates above with the M/N formula below.

For text-only green/blue/cyan operation at 8% brightness:

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

## Grouped ping

Protocol v13 adds an acknowledged, checksummed group command so selected outputs on one controller start together. See [grouped LED ping](06-grouped-led-ping.md) for update steps, delivery guarantees and bench checks.
