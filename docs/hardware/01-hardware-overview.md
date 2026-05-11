# Hardware Overview

## Purpose

This document summarizes the current phase-1 hardware design and installation assumptions so that the software documentation remains aligned with the physical system.

## Current physical baseline

- Total cells: **81**
- Layout: **27 columns × 3 rows**
- Operator station at the warehouse entry
- Each cell has:
  - 3 addressable RGB LEDs
  - 1 push button

## Locked phase-1 design

### Central station
- Raspberry Pi
- display
- keyboard/mouse
- printer
- USB-to-RS485 converter

### Rack-side network
- RS-485 communication bus
- 3 controller blocks
- each controller block manages 27 cells

### Per controller block
- ESP32 board
- 1 RS-485 transceiver
- 2 button expander devices
- 1 LED data level shifter
- 1 local 24V to 5V buck converter
- LED/button wiring to the cells in that block

## Recommended block placement

Instead of placing one ESP32 far away and running long LED data wires, place each controller block physically near the cells it manages.

Recommended segmentation:
- Block 1: columns 1–9 across rows 1–3
- Block 2: columns 10–18 across rows 1–3
- Block 3: columns 19–27 across rows 1–3

This keeps LED data and low-voltage wiring shorter and improves reliability.

## Cell allocation per controller block

Each block manages:
- **27 cells**
- **27 push buttons**
- **81 LEDs** total

Recommended internal split inside one controller block:
- Row 1 LEDs: 27 LEDs
- Row 2 LEDs: 27 LEDs
- Row 3 LEDs: 27 LEDs

This means each controller block can drive 3 shorter LED chains instead of one long chain.

## Connectivity summary

### Data path
Raspberry Pi → USB-RS485 adapter → RS-485 bus → controller block transceiver → ESP32 → LEDs/buttons logic

### Power path
24V supply → distributed power wiring → local buck conversion at controller block → 5V/3.3V local electronics

## Recommended wiring strategy

- Use the shielded twisted-pair cable for **RS-485 communication**.
- Run RS-485 in **one daisy-chain bus**, not a star.
- Place controller blocks close to the cells they manage.
- Use **separate heavier wiring** for the main 24V power feed to each controller block.
- Convert 24V to 5V locally inside each controller block.
- Keep raw WS2812 LED data wiring short.

## Power assumptions

For the current 3-LED-per-cell design:
- total LEDs in the system: **243**
- LEDs per controller block: **81**
- central supply recommendation: **24V distribution with local conversion at each controller**
- local converter target per controller block: **5V, 6A minimum**

The exact central power supply size depends on wire length and final LED brightness policy, but the local-controller approach should stay the same.

## Important constraints

- Long-distance **RS-485** communication is good.
- Long-distance raw **WS2812/SK6812 LED data** is not recommended.
- Long-distance **5V LED power injection** is also not desirable.

Therefore:
- keep long runs on RS-485,
- distribute 24V rather than 5V for longer distances,
- keep controller blocks close to the cells they control.

## What physically plugs into what

### At the central station
- Raspberry Pi USB port → USB-to-RS485 adapter
- Raspberry Pi HDMI → display
- Raspberry Pi USB → keyboard/mouse
- Raspberry Pi USB or network → printer, depending on printer type

### From the central station to the rack
- USB-to-RS485 adapter `A/B/GND` → RS-485 bus cable
- 24V power supply output → main 24V distribution cable

### At each controller block
- RS-485 bus `A/B/GND` → RS-485 transceiver input
- 24V distribution cable → controller block power input
- controller block power input → local buck converter
- buck converter 5V output → ESP32 input, LED 5V rail, and level shifter 5V
- ESP32 3.3V rail → RS-485 transceiver logic side and button expanders
- ESP32 UART → RS-485 transceiver
- ESP32 I2C → button expanders
- ESP32 LED GPIO → level shifter → LED row data lines
- button terminals → button expanders

### At each cell
- LED chain 5V/GND/DATA → 3-cell LED indicator for that location
- push button → controller box button input and common ground

## Phase-1 hardware/software interaction model

- software chooses target cells,
- software chooses light colors,
- controller blocks execute light states,
- button events are sent back to the software,
- software remains the main source of truth for quantity and task state.
- the operator should be able to print reports directly from the system after selecting a timeframe.

## Recommended document reading order for physical setup

1. Read this overview first.
2. Read `02-esp32-zone-controller.md` to build one controller box correctly.
3. Read `03-physical-installation-guide.md` and follow the installation sequence step by step.
4. Use `04-bench-controller-pinout.md` when reconnecting the current ESP32/MAX485/LED prototype.

## Open implementation details

- final enclosure size and mounting hardware,
- exact terminal block models,
- exact wire gauges for local LED/button harnesses,
- final button hardware model,
- final printer type and connection method.
