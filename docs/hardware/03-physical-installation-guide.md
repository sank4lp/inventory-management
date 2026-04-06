# Physical Installation Guide

## Purpose

This document is the practical step-by-step guide for physically assembling the phase-1 hardware.

It is written so that you can use it during installation without needing to interpret the higher-level hardware docs.

## Locked installation baseline

- 81 total cells
- 3 controller blocks
- 27 cells per controller block
- 3 LEDs per cell
- 1 push button per cell
- RS-485 used for controller communication
- 24V distributed to controller blocks
- 5V generated locally in each controller block

## Before you start

Make sure you have these major parts available:
- Raspberry Pi
- display
- keyboard and mouse
- printer
- USB-to-RS485 adapter
- 3 ESP32 boards
- 3 RS-485 transceiver modules
- 6 button expander devices
- 3 LED data level shifters
- 3 buck converters for 24V to 5V conversion
- 81 cell buttons
- 243 addressable LEDs total
- one 24V power supply
- RS-485 cable
- separate 24V power cable
- controller enclosures
- terminal blocks, connectors, fuses, mounting hardware

## Installation order

Follow the installation in this order:

1. Build and place the central station.
2. Mark the 3 controller block zones on the rack.
3. Mount the controller enclosures.
4. Run the RS-485 communication bus.
5. Run the 24V power distribution cable.
6. Build and wire one controller block fully.
7. Wire its 27 cells.
8. Repeat for the remaining 2 controller blocks.
9. Perform power-off continuity checks.
10. Power on one block at a time and test.

## Step 1: Build the central station

At the warehouse entry, place:
- Raspberry Pi
- display
- keyboard and mouse
- printer

Plug them together like this:
- Raspberry Pi HDMI → display
- Raspberry Pi USB → keyboard/mouse
- Raspberry Pi USB or network → printer
- Raspberry Pi USB → USB-to-RS485 adapter

Do not connect the rack-side field wiring to the Raspberry Pi until the RS-485 and power cables are clearly labeled.

## Step 2: Mark controller coverage on the rack

Label the rack into these 3 controller blocks:
- Block 1: columns 1 to 9 across rows 1 to 3
- Block 2: columns 10 to 18 across rows 1 to 3
- Block 3: columns 19 to 27 across rows 1 to 3

Each controller block should be mounted physically close to the cells it controls.

Do not place a controller far away and run long LED data wires across the rack.

## Step 3: Mount each controller enclosure

Mount one enclosure per block.

Each enclosure should be placed:
- close to the center of its 27 cells,
- accessible for servicing,
- away from accidental impact,
- in a position where the field wiring can enter cleanly.

Recommended enclosure sections:
- left side for incoming RS-485 and 24V
- center for converter and controller electronics
- right side for outgoing LED and button field wiring

## Step 4: Run the RS-485 bus

Run the RS-485 cable in one continuous daisy-chain:

Raspberry Pi adapter → Block 1 → Block 2 → Block 3

Do not wire RS-485 in a star layout.

At each controller enclosure:
- bring in `RS485_A`
- bring in `RS485_B`
- bring in `RS485_GND` or communication common
- pass the same lines out to the next block

If your transceiver hardware requires termination:
- terminate only at the 2 physical ends of the bus
- do not add termination at the middle controller

If the cable includes shield:
- bond the shield at one end only
- keep the shield handling consistent across the whole run

## Step 5: Run the 24V power distribution

Run a separate 24V power cable from the power supply to the controller blocks.

Recommended physical approach:
- central 24V supply at the station or a protected nearby location
- 24V distributed to each controller block
- local 24V-to-5V conversion inside each controller box

Do not use the RS-485 cable as the main LED power cable.

At each controller box:
- bring in `24V+`
- bring in `24V-`
- route these first through protection and then into the local buck converter

## Step 6: Build one controller box

For one controller box, install these internal parts:
- ESP32 board
- RS-485 transceiver
- 2 button expanders
- 1 LED level shifter
- 1 buck converter
- fuse or protection hardware
- terminal blocks for LED and button field wiring

### Internal power flow

Wire power in this order:

