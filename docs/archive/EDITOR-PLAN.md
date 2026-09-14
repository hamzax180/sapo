# Souqi Visual Editor — Rebuild Plan (bug-free, easier, works on phone / laptop / iPad)

> **Goal:** turn the "Edit Visually" storefront builder into a tool that is **reliable, genuinely easy, and fully usable on touch (phone + iPad) and desktop**. Today it is powerful but desktop-mouse-only, non-responsive, and fragile.
>
> This plan is grounded in the current code: `public/js/portals/live-editor.js` (2,176 lines), `public/css/portals/live-editor.css` (1,062 lines, **0 media queries**), `public/js/portals/blocks.js`, `canvas-block.js`, `generic-renderer.js`.

---

## 0. Why it feels buggy and unfriendly (current-state findings)

Ranked by impact. Each is a real thing in the code, not a guess.

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 1 | 🔴 P0 | **Touch doesn't work.** Every interaction is mouse-only: `mousedown/mousemove/mouseup`, plus HTML5 drag-and-drop (`draggable`, `dataTransfer`). None of this fires reliably on touch, and HTML5 DnD is unsupported on mobile Safari/Chrome. So on **phone/iPad you can't drag, resize, reposition, or use the drag handles at all.** | `live-editor.js` event audit: only mouse/DnD listeners; `beginElementDrag`, `onHandleMouseDown`, `onInlineElementMouseDown`, `onDragStart/onDrop` |
| 2 | 🔴 P0 | **No responsive editor UI.** The stylesheet has **zero `@media` queries**. The bottom command pill, the centered floating panels, and the property toolbar are sized for a wide screen and overflow / overlap / become untappable on small screens. | `grep @media live-editor.css` → none; `.le-panel{position:fixed;bottom:24px;left:50%…}` |
| 3 | 🟠 P1 | **Free-form absolute canvas is the core fragility.** "Eject to canvas" converts a block into absolutely-positioned elements with pixel `x/y/w/h/z`, and keeps **separate manual `desktop` and `mobile` rects** per element. Absolute pixels don't reflow → overlaps, clipping, and you must hand-place every element twice. | `ejectBlockToCanvas`, `applyBreakpointPreview`, `promoteMobileRect`, `el.desktop`/`el.mobile` |
| 4 | 🟠 P1 | **No iPad breakpoint.** Only `desktop` and `mobile` exist, so tablet layouts are whatever desktop happens to squeeze into — which is exactly the "looks weird on iPad" symptom. | `activeBreakpoint = "desktop" \| "mobile"` |
| 5 | 🟠 P1 | **Work can be lost.** No autosave, no dirty-tracking, no "unsaved changes" guard on navigation. Only a manual **Publish**. Close the tab or let the 15-min edit token expire and edits are gone. | `grep autosave\|beforeunload\|isDirty` → 0; token TTL 15m |
| 6 | 🟡 P2 | **Floating toolbar drifts.** It's positioned once from `getBoundingClientRect()`; it doesn't reposition on scroll/resize and can render off-screen; on mobile it overflows the viewport. | `positionToolbar` (no scroll/resize handler) |
| 7 | 🟡 P2 | **Brittle inline editing.** Raw `contentEditable` + deprecated `execCommand`; pasted HTML isn't sanitized; caret/selection handling is manual. | `startDirectEdit`, `captureInlineHtml`, `execCommand` |
| 8 | 🟡 P2 | **One 108 KB file.** All concerns (boot, selection, DnD, panels, canvas, publish) live in one module — hard to fix safely, easy to regress. | `live-editor.js` 2,176 lines |
| 9 | 🟡 P2 | **Select-vs-navigate conflict.** Clicks are intercepted for selection and for inline edit; on links/buttons this fights the storefront's own handlers, causing "clicks do nothing" or accidental navigation. | `onCanvasClick`, `enableDirectEditing` |

**North-star outcome:** a storefront owner on an **iPad** can tap a section, change its text and image, reorder it by dragging, tweak colors, preview phone/tablet/desktop, and publish — with autosave the whole way — and it never overlaps or loses work.

---

## 1. Principles

1. **Responsive by default.** Layout is *semantic* (stack, grid columns, spans, order, gap, align), never absolute pixels. Content reflows; the owner tweaks *intent*, not coordinates.
2. **One input model.** Everything runs on **Pointer Events** (`pointerdown/move/up` + `setPointerCapture`) so mouse, touch, and pen use the same code path. HTML5 DnD is removed.
3. **Direct manipulation with obvious affordances.** Big tap targets (≥44 px), visible handles, drop indicators, snap lines.
4. **Never lose work.** Debounced autosave of a draft + dirty guard + undo/redo + resilient token refresh.
5. **Edit on the device you're holding.** The chrome adapts: docked panels on laptop, bottom-sheets on phone/iPad.
6. **Progressive disclosure.** Simple by default (text, image, color, reorder); "Advanced" reveals spacing/spans/visibility.
7. **Preview == published.** What the editor shows per breakpoint is exactly what `generic-renderer.js` outputs — no divergent inline-style path.

