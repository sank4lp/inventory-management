# ESP32 Zone Controller

## Purpose

This document describes the role of an ESP32-based controller block in the warehouse system.

It is intentionally written as a working design reference, not a final electrical schematic.

## Controller block role

Each ESP32 controller block should:
- receive commands from the Raspberry Pi side,
- control the lights for a group of cells,
- read button events from those cells,
- report acknowledgments and health back to the central software.

## Recommended phase-1 block size

- **27 cells per controller block**
- total pilot: **3 blocks** for 81 cells

## Recommended block components

### Core control
- 1 ESP32 development board or production equivalent

### Communication
- 1 RS-485 transceiver module/chip

### Button input expansion
- GPIO expander hardware such as MCP23017 or TCA9555 class devices

### LED control
- low-power addressable RGB LED chain/modules for phase 1
- level shifting on LED data line if required

### Power
- 24V input from central supply
- local buck converter to 5V
- local 3.3V as needed for ESP32 logic

## Connection summary

### 1. Raspberry Pi to controller block
- Raspberry Pi communicates over RS-485
- controller block receives commands through its RS-485 interface

### 2. RS-485 interface to ESP32
- transceiver connects to ESP32 UART pins
- controller address or ID is assigned logically in software/protocol

### 3. ESP32 to LED line
- ESP32 sends light-control data to the LED chain/modules
- if using addressable LEDs, one data path may control many cell indicators

### 4. Buttons to expander(s)
- cell buttons connect into input expansion hardware
- ESP32 polls or listens for changes over I2C or an equivalent local bus

### 5. Power distribution
- 24V comes into the block
- local converter generates 5V for LEDs and logic support
- controller board handles local protection and grounding strategy

## Software-facing responsibilities

The software should treat the controller block as a device capable of:
- setting cell color/state,
- clearing cell state,
- entering test mode,
- reporting button press events,
- reporting heartbeat/health.

## Recommended protocol concepts

This is still conceptual, but commands will likely need fields such as:
- zone/controller id
- cell id or hardware channel
- action type
- color/state
- correlation or task id

Likewise, events should likely include:
- controller id
- cell id
- event type
- timestamp or sequence information

## Reliability notes

- avoid long raw LED data runs from ESP32 to distant cells,
- keep block wiring local,
- keep protocol idempotent where possible,
- include heartbeat/diagnostic support.

## Open questions

- exact LED hardware family for the first prototype,
- exact expander count per block,
- whether custom PCBs or modular dev boards will be used,
- final command/event format.