1. `24V input` → fuse/protection
2. fuse/protection → buck converter input
3. buck converter 5V output → LED 5V rail
4. buck converter 5V output → ESP32 board power input
5. buck converter 5V output → LED level shifter supply
6. ESP32 logic rail → RS-485 transceiver logic side
7. ESP32 logic rail → both button expanders

### Internal communication flow

Wire signals in this order:

1. RS-485 `A/B/GND` → RS-485 transceiver
2. ESP32 UART pins → RS-485 transceiver logic pins
3. ESP32 I2C pins → button expander 1
4. same I2C bus → button expander 2
5. ESP32 LED data GPIO → level shifter input
6. level shifter outputs → LED row data terminals

## Step 7: Split the 27 cells into 3 LED rows

For physical simplicity, split each controller block into:
- Row 1 LED chain: 27 LEDs
- Row 2 LED chain: 27 LEDs
- Row 3 LED chain: 27 LEDs

This gives you 3 shorter LED chains instead of one long 81-LED chain.

For each row, provide these terminals:
- `ROWx_5V`
- `ROWx_GND`
- `ROWx_DATA`

Example:
- `ROW1_5V`, `ROW1_GND`, `ROW1_DATA`
- `ROW2_5V`, `ROW2_GND`, `ROW2_DATA`
- `ROW3_5V`, `ROW3_GND`, `ROW3_DATA`

## Step 8: Wire the LEDs for one cell

Each cell has 3 LEDs.

Repeat this same pattern for every cell in the row:

1. connect 5V from the row power line to the first LED
2. connect GND from the row ground line to the first LED
3. connect the row data line to the first LED of the first cell in that row
4. chain data from LED 1 to LED 2 inside the same cell
5. chain data from LED 2 to LED 3 inside the same cell
6. continue data out from the third LED to the first LED of the next cell

That means each row becomes one continuous 27-LED chain.

## Step 9: Add LED protection parts

At the entry point of each LED row, add:
- one electrolytic capacitor across 5V and GND
- one resistor in series with the data line near the first LED

Do this once per LED row, not once per cell.

## Step 10: Wire the buttons for one controller block

Each cell has one push button.

Use a simple repeated pattern:
- one side of every button → common ground
- other side of each button → one button expander input

Suggested split:
- expander 1 handles buttons 1 to 16
- expander 2 handles buttons 17 to 27

Label each wire with the logical cell it belongs to.

Example labels:
- `BTN-Z1-R1-C01`
- `BTN-Z1-R1-C02`
- `BTN-Z1-R2-C14`

## Step 11: Label every terminal and harness

Labeling will save a lot of time later.

At minimum, label:
- each controller box
- RS-485 in and out
- 24V in
- each LED row output
- each button harness
- each cell branch if the harness fans out near the rack

Use logical cell labels, not temporary installer shorthand.

## Step 12: Perform pre-power checks

Before applying power:
- verify 24V polarity
- verify 5V output polarity from the buck converter
- verify there is no short between 5V and GND
- verify there is no short between 24V and GND
- verify RS-485 A and B are consistent from box to box
- verify button common ground is continuous
- verify LED row data is connected in the intended direction

Do not power all 3 controller blocks at once for the first test.

## Step 13: First power-on sequence

Power on in this order:

1. Raspberry Pi only
2. one controller block only
3. confirm the controller powers up cleanly
4. confirm the buck converter output is correct
5. test RS-485 communication
6. test one LED row
7. test one button
8. test all LEDs in the block
9. test all buttons in the block

Only after one block is stable should you power on the next block.

## Step 14: Recommended commissioning order

For each controller block:

1. verify power
2. verify RS-485 communication
3. verify controller identity
4. test LED row 1
5. test LED row 2
6. test LED row 3
7. test button inputs
8. map logical cells to physical cells
9. repeat for the next block

## Practical installation notes

- Keep the controller box close to its cells.
- Keep LED data runs short.
- Prefer clean harness routing over the shortest possible path.
- Keep RS-485 and power entry easy to service.
- Do not mix up logical cell names and physical wiring labels.
- Build and prove one block first, then copy the same pattern to the other two blocks.

## What this guide does not replace

This guide is a physical installation guide, not:
- a final electrical safety sign-off,
- a certified wiring diagram,
- a substitute for checking the ratings of the exact parts you buy.

For controller-box internals and signal roles, also read `02-esp32-zone-controller.md`.
