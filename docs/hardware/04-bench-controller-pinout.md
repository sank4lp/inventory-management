# Bench Controller Pinout

## Purpose

This document records the known-working bench wiring for one ESP32 controller connected to:
- Raspberry Pi USB-RS485 adapter,
- MAX485 TTL-to-RS485 module,
- LM2596 24V-to-5V buck converter,
- WS2812 8x8 LED matrix modules.

This is the fast reference for reconnecting the current prototype. It is not the final rack wiring diagram.

## Current confirmed bench result

The following has been proven on the bench:
- Raspberry Pi can send RS-485 commands to the ESP32.
- ESP32 can reply over RS-485.
- ESP32 can control chained WS2812 8x8 matrix modules from one data pin.
- Current LED data test skips the `74HCT125` / `74AHCT125` level shifter and drives LED data directly from ESP32 `D18` through a `330R` data resistor.

For production, add an HCT/AHCT level shifter on LED data if wiring length or reliability requires it.

## Power path

Set the LM2596 output with a multimeter before connecting electronics.

| From | To |
| --- | --- |
| 24V supply `+V` | LM2596 `IN+` |
| 24V supply `-V` | LM2596 `IN-` |
| LM2596 `OUT+`, adjusted to 5V | 5V rail |
| LM2596 `OUT-` | GND rail |
| 5V rail | ESP32 `VIN` / `5V` |
| GND rail | ESP32 `GND` |
| 5V rail | MAX485 `VCC` |
| GND rail | MAX485 `GND` |
| 5V rail | LED module `V+` |
| GND rail | LED module `V-` |

Capacitor placement:

```text
1000uF capacitor + -> 5V rail near first LED module
1000uF capacitor - -> GND rail near first LED module
```

## MAX485 to ESP32

| ESP32 pin label | MAX485 pin |
| --- | --- |
| `TX2` | `DI` |
| `RX2` | `RO` through the voltage divider below |
| `D4` | `DE` and `RE` tied together |
| `GND` | common GND rail |

The tested prototype currently uses `D4` for `DE`/`RE`. If boot instability appears later, move direction control to a safer GPIO such as `D21` and update firmware.

## MAX485 receive voltage divider

Do not connect MAX485 `RO` directly to ESP32 `RX2` when the MAX485 is powered from 5V.

Known-working divider:

```text
MAX485 RO ---- 10k ----+---- ESP32 RX2
                       |
                      20k
                       |
                      GND
```

This brings the MAX485 receive output down to a safe ESP32 input level.

## Raspberry Pi USB-RS485 adapter to MAX485

| Raspberry Pi USB-RS485 adapter | MAX485 |
| --- | --- |
| `A` | `A` |
| `B` | `B` |
| `GND` | common GND rail |

If communication fails after rewiring, swap `A` and `B` first.

Optional bench termination:

```text
120R resistor across MAX485 A and B
```

Final rack termination should use 120R only at the two physical ends of the RS-485 bus.

## ESP32 to WS2812 matrix modules

Current bench setup, without level shifter:

| From | To |
| --- | --- |
| ESP32 `D18` | `330R` resistor |
| other side of `330R` resistor | first LED module `IN` |
| 5V rail | LED module `V+` |
| GND rail | LED module `V-` |

For chained matrix modules:

```text
ESP32 D18 -> 330R -> Module 1 IN
Module 1 OUT -> Module 2 IN
Module 2 OUT -> Module 3 IN
Module 3 OUT -> Module 4 IN
```

LED power should be parallel:

```text
5V rail -> every module V+
GND rail -> every module V-
```

For a short bench chain, passing `V+` and `V-` through the module output pads to the next module is acceptable. For final hardware, use proper 5V and GND rails with power injection.

## Working firmware assumptions

Current matrix digit firmware is stored at `firmware/esp32-rs485-matrix/esp32-rs485-matrix.ino`.

Current bench firmware assumptions:

```text
RS485_DE_RE = D4 / GPIO4
RS485_RX    = RX2 / GPIO16
RS485_TX    = TX2 / GPIO17
LED_PIN     = D18 / GPIO18
LEDS_PER_MODULE = 64
```

The current test command model supports commands such as:

```text
ping
clear
clear 0
stop 1
off 2
layout 3
pixel 0 8 8 green
0 6 red
1 0987654321 green
2 HELLO ff00aa 80 8
3 A+B blue
```

The first value in the short display command is the module index. If the text fits in one 8x8 module, it is shown statically. If it is too wide, it scrolls automatically. Optional command fields are color, scroll speed in milliseconds, and brightness percent. Each module keeps its own display state, so starting a scroll on module `3` does not stop an existing scroll on module `1`.
