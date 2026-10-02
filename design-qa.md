# Store POS revised Option 1 — design QA

Date: 2026-10-02  
Final result: passed

## Evidence

- Source visual truth path: `/Users/aaronarquillano/.codex/generated_images/01a0f7e7-ed53-7111-86f6-3e5a9012bb2f/exec-fc15e95f-8751-451c-89ab-f68a2283aac8.png`
- Implementation screenshot path: browser-rendered Codex CUA capture from `http://localhost:3000/` (inline task artifact; the in-app browser did not expose a filesystem path).
- Primary comparison viewport: 390×844 CSS px.
- Source pixels: 853×1844. It was normalized in the comparison board to 390×844 CSS px.
- Implementation pixels: 390×844 at device scale 1, confirmed from the browser capture bytes.
- Comparison input: a temporary local QA board placed the normalized source and the live implementation side by side in one 860×930 browser viewport. The temporary route was removed after the comparison.
- State: cashier Sell screen, synchronized, three cart items, populated phone thumb dock, two-column quick-item grid, low-stock and out-of-stock examples.
- Additional viewports: 320×720, 768×1024, and 1440×900. Browser zoom was reset and raised through the Chromium increments to 200%; the layout reflowed without horizontal overflow or loss of persistent controls, then zoom was reset.

## Full-view comparison

The final 390×844 comparison preserves the source hierarchy: compact store/sync header, Sell title and guidance, full-width search, dense two-column quick-item grid, phone thumb dock above the dynamic two-item navigation, and a populated cart summary with count, total, and View Cart. Card colors, green/cream tokens, rounded surfaces, icon family, and dock elevation closely match the source direction.

Focused-region comparison was not needed for the source-matched Sell screen because typography, stock labels, product cards, dock controls, and navigation were legible at the 1:1 CSS-size side-by-side view. Separate browser captures inspected the one-item cart sheet and Cash checkout dialog at 390×844.

## Required fidelity surfaces

- Fonts and typography: Georgia display type and system UI text preserve the source's editorial/operational contrast. The final pass also applies the display face to phone quick-item names and matches the source `SELL ITEMS` copy. Wrapping remained readable at 320 px.
- Spacing and layout rhythm: final phone cards are 90 px minimum with 8 px grid gaps; intro, search, section spacing, dock, and navigation now fit the same above-the-fold density as the source. Tablet remains two-pane and desktop retains a stable cart column.
- Colors and tokens: cream background, dark green primary surfaces, mint active states, pastel product tones, warning orange, and disabled gray are coherent with the source and retain semantic distinction.
- Image quality and asset fidelity: the implementation uses stored product photos when available and the existing initial fallback otherwise. The QA store has no uploaded product photos, so initials are an expected data-state difference; the plan explicitly treats the source photography as illustrative.
- Copy and content: title, Sell eyebrow, search hint, quick-item guidance, stock states, View Cart summary, and two-item cashier navigation are coherent and source-aligned. Dynamic store/product names and totals differ from the illustrative source data as expected.
- Accessibility and behavior: visible 3:1+ focus ring, semantic payment radios, `aria-current`, live completion feedback, inert dialog background, focus entry/trap/restore, Escape handling, 44 px+ practical targets, disabled out-of-stock cards, explicit low-stock text, and closed cart removal from the accessibility tree were verified.

## Comparison history

### Iteration 1 — blocked

- [P2] Phone quick-item grid was materially too tall. Only about three rows fit above the dock where the source fit roughly five, changing the target density and above-the-fold hierarchy.
- Fix: reduced phone intro/search spacing, changed the search field to 50 px, reduced quick cards from 142 px to 90 px minimum, tightened grid gaps and typography, and matched the source's serif product-name treatment.

### Iteration 2 — passed

- Post-fix visual evidence showed the source and implementation with aligned header/search/section rhythm, compact product rows, matching dock structure, and unobstructed bottom navigation.
- No actionable P0, P1, or P2 differences remain.
- Expected differences: illustrative source photography versus product initials for records without uploaded images; dynamic sample names, stock, and totals; the development-only Next.js control, which is absent from production.

## Interaction and responsive checks

- Empty Sell cart: centered Scan is the only phone dock action.
- Populated Sell cart: Scan remains left; cart summary exposes count, total, and View Cart.
- One-item cart: content-sized bottom sheet with sticky total and Checkout; closed sheet is absent from the accessibility tree.
- Checkout: one portal dialog, focus inside, background absent from the accessibility tree, semantic Cash/Online Payment/Utang radios, and only Cash guidance visible.
- Completion: amount, method, and short transaction reference announced as status content.
- 320 px phone: no horizontal overflow; dock and two-item navigation remain reachable.
- 768 px tablet: top navigation with persistent product and cart panes.
- 1440 px desktop: four-column product grid and stable cart column.
- Console: no errors or warnings during the browser QA run.

## Automated verification

- `npm run test -w @gma/web`: 68/68 tests passed.
- `npm run typecheck -w @gma/web`: passed.
- `npm run build:packages && npm run build -w @gma/web`: passed.
- `git diff --check` for the changed web files: passed.

## Follow-up polish

- [P3] Add product photography to the QA store if a future review needs pixel-level image crop and sharpness comparison rather than validation of the existing fallback state.
