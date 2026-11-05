# Warehouse guide

Use **Work** for Pick, Put, assignments, review and history; **Products** for the catalog; **Locations** for cells and their contents; **Stocktaking** for physical counts; and **Reports** for warehouse results. Settings and actions depend on your current role permissions, including custom roles.

## Pick and Put

1. Open **My Work** and start or resume an assignment, or choose **Pick stock** / **Put stock** to create work. Check the product, quantity and any preferred location.
2. Select a location tile. Starting or resuming lights the planned location before arrival. Opening a paused task alone does not resume it.
3. At the cell, choose **I'm at this location**. Scan its QR or use the without-scanning confirmation. Check the actual location and quantity; both are editable. Confirm any difference when asked.
4. Select **Complete Pick at this location** or **Complete Put at this location** only after moving the goods. Inventory updates for that cell immediately. Scanning or closing the camera alone does not record stock.
5. Continue through the cells. Completed work with the assigned total closes automatically. Short totals or rejected unfinished work require review. A valid location-only change with the same total does not itself require supervisor review.

Leaving the task pauses your work and clears its guidance. **Resume** checks availability and relights it. **Cancel this location** records a reason for an unfinished subtask. **Stop remaining work** lets you check the recorded state, correct actual location/quantity rows if needed, and close valid work or send uncertainty for review. Closing releases the remaining reservations.

**On shelf** is physical stock recorded in the system. Reservations belong to tasks; they are not extra stock. Planning can displace eligible unstarted or review work, but protects active work. Resolve any displayed stock, capacity or cell-ownership error before proceeding.

## Assign and review work

Use **Assign Work** to select Pick/Put, product, quantity, assignee and deadline. **Active Assignments** supports permitted edits to unstarted work; save changed rows before leaving. Operators see their own work; roles with team access can see team work.

In **My Work**, use **See only review items**, then **Review**:

- **Align With Actual Physical Movement**: enter verified actual totals by location, then save and close. Invalid movements show an error and keep the dialog open.
- **Update Assignment of the task**: assign the outstanding quantity and deadline using the offered workflow.
- **Discard**: accept the currently recorded state and close remaining work after confirmation. This releases reservations; it does not undo stock already moved.

Use **History** for task summaries and **Task History** for timestamped actions. **Record Movement** is for valid physical work already done outside a task; saving its Pick/Put rows updates inventory immediately. Do not record the same movement twice.

## Count stock

1. Open **Stocktaking**. Choose **Whole Warehouse**, **Shed/shelf** or **Product**, then select the scope, counters and deadline. For one cell, start from **Locations → Stocktake at this location**.
2. Open the stocktake and check its summary. Confirm **Start Stock Take** or **Resume** to light the selected area. Several counters may share an area and claim different cells.
3. Select a location tile, scan its QR, or identify it manually. Pending cells show yellow; the cell actively being counted shows orange; counted cells show blue on the LEDs. Completed on-screen tiles use light green.
4. Count the products physically present. Enter each actual quantity, including zero when none remain. Add another catalog product if needed. A blank entry is not zero. Reserved goods still count as physically present.
5. Choose **Update Counts**, or accept the existing counts when correct. Valid corrections update inventory immediately with an audit trail. The next location opens automatically; completing one cell does not pause the run.

If stock, units or other relevant work changed while counting, follow the request for a fresh count. Unidentified goods and condition issues may still need review. Expired or damaged goods that remain in the cell belong in its physical total; record their condition separately. A condition record does not dispose of goods.

Only the actively counted cell is held for that counter. Pick/Put may use other eligible cells; active work guidance takes precedence over the count display.

**Pause Stock Take** or leaving the page saves your progress and releases your active cell. Others continue. When all counters leave, the run pauses and its lights clear. Managers can **Stop Stock Take**, retaining progress but removing its assignments; a stopped run can be resumed with updated assignments and a deadline. Completion clears count guidance and removes the work from every assignee's My Work list. **Previous Stocktakes** retains progress, dates and results. Historical counts are not the current stock balance.

## Locate goods and show quantities

**Locate** identifies a cell; **Ping** briefly tests its light. **Show Quantity**, **Show Available Capacity** and **Show items per location** display the corresponding figures without changing inventory. **Show all quantities in this IMS** covers mapped cells across the installation. Warehouse and shelf controls limit their display to that group.

Mixed-product quantity displays alternate between products. The screen retains exact quantities when a value cannot be represented on the matrix. An override of active Pick/Put guidance requires the displayed confirmation; ending the temporary display restores eligible prior guidance. A sent command alone does not prove the physical light illuminated.

## Set up locations and import Excel

In **Settings → Hardware → Manage Locations**, add a location's name, warehouse, shed/shelf and physical LED mapping. Select an existing shed or add a new one. Use the LED-number display to verify the output. An output cannot belong to two active locations.

For walk-around setup, open **Set up locations**, select an LED tab, check its light, enter the details and **Save and next light**. Choose **Assign QR later** if the device has no camera. Skip unverified outputs and continue their setup later.

Assign or update a sticker in **Manage Locations**. Customer-created QR codes are supported. If a QR belongs to another cell, correct that original cell's identity before transferring the code. Changing a location name does not move its stock or history.

Download the sample **Warehouse Excel** file, retain both sheets and fill in mappings and stock. During import, resolve unknown names to existing locations/products or explicitly confirm new ones. Imported stock differences create count work for the affected product/location pairs; they do not silently overwrite stock. Routine controller health checks do not invalidate an import review, but relevant stock or configuration changes require a new review.

## Saved requests and backups

A request saved on a device is not yet a confirmed warehouse update. Keep the same device and original account, reconnect and check the recorded result before retrying or moving anything again. Completed stocktakes and acknowledged count requests no longer leave live pending reminders in the bell; historical action messages remain available until dismissed.

Each successful backup refreshes the mapping/stock workbook. If the workbook is unavailable, create a backup first. Use the full warehouse backup—not the Excel workbook—to restore users, history, settings and installation data. See [Pi installation and recovery](pi-test-installer.md) for the offline kit, replacement Pi and recovery-password steps.
