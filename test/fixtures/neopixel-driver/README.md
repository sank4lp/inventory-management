# NeoPixel ESP32 regression fixture

`esp-1.12.3.c` and `esp-1.12.4.c` are unmodified upstream Adafruit NeoPixel
files, retaining their Apache 2.0 notices. Official release:
https://github.com/adafruit/Adafruit_NeoPixel/releases/tag/1.12.4

The official Arduino library archive for 1.12.4 has SHA-256:
`500c197880177c243f47a318815df9203a8541f30044ba5573151a024e937081`.
The fixed `esp.c` hash is enforced during release preparation.

The test compiler rejects the old ESP-IDF 5 variable-length stack allocation,
then compiles and executes the actual fixed driver using peripheral/mutex
stubs. This tests allocation and pulse encoding; it does not simulate actual
ESP32 heap capacity, electrical LED timing, USB hardware or RMT interrupts.
The package's four-matrix ESP32 build is compiled separately with its pinned
ARM64 SDK. Physical flash/display verification remains required.
