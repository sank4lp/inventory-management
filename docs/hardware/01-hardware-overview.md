# Hardware Overview

## Purpose

This document summarizes the current phase-1 hardware design assumptions so that the software documentation remains aligned with the physical system.

## Current physical baseline

- Total cells: **81**
- Layout: **27 columns × 3 rows**
- Operator station at the warehouse entry
- Each cell has:
  - 1 RGB indicator light
  - 1 push button

## Current topology assumption

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
- RS-485 transceiver
- button expansion hardware
- local power conversion
- LED/button wiring to the cells in that block

## Recommended block placement

Instead of placing one ESP32 far away and running long LED data wires, place each controller block physically near the cells it manages.

Recommended segmentation:
- Block 1: columns 1–9 across rows 1–3
- Block 2: columns 10–18 across rows 1–3
- Block 3: columns 19–27 across rows 1–3

This keeps LED data and low-voltage wiring shorter and improves reliability.

## Connectivity summary

### Data path
Raspberry Pi → USB-RS485 adapter → RS-485 bus → controller block transceiver → ESP32 → LEDs/buttons logic

### Power path
24V supply → distributed power wiring → local buck conversion at controller block → 5V/3.3V local electronics

## Power assumptions

For low-power RGB indicator LEDs in phase 1:
- central supply assumption: **24V, 5A SMPS**
- local 24V to 5V conversion near controller blocks

This is a planning assumption and should be confirmed against the final LED choice.

## Important constraint

- Long-distance **RS-485** communication is good.
- Long-distance raw **WS2812/SK6812 LED data** is not recommended.

Therefore:
- keep long runs on RS-485,
- keep controller blocks close to the cells they control.

## Phase-1 hardware/software interaction model

- software chooses target cells,
- software chooses light colors,
- controller blocks execute light states,
- button events are sent back to the software,
- software remains the main source of truth for quantity and task state.
- the operator should be able to print reports directly from the system after selecting a timeframe.

## Open questions

- final LED type and mounting method,
- exact controller enclosure design,
- exact wire gauges and power injection strategy,
- whether phase 1 uses full button integration from day 1,
- exact printer type and connection method.