# Device Onboarding and Zone Management Flow

## Goal

Allow the software to register and manage hardware controller blocks such as ESP32 zone controllers.

## Why this flow matters

You want future scalability where the software itself can onboard and manage hardware zones.

That means the software should not treat the hardware as a fixed invisible layer.

## Core actions

- add a new controller block
- assign it to a zone
- define the logical cell range it controls
- verify communication
- run diagnostics
- disable/replace a controller

## Example onboarding flow

1. Admin opens device management screen
2. Admin selects “Add controller”
3. System asks for controller metadata such as:
   - controller ID / address
   - zone name
   - firmware version
   - expected cell range
4. System sends or validates a test command
5. Controller responds with heartbeat/acknowledgment
6. Admin saves the controller record

## Device health concepts

Each controller should ideally expose:
- online/offline state
- last heartbeat time
- firmware version
- recent error status
- last test result

## Open questions

- Will controller addresses be manually assigned or auto-discovered?
- What minimum diagnostics are needed at launch?