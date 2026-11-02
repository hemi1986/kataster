# UI Prototype

Generate **several radically different UI variations** in one self-contained HTML file, switchable from a
floating bottom bar. The user flips between variants in the browser, picks one (or steals bits from each), then
throws the rest away.

If the question is about logic/state rather than what something looks like, this is the wrong branch. Use
[LOGIC.md](LOGIC.md).

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Two sub-shapes: standalone first

A UI prototype is easier to judge when it butts up against the rest of the app – real header, real sidebar,
real data, real density. A variant in a vacuum looks fine in isolation. But in discovery there is no app code
yet, and the `ux-designer` must not write it. So the default is standalone; the in-app shape is the exception.

### Sub-shape A: standalone HTML (default in discovery)

One file, `docs/prototypes/<slug>/index.html`, with inline CSS and JS. No framework, no bundler, no server. It
opens by double-click and survives being emailed around.

- Use sample data that matches the domain (`CONTEXT.md`), not `foo`/`bar`.
- Give each variant a clear component name in the file: `VariantA`, `VariantB`, `VariantC`.
- Keep the page frame realistic: the header, the navigation and the density the real page will have. A blank
  page hides design problems that a populated one exposes.
- If the feature will live inside an existing screen, render that screen's frame around the variants.

### Sub-shape B: in-app throwaway route (only in `/implement`)

Only when the question genuinely needs the real application: an existing page, real data, the real header and
sidebar. The main session builds it, not the `ux-designer`. Follow the project's routing convention; do not
invent a new top-level structure. Name the route or the file so it is obviously a prototype. Same `?variant=`
pattern and the same switcher. Never wire it to real mutations; read-only is fine.

## Process

### 1. State the question and pick N

Default to **3 variants**. More than 5 stops being radically different and starts being noise, so cap there.

Write down the plan in one line, at the top of the file and in the `README.md`:

> "Three variants of the settings page, switchable via `?variant=`, on the existing `/settings` route."

### 2. Generate radically different variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The project's component library / styling system if the prototype is in-app; plain CSS if it is standalone.
- A clear component name in the file, e.g. `VariantA`, `VariantB`, `VariantC`.

Variants must be **structurally different**: different layout, different information hierarchy, different
primary affordance, not just different colours. Three slightly-tweaked card grids isn't a UI prototype, it's
wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together

Create a single switcher in the file:

```js
// pseudo-code, adapt to the file
const variant = new URLSearchParams(location.search).get("variant") ?? "A";
render(
  variant === "A" ? VariantA(data) :
  variant === "B" ? VariantB(data) :
  VariantC(data)
);
renderSwitcher(["A", "B", "C"], variant);
```

For sub-shape B (in-app), keep all the existing data fetching above the switcher; only the rendered subtree
changes per variant.

### 4. Build the floating switcher

A small fixed-position bar at the bottom-centre of the screen with three pieces:

- **Left arrow**: cycles to the previous variant (wraps around).
- **Variant label**: shows the current variant key and, if the variant exports a name, that name too. e.g.
  `B (Sidebar layout)`.
- **Right arrow**: cycles forward (wraps around).

Behaviour:

- Clicking an arrow updates the URL search param (`history.replaceState` in a standalone file, the framework's
  router in-app) so the variant is shareable and reload-stable.
- Keyboard: `←` and `→` arrow keys also cycle. Don't intercept arrow keys when an `<input>`, `<textarea>`, or
  `[contenteditable]` is focused.
- Visually distinct from the page (e.g. high-contrast pill, subtle shadow) so it is obviously not part of the
  design being evaluated.
- In-app only: hidden in production builds, gated on `process.env.NODE_ENV !== "production"` or an equivalent
  check, so a stray prototype merge cannot ship the bar to users. A standalone file never enters the build.

### 5. Hand it over

Surface the file path or the URL (and the `?variant=` keys). The user will flip through whenever they get to
it. The interesting feedback is usually **"I want the header from B with the sidebar from C"**, which is the
actual design they want.

### 6. Capture the answer and clean up

Once a variant has won, capture the answer (which variant and why), then capture the prototype the way the
[SKILL](SKILL.md) describes. Fold the winner into the real code and move the rest onto the throwaway branch,
not into main:

- **Standalone**: the decision goes into the story and, when it is a recurring rule, into
  `docs/product/ux-guidelines.md`. The whole `docs/prototypes/<slug>/` folder goes to `prototype/<slug>`.
- **In-app**: fold the winner into the existing page; drop the losing variants and the switcher from the story
  branch. The full set goes to `prototype/<slug>`.

The full set of variants is the primary source, so it lands on the throwaway branch, not the bin. Variant
components and the switcher left in the main branch rot fast and confuse the next reader.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree
  about structure.
- **Sharing too much code between variants.** A shared header is fine; a shared layout defeats the point.
  Each variant should be free to throw out the layout.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it
  at a stub: the question is "what should this look like", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was written under prototype
  constraints (no tests, minimal error handling). Rewrite it properly when you fold it in.
