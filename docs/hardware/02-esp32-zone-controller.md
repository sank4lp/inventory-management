# ESP32 Zone Controller

## Purpose

This document describes the role of an ESP32-based controller block in the warehouse system.

It is intentionally written as a practical controller-box reference, not a final electrical schematic.

## Controller block role

Each ESP32 controller block should:
- receive commands from the Raspberry Pi side,
- control the lights for a group of cells,
- read button events from those cells,
- report acknowledgments and health back to the central software.

## Recommended phase-1 block size

- **27 cells per controller block**
- total pilot: **3 blocks** for 81 cells

## Locked phase-1 controller assumptions

- **3 LEDs per cell**
- **81 LEDs total per controller block**
- **27 buttons per controller block**
- **3 LED rows per controller block**
- **1 RS-485 node per controller block**
- **24V input with local 5V conversion**

## Recommended block components

### Core control
- 1 ESP32 development board or production equivalent

### Communication
- 1 RS-485 transceiver module/chip

### Button input expansion
- 2 GPIO expander devices such as MCP23017 or TCA9555 class devices

### LED control
- addressable RGB LEDs for phase 1
- 3 LED row outputs
- level shifting on LED data line
- one protection resistor per LED row
- one bulk capacitor per LED row power entry

### Power
- 24V input from central supply
- local buck converter to 5V
- local 3.3V as needed for ESP32 logic
- fuse or input protection ahead of the converter

## Recommended internal layout

Arrange the enclosure in 3 physical sections:

### Left side: field inputs
- 24V input terminal
- RS-485 in/out terminal

### Center: electronics
- fuse/protection
- buck converter
- ESP32
- RS-485 transceiver
- button expanders
- LED level shifter

### Right side: field outputs
- LED row terminals
- button input terminals

This layout makes troubleshooting easier because incoming power and bus wiring are separated from the field harnesses going out to the rack.

## Connection summary

### 1. Raspberry Pi to controller block
- Raspberry Pi communicates over RS-485
- controller block receives commands through its RS-485 interface

### 2. RS-485 interface to ESP32
- transceiver connects to ESP32 UART pins
- controller address or ID is assigned logically in software/protocol

### 3. ESP32 to LED rows
- ESP32 sends LED control data into a level shifter
- level shifter drives the LED data outputs
- use 3 row outputs so the controller can serve shorter LED chains
- each row is a 27-LED chain

### 4. Buttons to expander(s)
- cell buttons connect into input expansion hardware
- ESP32 polls or listens for changes over I2C or an equivalent local bus
- use 2 expanders so 27 buttons can be handled comfortably

### 5. Power distribution
- 24V comes into the block
- local converter generates 5V for LEDs and logic support
- controller board handles local protection and grounding strategy

## Suggested terminal naming

### Incoming terminals
- `24V_IN+`
- `24V_IN-`
- `RS485_A_IN`
- `RS485_B_IN`
- `RS485_GND_IN`
- `RS485_A_OUT`
- `RS485_B_OUT`
- `RS485_GND_OUT`

### LED row output terminals
- `ROW1_5V`
- `ROW1_GND`
- `ROW1_DATA`
- `ROW2_5V`
- `ROW2_GND`
- `ROW2_DATA`
- `ROW3_5V`
- `ROW3_GND`
- `ROW3_DATA`

### Button terminals
- `BTN_GND_COMMON`
- `BTN_01` through `BTN_27`

## Suggested button split

- expander 1: `BTN_01` to `BTN_16`
- expander 2: `BTN_17` to `BTN_27`

Keep the numbering stable inside the enclosure and map it to logical cell labels during commissioning.

## Suggested logical cell split

For a 9-column by 3-row controller block:

- row 1 cells use LED row 1
- row 2 cells use LED row 2
- row 3 cells use LED row 3

Example for Block 1:
- row 1: `Z1-R1-C01` to `Z1-R1-C09`
- row 2: `Z1-R2-C01` to `Z1-R2-C09`
- row 3: `Z1-R3-C01` to `Z1-R3-C09`

The same pattern applies to Blocks 2 and 3 with the correct column range.

## Internal wiring sequence

Build the controller box in this order:

1. mount all parts inside the enclosure
2. wire `24V input` to fuse/protection
3. wire fuse/protection to buck converter input
4. wire buck converter 5V output to LED power rail
5. wire buck converter 5V output to ESP32 power input
6. wire buck converter 5V output to level shifter supply
7. wire ESP32 communication pins to RS-485 transceiver
8. wire ESP32 I2C to both button expanders
9. wire ESP32 LED GPIO to the level shifter input
10. wire level shifter outputs to the 3 LED row data terminals
11. wire button input terminals to the expander inputs
12. label every terminal before connecting field wiring

## Cell-side wiring model

For each cell:
- 3 LEDs belong to that cell's row chain
- 1 button returns to the controller box input terminal

The LED chain should move cell by cell across the row, while buttons remain individual home-run signals back to the box.

## Recommended first-test sequence

Before connecting all 27 cells:

1. power the controller box alone
2. verify the buck converter output
3. verify ESP32 power-up
4. verify RS-485 communication
5. connect one short LED test chain
6. connect one test button
7. prove the design on the bench
8. then connect the real rack wiring

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
- avoid trying to distribute long-distance 5V LED power from the central station,
- keep block wiring local,
- use stable labels on all field harnesses,
- keep protocol idempotent where possible,
- include heartbeat/diagnostic support.

## Notes for the installer

- If one controller box works cleanly, copy that design for the other two blocks.
- Do not change terminal naming from one box to the next.
- Build for serviceability, not just for minimum wire length.
- Keep a printed terminal list inside or near the enclosure.

## Open implementation details

- final enclosure model,
- final fuse/protection parts,
- exact expander model,
- exact level shifter model,
- final command/event protocol format.
