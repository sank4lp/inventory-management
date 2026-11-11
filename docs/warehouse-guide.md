# Shed guide

Use **Work** for Pick, Put, assignments, review and history; **Products** for the catalog; **Locations** for bins and their contents; **Stocktaking** for physical counts; and **Reports** for shed results. Settings and actions depend on your current role permissions, including custom roles.

## Pick and Put

1. Open **My Work** and start or resume an assignment, or choose **Pick stock** / **Put stock** to create work. Check the product, quantity and any preferred location.
2. Select a location tile. Starting or resuming lights the planned location before arrival. Opening a paused task alone does not resume it.
3. At the bin, choose **I'm at this location**. Scan its QR or use the without-scanning confirmation. Check the actual location and quantity; both are editable. Confirm any difference when asked.
4. Select **Complete Pick at this location** or **Complete Put at this location** only after moving the goods. Inventory updates for that bin immediately. Scanning or closing the camera alone does not record stock.
5. Continue through the bins. Completed work with the assigned total closes automatically. Short totals or rejected unfinished work require review. A valid location-only change with the same total does not itself require supervisor review.

Leaving the task pauses your work and clears its guidance. **Resume** checks availability and relights it. **Cancel this location** records a reason for an unfinished subtask. **Stop remaining work** lets you check the recorded state, correct actual location/quantity rows if needed, and close valid work or send uncertainty for review. Closing releases the remaining reservations.

**On rack** is physical stock recorded in the system. Reservations belong to tasks; they are not extra stock. Planning can displace eligible unstarted or review work, but protects active work. Resolve any displayed stock, capacity or bin-ownership error before proceeding.

## Assign and review work

Use **Assign Work** to select Pick/Put, product, quantity, assignee and deadline. **Active Assignments** supports permitted edits to unstarted work; save changed rows before leaving. Operators see their own work; roles with team access can see team work.

In **My Work**, use **See only review items**, then **Review**:

- **Align With Actual Physical Movement**: enter verified actual totals by location, then save and close. Invalid movements show an error and keep the dialog open.
- **Update Assignment of the task**: assign the outstanding quantity and deadline using the offered workflow.
- **Discard**: accept the currently recorded state and close remaining work after confirmation. This releases reservations; it does not undo stock already moved.

Use **History** for task summaries and **Task History** for timestamped actions. **Record Movement** is for valid physical work already done outside a task; saving its Pick/Put rows updates inventory immediately. Do not record the same movement twice.

## Count stock

1. Open **Stocktaking**. Choose **Whole Shed**, **Rack** or **Product**, then select the scope, counters and deadline. For one bin, start from **Locations → Stocktake at this location**.
2. Open the stocktake and check its summary. Confirm **Start Stock Take** or **Resume** to light the selected area. Several counters may share an area and claim different bins.
3. Select a location tile, scan its QR, or identify it manually. Pending bins show yellow; the bin actively being counted shows orange; counted bins show blue on the LEDs. Completed on-screen tiles use light green.
4. Count the products physically present. Enter each actual quantity, including zero when none remain. Add another catalog product if needed. A blank entry is not zero. Reserved goods still count as physically present.
5. Choose **Update Counts**, or accept the existing counts when correct. Valid corrections update inventory immediately with an audit trail. The next location opens automatically; completing one bin does not pause the run.

If stock, units or other relevant work changed while counting, follow the request for a fresh count. Unidentified goods and condition issues may still need review. Expired or damaged goods that remain in the bin belong in its physical total; record their condition separately. A condition record does not dispose of goods.

Only the actively counted bin is held for that counter. Pick/Put may use other eligible bins; active work guidance takes precedence over the count display.

**Pause Stock Take** or leaving the page saves your progress and releases your active bin. Others continue. When all counters leave, the run pauses and its lights clear. Managers can **Stop Stock Take**, retaining progress but removing its assignments; a stopped run can be resumed with updated assignments and a deadline. Completion clears count guidance and removes the work from every assignee's My Work list. **Previous Stocktakes** retains progress, dates and results. Historical counts are not the current stock balance.