---

## 2. The big rethink — layout model

The single most valuable change: **retire free-form absolute positioning as the default** and make blocks a **responsive flow of sections**, each with a **responsive grid** inside.

**Data model (target):**
```
page → blocks[]            (vertical flow, drag to reorder)
block → { type, props, layout }
layout = {
  columns: { desktop: 12, tablet: 8, mobile: 4 },   // grid track count
  gap, padding, align, background
}
element → {
  span:   { desktop: 6, tablet: 8, mobile: 4 },      // how many columns
  order:  { desktop: 1, tablet: 1, mobile: 2 },      // reorder per device
  hidden: { mobile: true },                           // hide per device
  align, ...props
}
```
- Elements **reflow automatically**; per breakpoint you change *span / order / hide*, not pixels.
- **Cascade:** `mobile` inherits `tablet` inherits `desktop` unless overridden — so you rarely touch mobile.
- **Auto-migration:** existing absolute (`el.desktop`/`el.mobile` px) configs convert on load via a one-time `migrateCanvasToGrid()` (sort by y, infer columns from x/w, clamp to grid). Keep a legacy absolute mode behind an "Advanced / freeform" toggle for power users, but off by default.

Result: no more overlaps, no double hand-layout, iPad "just works" because it's a real breakpoint between the two.

---

## 3. The big rethink — adaptive editor chrome

One editor, three layouts (driven by real `@media` + a JS layout mode):

| Surface | Panels | Selection UI | Reorder | Add |
|---|---|---|---|---|
| **Laptop (≥1024)** | Left *Layers/Pages* dock + right *Inspector* dock; bottom command bar | hover outline → click select → inspector | drag handle (pointer) + Layers list drag | "+ Add block" modal |
| **iPad (600–1023)** | **Bottom sheet** inspector (swipe up), collapsible; floating round toolbar | tap select → sheet slides up with that block's fields | long-press drag + up/down arrows | "+" FAB → block picker sheet |
| **Phone (<600)** | Full-width **bottom sheet**, one field group at a time | tap select → compact sheet | ▲/▼ move buttons + drag handle | "+" FAB |

