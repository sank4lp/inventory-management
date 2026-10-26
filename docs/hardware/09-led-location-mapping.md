# Map physical LEDs to locations

Open **Hardware → Controller health → Map locations** beside a controller. The same editor is available from **Manage Locations → Map LEDs to locations**.

1. Select the controller.
2. Press **Display LED number**. Each routed matrix displays its actual position in the physical chain for up to two minutes. Busy work or stocktake lights are preserved. Press again to hide the numbers.
3. Beside each LED, choose an existing location or type a new name. New names are created only when you press **Save** at the top. Required location fields appear for new locations.
4. Save the changes together. Navigating away with unsaved changes asks **“Unsaved changes would be lost. Continue?”**. Browser reload/close uses the browser’s standard warning.

**Locations → Add location** also offers a physical LED dropdown and **Display LED number**. Leave the selection as Manual location to create a cell without an LED.

Physical positions are read from the controller’s verified routing backup. An unknown or damaged backup blocks mapping and directs the installer to Edit controller. This screen changes location assignments; it does not change the physical LED count or controller routing.

## When a selected LED already has a location

- **Same location:** choose which name to keep. Renaming keeps stock, QR identity and history. If both names are already saved, an additional confirmation explains that the empty duplicate is archived and its QR label retired. The identity holding stock survives. Two stocked identities cannot be combined until their actual quantities have been reconciled.
- **Different locations, original cell empty:** save the new assignment. The original cell remains available as a manual location.
- **Different locations, original cell stocked:** review suggested destinations and quantities, or select custom destinations and split quantities. If space is insufficient, check and explicitly confirm a larger items-per-cell value, or choose other destinations. Create move tasks, complete the picks first, then the puts in My work. Return to the mapping page to save. No inventory is moved by saving the mapping or creating the tasks.

## Discard a move

Choose **View / discard move → Discard move**, then confirm.

An untouched move cancels its tasks, releases reservations, and keeps the existing mapping and inventory. A started move stops remaining picks and routes active or uncertain quantities through Needs review. The linked puts remain available to account for products already picked. Reconcile those quantities and complete or cancel the relevant remaining work before discarding again. Fully accounted movements remain in inventory and history; discarding does not reverse them.

Mapping saves, move creation and discard use saved request receipts. An unconfirmed request can be retried without duplicating locations or tasks. The editor rejects stale location/controller revisions, ambiguous assignments, active utility displays, outstanding warehouse work, and conflicting QR or stocktake activity.
