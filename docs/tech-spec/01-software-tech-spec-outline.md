# Software Technical Specification Outline

## Purpose

This document now acts as a lightweight technical baseline for the implemented phase-1 software and a checklist for future expansion.

## 1. Scope

- local-first warehouse inventory software
- operator pick and put workflows
- admin correction, reports, and product management
- simulated RS485 signaling through `stdout`
- hardware commissioning docs remain out of scope for this software-only pass

## 2. Users and roles

- operator permissions
- admin permissions
- owner-or-admin task correction rules
- future maintainer/service permissions

## 3. Functional requirements

### Authentication
- registration key validation
- login/logout
- session handling

### Inventory operations
- pick flow
- put flow
- partial completion
- adjustments
- final review screen for every task
- task reopening in correction mode with compensating transactions

### Product catalog
- create/search/edit products
- enforce required fields and validation rules
- store and edit `items per cell`
- show product-to-cell inventory visibility

### Allocation and placement
- pick allocation strategy
- put-away placement strategy
- strategy modularity and replacement rules
- support initial closest-cell-first logic and later similar-item clustering logic
- refill partially filled same-product cells before opening new cells
- allow final operator override even when that creates mixed or over-capacity cells

### Hardware control
- controller registration
- cell mapping
- LED control
- button event handling
- health monitoring
- development-time RS485 simulation

### Reporting
- report filters
- print formats
- launch-critical report set
- print support and printer integration
- configurable timeframe selection before printing
- quick preset buttons for common ranges

## 4. Non-functional requirements

- local reliability
- acceptable latency for UI and lights
- auditability
- recoverability after restart
- maintainability
- deployability on Raspberry Pi
- consistent UI behavior across operating systems by avoiding OS-native picker widgets

## 5. System architecture

- chosen architecture style
- module boundaries
- runtime diagram
- dependency rules
- current local web app deployment shape

## 6. Data model

Include tables/entities such as:
- users
- registration keys
- products
- cells
- zones
- controllers
- inventory balances
- tasks
- task lines
- transactions
- device events
- sessions

## 7. API / internal service contracts

Examples:
- auth APIs
- product search APIs
- task creation APIs
- controller command interfaces
- event ingestion interfaces
- recommendation preview/apply flows

## 8. Controller protocol specification

To be finalized later:
- command format
- event format
- addressing scheme
- retry behavior
- heartbeats

## 9. UI specification

- screen list
- field definitions
- validation rules
- navigation rules
- kiosk behavior
- modal product creation over the catalog view
- home screen search for both products and cells
- software-rendered searchable comboboxes

## 10. Error and exception handling

- stock mismatch
- unavailable cell
- hardware failure
- invalid user action
- recovery flows
- mixed-product and over-capacity warnings that still allow saving the real outcome

## 11. Security and audit

- password storage approach
- registration key handling
- role-based access
- immutable transaction logging
- edit permissions scoped to owner or admin

## 12. Deployment specification

- macOS development workflow
- GitHub branching/deployment workflow
- Raspberry Pi deployment model
- config management
- SQLite local data storage

## 13. Test strategy

- unit tests
- integration tests
- UI tests
- simulated hardware tests
- commissioning validation tests

## 14. Acceptance criteria

Examples:
- operator can complete a pick without manual DB edits
- operator can complete a put with auto-planned cell allocation
- admin can change `items per cell` and the next put uses the updated rule
- system can map cells accurately
- admin can generate reports for a selected time range or quick preset
- users can only edit their own tasks unless they are admins

## Decision backlog

These need to be decided before the detailed tech spec is complete:

1. Final Raspberry Pi packaging and service startup model
2. Hardware protocol format
3. Printer integration details
4. Future clustering strategy rules for similar items
5. Device-event behavior when controllers are partially offline