Rules: every interactive control ≥ **44×44 px** on touch; the property "toolbar" **docks into the sheet** on touch instead of floating over the element (fixes finding #6); sheets are dismissible and never cover the whole canvas.

---

## 4. Architecture / code changes

1. **Pointer unification (kills #1).** Replace all `mousedown/move/up` and HTML5 DnD with a small `pointerDrag(el, {onStart,onMove,onEnd})` helper using `setPointerCapture`, a movement threshold, and **long-press-to-drag** on touch (so a tap still selects/scrolls). Add **auto-scroll** near viewport edges during drag. One helper replaces `beginElementDrag`, `onHandleMouseDown`, `onInlineElementMouseDown`, `onDragStart/Over/Drop`.
2. **Responsive layout engine.** New `layout-grid.js`: renders block content as CSS grid using the semantic `span/order/hidden` per active breakpoint; the editor writes intent, `generic-renderer.js` reads the same model for the published site (one source of truth).
3. **Breakpoint system.** `desktop | tablet | mobile` with a base+override cascade and a **device preview toolbar** that resizes the canvas frame to real widths (≈1280 / 834 / 390) — you edit inside the frame, like the marketing mockup.
4. **State & safety.**
   - **Autosave**: debounce (~800 ms) → save draft to `/api/storefront/config` under a `draft` flag (separate from published) or localStorage when offline.
   - **Dirty guard**: `beforeunload` + an in-app "unsaved changes" pill; Publish promotes draft → live.
   - **Undo/redo**: keep snapshot model but guarantee **one history entry per gesture** (drag/resize/edit), fixing drags that currently don't get captured.
   - **Token resilience**: silently refresh the edit token before the 15-min expiry (call `/api/storefront/edit-token` again) so long sessions don't fail at Publish.
   - **Publish conflict**: send the config's version/updatedAt; server rejects a stale write so two editors don't clobber each other.
5. **Inline text editing overhaul.** Replace `execCommand` with a minimal, sanitized rich-text layer (bold/italic/link/size/color) that stores clean HTML; sanitize on paste; preserve caret; on touch, show the format controls in the bottom sheet.
6. **Modularize** the 108 KB file into: `boot/auth`, `selection`, `pointer-drag`, `layout-grid`, `inspector`, `chrome-shell`, `history`, `save`, `canvas-legacy`. Smaller files = safer fixes, testable units.

---

## 5. Concrete bug backlog (fix list, mapped to code)

- **Toolbar drift** (`positionToolbar`): reposition on `scroll`/`resize`, clamp inside viewport, dock to sheet on touch.
- **Absolute overlaps** (`applyBreakpointPreview`): migrate to grid; until then, add collision nudging + z-index normalize.
- **Selection eats clicks** (`onCanvasClick`, `enableDirectEditing`): use a capture-phase guard that only intercepts inside `[data-edit]`, and let real links/buttons work in a "preview" sub-mode.
- **Drag not undoable**: wrap every gesture end in `pushHistory`.
- **No empty states**: blank sections show a friendly "Tap to add" placeholder.
- **Edit token in flow**: refresh before expiry (also see [ARCHITECTURE-PLAN.md](ARCHITECTURE-PLAN.md) §7 — token already moved off the query string).
- **Fonts import** blocks first paint (`@import` Google Fonts in CSS): preload/async.

---

## 6. Phased rollout (A → Z)

Ordered so the worst pain dies first and nothing ships half-broken.

| Phase | Theme | Key work | Outcome |
|-------|-------|----------|---------|
| **0 — Stop the pain** (days) | No data loss, no dead sessions | Autosave draft + dirty/`beforeunload` guard + edit-token auto-refresh + one-history-entry-per-gesture | Nobody loses edits; long sessions publish |
| **1 — Touch works** | Pointer unification | `pointerDrag` helper (capture, threshold, long-press, auto-scroll); remove HTML5 DnD | Drag/resize/reorder work on phone + iPad |
| **2 — Responsive chrome** | Adaptive shell | Add real `@media`; bottom-sheet inspector on touch; ≥44px targets; dock the floating toolbar | Editor UI usable on every screen |
| **3 — Device preview** | Edit-what-you-see | Desktop/iPad/Phone frame toggle at true widths; add the **tablet** breakpoint | iPad stops "looking weird"; per-device editing |
| **4 — Layout model** | Responsive-by-default | `layout-grid.js` (span/order/hide cascade); `migrateCanvasToGrid()`; freeform behind Advanced | No overlaps, no double layout; auto-reflow |
| **5 — Inline editing** | Text UX | Sanitized rich-text; caret-safe; format controls in sheet | Reliable text editing, no `execCommand` |
| **6 — Polish & QA** | Trust | Empty states, onboarding coach-marks, a11y (focus/ARIA/contrast), modularize, tests | Feels finished and professional |

---

## 7. Testing & QA

- **Device matrix:** iPhone (Safari), Android (Chrome), iPad (Safari, portrait + landscape), laptop (Chrome/Safari/Firefox), plus a 3-device preview inside the editor.
- **Interaction tests:** select, drag-reorder (touch + mouse), resize, inline edit, image upload, add/delete block, undo/redo, autosave fires, dirty guard blocks nav, publish + reload shows changes.
- **Isolation:** editing workspace A never writes B (already covered server-side; keep the token scope check).
- **Visual regression:** snapshot each block type at desktop/tablet/mobile; diff on change.
- **Perf:** editor boot < 1.5s; drag stays 60fps; config payload stays within the 12 MB storefront limit.

## 8. Appendix — module split & touch-target checklist

```
public/js/portals/editor/
  boot.js          # verifyAndBoot, token, auth gate
  selection.js     # hover/select, capture-phase click guard
  pointer-drag.js  # unified pointer DnD (mouse+touch+pen), auto-scroll
  layout-grid.js   # responsive grid render + span/order/hide cascade
  inspector.js     # property panels (fields), grouped, progressive
  chrome-shell.js  # adaptive docks vs bottom-sheets (media-driven)
  history.js       # snapshot undo/redo, 1 entry per gesture
  save.js          # autosave draft, dirty guard, publish + conflict
  canvas-legacy.js # opt-in freeform absolute mode + migration
```

Touch-target checklist: every button/handle ≥44px; sheet drag area ≥24px; drop zones highlight; long-press ≥300ms to start drag; tap without move = select; no hover-only affordances on touch.

---

### TL;DR
The editor is desktop-mouse-only with absolute pixel layout and no safety net. Make it **pointer-based** (touch works), **responsive-by-default** (grid + spans, three real breakpoints incl. iPad), give it an **adaptive touch UI** (bottom sheets), and **never lose work** (autosave + dirty guard + token refresh). Do Phase 0 first (stop data loss), then touch, then responsive chrome — each phase is shippable on its own.
