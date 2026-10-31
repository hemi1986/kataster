# Worked example: `/shape` on a delivery initiative

A neutral example, used to test the format. The repository is an adopted shop with two contexts:

- `BC-Ordering` – `AGG-Order`, commands to place and cancel an order.
- `BC-Delivery` – `AGG-Delivery`, delivery windows, routes.
- `BC-Notification` – generic outbound messages (order confirmation, password reset).

The idea: *"Customers should be able to move a delivery to another day from the order page, and operations should
be warned automatically when a route is delayed."*

This is bigger than one feature: it touches two contexts, adds a time-based policy, needs a carrier integration and
probably a schema change. So `/shape` is the right entry point.

---

## The brief

```markdown
---
status: accepted
created: 2026-10-31
source: ""
promoted: ""
---

# Initiative: Delivery rescheduling and delay alerts

## Problem & outcome

Customers with a missed or inconvenient delivery window have to call support; support has no tool to move a
delivery, so it cancels and re-orders. Operations learns about a delayed route from the carrier's portal, often
after the customer has called.

Outcome: a customer can move a delivery to another available day from the order page, and operations is warned
before the customer notices. Success: reschedule requests handled without support contact; delayed deliveries
communicated before the first inbound call.

## Fit with the vision

Fits the vision ("perishable goods arrive when promised"). It does not change the vision, but it makes the delivery
promise a first-class part of the product instead of an operational detail. No non-goal is touched.

## Placement

| Capability | Context | New/existing | Why | Confidence |
|---|---|---|---|---|
| Move a delivery to another day | BC-Delivery | existing | Same language (delivery window, cut-off), same invariants; the change is additive to `AGG-Delivery` | high |
| Cut-off rules per product category | BC-Delivery | existing | A policy on the same aggregate; no new language | medium |
| Warn operations about a delayed route | BC-Delivery + BC-Notification | existing | The delay is a delivery fact; the message is a notification. Reuse the generic context instead of inventing a communication domain | medium |
| Carrier delay feed | BC-Delivery | existing | The carrier is an external system already known to delivery, not a new context | low (API unknown) |

Alternative considered: a new `BC-Delivery-Communication` for carrier messages and customer notifications. Rejected
for now: it duplicates `BC-Notification` and adds a consistency boundary without a new invariant. Revisit only if
carrier messages need their own lifecycle and retention rules.

## Impact – change vs. build new

| Dimension | Change | New | Evidence |
|---|---|---|---|
| Domain | `AGG-Delivery` gains a reschedule command and an invariant (no move after cut-off); `EVT-DeliveryRescheduled`; policy on `EVT-RouteDelayed` | `CMD-RescheduleDelivery`, `POL-NotifyDelayedDelivery`, `RM-CustomerDeliveryStatus` | `docs/domain/events.yaml`, `context-map.md` |
| Code | `services/delivery` (command, policy), `apps/shop` (order page), `libs/notifications` (template) | carrier adapter in `services/delivery`, new migration | `repo-map.md` consumers |
| Interfaces | order page gains a reschedule flow; ops dashboard gains a delay banner | carrier webhook/job (depending on the API) | `ux-guidelines.md` |
| Data | `delivery` gets a reschedule history; no backfill for existing rows | `delivery_reschedule` table or event-sourced history | `data-model.md` |
| Rules | reschedule must respect the cut-off and the delivery window; notification only for affected customers | permission: customer may only move their own delivery | `boundaries.yaml` |
| Tests | command test for reschedule, policy test for delay, page test for the flow | characterization test for the carrier adapter | seam catalog in `conventions.md` |
| Ops | new scheduled check for delays; monitoring for failed carrier calls | configuration for cut-off per category | profile, ADRs |

## Slices

1. **Move a delivery (existing context).** Customer opens the order, sees available days, moves the delivery.
   Value: fewer support calls. 3–4 stories, S/M. Confidence: high/medium.
2. **Delay alert for operations.** Carrier feed → `EVT-RouteDelayed` → policy → notification. Value: proactive
   communication. 2–3 stories + 1 spike on the carrier API. Confidence: low until the spike.
3. **Cut-off rules per category.** Time-based policy and configuration. Value: fewer impossible moves. 2 stories.
   Confidence: medium.

## Rough cost

| Currency | Estimate | Confidence | Basis |
|---|---|---|---|
| Scope | 7–10 stories across 3 slices | medium | 1 changed aggregate, 1 new command, 1 new event, 1 new policy, 1 new read model, 1 page flow, 1 migration, 2 packages, 1 integration |
| Range | Slice 1: 1–2 weeks with one developer; slice 2: 2–4 weeks including the spike; slice 3: 3–5 days | low/medium | story sizes, not person-day precision |
| Risk | Carrier API availability/rate limits; cut-off rules differ per category; notification channel (email vs. SMS) undecided | – | open questions below |

What would raise confidence: a one-day spike against the carrier sandbox (slice 2), and a decision on the cut-off
owner (slice 3). No estimate is given for a full rollout to all categories.

## Risks & open questions

- Is rescheduling free, or does it depend on the product category and the delivery window?
- Who owns the cut-off configuration – operations or product?
- Does the carrier expose a webhook, or only a polling API? Rate limits?
- What happens to a delivery that is already on the route when the customer reschedules?
- Do we need an audit trail for moves (support, disputes)?

## Recommendation

**Go with slice 1.** It is additive, uses the existing delivery language, and delivers value without the carrier
integration. Run the carrier spike before committing to slice 2. Park slice 3 until slice 1 is live and the cut-off
rules are confirmed.
```

---

## What the example demonstrates

- **Placement is a recommendation with an alternative**, not a verdict. The user can still choose the new context.
- **Change vs. build new is explicit** – the table would be useless if it only listed new work.
- **Cost is a range with a basis**, and the basis uses the toolkit's own artifacts (aggregate, command, event,
  policy, read model, page, migration, packages, integration).
- **The decision is one line** and it is not "do everything".
- **No stories were created.** Slice 1 goes to `/feature`, which creates the stories and runs the review.
- **Unknowns stay visible** – the carrier API is a spike, not an assumed success.
