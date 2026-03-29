# Cell Mapping and Commissioning Flow

## Goal

Map each physical LED/button position to the logical cell used by the software.

## Why this flow is critical

The software must know that a logical cell such as `Z1-R2-C14` corresponds to the correct physical location in the warehouse.

Without this mapping, lights may guide the operator to the wrong place.

## Recommended commissioning flow

1. Admin opens mapping mode
2. Admin chooses the target zone/controller block
3. System highlights one physical cell at a time
4. Admin confirms which logical cell that light corresponds to
5. System stores the mapping
6. Process continues until all cells are mapped
7. System runs a validation pass

## Recommended test modes

- light all cells sequentially
- light all cells in a block
- button test mode
- controller communication test
- save and reload mapping

## Data to store

- logical cell id
- zone id
- controller id
- hardware channel/address
- last mapping time
- mapped by user
- mapping status

## Failure handling

- if a light does not turn on, flag the cell as hardware issue
- if mapping is incomplete, block production use for that controller or clearly warn the admin

## Open questions

- Should mapping be cell-by-cell only, or also support batch mapping by known controller layout?
- Should the system support remapping while some inventory already exists in those cells?