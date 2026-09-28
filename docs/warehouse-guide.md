# Warehouse guide

Use **Work** for Pick, Put, assigned work, movement review and history. **Products** shows the catalog and product stock. **Locations** shows storage places and their contents. **Stocktaking** is the home for physical counts and count differences. **Reports** contains warehouse reports and printable results. Administrators have a separate **Settings** entry; profile and saved-device help are in the account menu.

## Pick and Put

Choose a product and quantity, then follow the location directions. At the location, select **I'm at this location**. Scan its label or use **Complete without scanning**. Check the actual quantity and select **Finish** only after moving the goods. Scanning, closing the camera and changing pages do not record a movement. Record zero only when nothing moved.

Saved physical reports remain on the device until a receipt arrives. Reconnect using the original account and retry saved reports. A changed assignment or uncertain movement may require a supervisor to verify the original evidence. Use **Record completed movement** for work already performed outside an active instruction; do not create a second task to record it again.

## Count stock

Open **Stocktaking**, then start or continue your assigned count. An administrator can create a warehouse-wide or selected-location count, assign counters, and configure weekly, monthly or custom schedules. Pausing a schedule leaves unfinished counts visible.

Identify each location using its QR label or its printed name/code. Count every product physically present. **Recorded on shelf** includes goods reserved for other work. Enter an actual quantity for each product; blank is not zero. Add another catalog product when needed, and describe unidentified goods without guessing their unit. Use **Save count and next** to retain the observation.

If goods are expired or damaged but still present, include them in the physical total and record the affected quantity separately. The location enters controlled review. This does not remove goods from the shelf or subtract them from the ledger.

A difference goes to review. An administrator checks the evidence and can approve a correction, request a recount, link an already-recorded movement, or leave the case unverified. If stock or its outstanding work changed during counting, a fresh count is required. Corrections retain the original observation and appear in **Adjustment Audit**. Late movement reports must be checked against these corrections to avoid recording the same change twice.

**Results and differences** shows counted, skipped and uncounted coverage, original quantities, reasons, people and movement references. Filters and printing use the same evidence. Historical counted quantities are not a live stock balance. Closing an incomplete count records its reason and incomplete coverage.

## Locate goods and show quantities

Open a product or location to see its quantities and choose the relevant display action. The warehouse-wide action is labelled **entire warehouse**. On shelf, reserved and available-to-pick are separate values.

Mixed-product locations require a product selection for a numeric display. Fractional and oversized quantities use locator guidance; the exact quantity stays on screen. A sent command does not prove that a physical light illuminated. Displays expire after a bounded period. Only their owner can stop them, and active work guidance takes priority.

Space suggestions are plans. Enter actual picked and actual put quantities separately after any physical work, including zero or partial results. Saving those results sends them for supervisor review; suggested quantities never change stock automatically. Use normal Pick and Put to reserve new work.

## Set up locations

An administrator opens **Settings → Location setup**. Check the controller and its declared outputs, define the location fields you need, and prepare unique QR stickers. For each output:

1. Light the selected output and physically find it.
2. Scan or enter the sticker at that location.
3. Enter a readable location name and required fields.
4. Confirm the physical check, then save and continue to the next output.

Skip an output that cannot be verified and retry it later. Continue later preserves the session; returning revalidates its ownership and controller configuration. A successful command alone does not mark a location physically verified. Duplicate, revoked and wrong-warehouse labels are rejected. Replacing a label is an explicit administrator action. Manual locations use their separate setup path.

Names, travel directions and configurable fields describe a location; they do not replace its stable identity or move its stock history. Existing locations missing a newly required field remain available for safe work and are flagged for completion. Print existing labels from Locations and prepare unbound stickers from Location setup.