## Locate goods and show quantities

**Locate** identifies a bin; **Ping** briefly tests its light. **Show Quantity**, **Show Available Capacity** and **Show items per location** display the corresponding figures without changing inventory. **Show all quantities in this IMS** covers mapped bins across the installation. Shed and rack controls limit their display to that group.

Mixed-product quantity displays alternate between products. The screen retains exact quantities when a value cannot be represented on the matrix. An override of active Pick/Put guidance requires the displayed confirmation; ending the temporary display restores eligible prior guidance. A sent command alone does not prove the physical light illuminated.

## Set up locations and import Excel

In **Settings → Hardware → Manage Locations**, add a location's name, shed, rack and physical LED mapping. Select an existing rack or add a new one. Use the LED-number display to verify the output. An output cannot belong to two active locations.

For walk-around setup, open **Set up locations**, select an LED tab, check its light, enter the details and **Save and next light**. Choose **Assign QR later** if the device has no camera. Skip unverified outputs and continue their setup later.

Assign or update a sticker in **Manage Locations**. Customer-created QR codes are supported. If a QR belongs to another bin, correct that original bin's identity before transferring the code. Changing a location name does not move its stock or history.

Download the sample **Shed Excel** file, retain both sheets and fill in mappings and stock. During import, resolve unknown names to existing locations/products or explicitly confirm new ones. Imported stock differences create count work for the affected product/location pairs; they do not silently overwrite stock. Routine controller health checks do not invalidate an import review, but relevant stock or configuration changes require a new review.

## Reports

Open **Reports** and choose a report from the library. Each new report supports a **Section (cos_sec)** filter, **Download CSV** and **Print**. Wide tables scroll horizontally on phones.

- **Section Stock** shows the current physical quantity for each product and MPI status. Reserved items remain part of physical stock. Totals stay separate by unit.
- **Range & Depth — Products** counts a Section + Part Number once across its MPI statuses. Depth is the counted quantity, with an MPI breakdown. **Range & Depth — MPI Variants** counts and displays each MPI status separately. Choose the stocktake; its results page also links to both reports. Range includes products counted above zero. Incomplete stocktakes show only confirmed bins and are labelled **Partial**. Saved quantities do not change when stock moves later. Older counts may use current product labels where historical labels were not saved.
- **Product Movement** classifies **Put + Pick** quantities actually recorded, including completed parts of unfinished tasks. Choose Day, Week, 15 days, Month or 3 months. Use **Set** beside a product to enter its **Slow below** and **Fast above** thresholds for that period; both boundary values are Normal. For 10 and 100: below 10 is Slow, 10–100 is Normal, above 100 is Fast. Products without thresholds show **Not configured**. Editing thresholds requires product-edit permission. Reservations and stocktake adjustments do not count as movements; corrections to task movements adjust their totals.
- **Customer Movement** groups voucher-linked movement by Customer (`cust`), Customer Code (`cust_code`) and Sus Number (`sus_no`). Search using any of these identifiers. Voucher quantities and actual recorded quantities are separate. Click a voucher or task for its details. UNS received lines remain visible with no Put movement. Conflicting customer identities are flagged and kept separate.

Operators see their permitted work and stocktake bins; team permissions allow the corresponding team records. Reports never change inventory. Movement thresholds are saved in the database and included in backups.

## Saved requests and backups

A request saved on a device is not yet a confirmed shed update. Keep the same device and original account, reconnect and check the recorded result before retrying or moving anything again. Completed stocktakes and acknowledged count requests no longer leave live pending reminders in the bell; historical action messages remain available until dismissed.

Each successful backup refreshes the mapping/stock workbook. If the workbook is unavailable, create a backup first. Use the full shed backup—not the Excel workbook—to restore users, history, settings and installation data. See [Pi installation and recovery](pi-test-installer.md) for the offline kit, replacement Pi and recovery-password steps.
