# Analytics Flow

## Goal

Provide reports and operational insights from the inventory data stored by the system.

## Intended audience

- Admins
- Warehouse supervisors
- Upper management

## Report categories

### Inventory reports
- current stock by product
- current stock by cell
- low stock / zero stock visibility

### Movement reports
- picks by hour/day/week/month/year
- puts by hour/day/week/month/year
- net movement trends

### User activity reports
- actions by operator
- corrections by admin
- task completion counts

### Hardware / maintenance reports
- controller uptime/offline events
- failed cell tests
- mapping/commissioning activity

## Current software filters

- custom start and end datetime filters,
- quick presets for **last 1 hour**, **last 3 hours**, **last 6 hours**, **last 12 hours**, **last 24 hours**, **previous day**, **previous week**, **previous month**, and **all time**.

## Example report flow

1. Admin opens analytics screen
2. Admin selects report type and time range
3. System calculates the report from transactions and related entities
4. Report is displayed
5. Admin prints the report if required

## Recommended phase-1 outputs

- on-screen tables
- printable summary views
- configurable time-range selection before printing

## Launch importance

Reporting is a launch requirement, not just a later enhancement.

Recommended initial report set:
- current stock snapshot
- pick/put movement summary by time range
- user activity report
- exception/adjustment report
- recent task activity / activity report

All four should be treated as launch-priority reports.

Current software behavior:
- reports are generated on demand from transactions and tasks,
- time filtering uses fully qualified timestamp columns to avoid ambiguous report queries,
- the reports page stays admin-friendly by using clear preset buttons plus a manual range override,
- the selected datetime range is expected to update all range-sensitive report sections consistently, including team activity, recent activity, adjustments, and issue-focused task views.
