---
name: clone-website-medium
description: "Reverse-engineer and clone one or more websites with the same pixel-perfect rigor as clone-website-full — exhaustive CSS/behavior extraction, per-component spec files, full interaction sweeps — but done entirely inline by one agent, sequentially: NO subagents, NO agent teams, NO git worktrees, with explicit token/tool-call efficiency habits. Middle of three clone tiers (full / medium / lite): same thoroughness as full, lower usage overhead, solo execution. Use whenever the user wants a thorough/pixel-perfect website clone but explicitly says not to spawn subagents or worktrees, wants everything done \"by you directly\", wants it efficient but not shallow, or is working where subagents/worktrees aren't available. For a multi-agent parallel build use clone-website-full; for speed/cost over exhaustive fidelity use clone-website-lite. Provide one or more target URLs as arguments."
argument-hint: "<url1> [<url2> ...]"
user-invocable: true
---

# Clone Website (Medium)

You are about to reverse-engineer and rebuild **$ARGUMENTS** as pixel-perfect clones.

This keeps the full rigor of a thorough clone job — exhaustive CSS extraction, documented
interaction states, spec files as auditable artifacts — but you do every step yourself,
sequentially, in the main conversation thread. No subagents, no agent teams, no git worktrees.
When multiple URLs are provided, process them one at a time, in order, keeping each site's
extraction artifacts isolated in dedicated folders (for example, `docs/research/<hostname>/`).

You are still a **foreman walking the job site** — you inspect a section, write down exactly
what you saw, then build it — but there's no crew of specialist builders to hand work off to.
You inspect, then you build, section by section, back to back. The spec file you write for each
component isn't a handoff document for someone else anymore; it's your own record so you don't
have to re-derive a CSS value from memory ten minutes later, and so the user has an auditable
trail of what was extracted vs. guessed.

Thoroughness and low usage aren't actually in tension here — what burns tokens isn't the
*rigor* (checking every state, every breakpoint, every hover), it's *wasted motion* around that
rigor: calling the browser tool once per action instead of batching a sequence, printing a huge
JSON extraction into the chat and then re-typing it into a spec file, re-screenshotting things
you already have a full-page shot of, or re-extracting global tokens (fonts, colors) you already
captured once. Cut the wasted motion, keep every bit of the rigor. Concretely:

- **Batch browser actions.** If your browser MCP has a batch/multi-action tool (e.g.
  `browser_batch`), use it for any sequence you can predict ahead of time — navigate + screenshot,
  or scroll + screenshot + extract. One round trip for a 3-step sequence beats three. Only fall
  back to one-call-at-a-time when the next action genuinely depends on seeing the previous result.
- **Extract global tokens once.** Fonts, color palette, favicons, and global CSS patterns are
  captured once in Phase 1 (Global Extraction) — never re-run that extraction per component. Every
  component spec references the same global tokens instead of re-deriving them.
- **Write extraction output straight into the spec file.** Once you've printed a `getComputedStyle`
  extraction into the chat, don't retype the same values by hand — copy the returned JSON's
  values straight into the spec, so you never manually re-key values that already came back to you.
- **Don't re-screenshot what the full-page shot already shows.** Only take a new section
  screenshot when you need a closer crop, a different viewport width, or a state the full-page
  shot didn't capture (hover, scrolled, alternate tab).
- **Scope the CSS property list to what's plausible for that element.** The full extraction script
  lists every property that might matter across any element; you don't need to sanity-check
  `gridTemplateColumns` on a `<span>` or `objectFit` on a non-`<img>` container. Skip properties
  that are obviously inapplicable to the element's tag/role rather than including them as "none"
  noise in the spec.
- **Don't re-open the same URL for things you could've captured in one visit.** Plan a section's
  full extraction (styles + content + states) as one visit to that scroll position, not several
  passes that each re-navigate or re-scroll to the same spot.
- **Prefer text/tree reads over screenshots when you're after structure or copy, not looks.**
  Screenshots cost far more tokens than an accessibility-tree read or a text extraction. Reach for
  a screenshot when you genuinely need to see something (layout, color, spacing, a visual
  effect) — use `read_page`/`get_page_text`-equivalents to pull DOM structure, real copy, and
  attribute values instead of reading them off a rendered image. Reserve the image budget for
  the cases only a picture can answer.
- **Extract one instance of a repeated component, not every instance.** A card grid with 12
  identical cards, a nav with 8 identical link items, a logo row with 20 logos — these are one
  component repeated with different data. Run the full CSS/behavior extraction on ONE instance,
  then just list the per-instance data (text, image src, href) for the rest. Re-extracting
  identical styles N times is pure waste; the styles don't change, only the content does.
- **Target the interaction sweep at elements that look stateful, not everything clickable.** The
  full hover/click sweep in Phase 1 exists to catch behaviors a screenshot would miss — but a
  plain text link or a static content card doesn't need a click-and-observe pass to confirm it
  does nothing. Spend that sweep on tabs, pills, accordions, nav items, dropdowns, carousels, and
  anything else whose appearance suggests it switches state. Skipping the sweep on inert elements
  isn't cutting corners; clicking something that provably can't change state produces no new
  information regardless of how many times you check it.
- **Merge recon documents instead of splitting by convention.** `BEHAVIORS.md` and
  `PAGE_TOPOLOGY.md` describe the same page from two angles and often repeat each other (a
  section's interaction model belongs in both, verbatim). Write one `docs/research/RECON.md` with
  topology and behaviors together, per section, instead of maintaining two files that each need
  updating when the other changes. Keep per-component spec files separate — those still map
  one-to-one to components you build.

None of this shortens the checklist in Guiding Principles or the Pre-Build Checklist below — it
changes *how* you gather the same information, not *how much* information you gather.

## Scope Defaults

The target is whatever page `$ARGUMENTS` resolves to. Clone exactly what's visible at that URL.
Unless the user specifies otherwise, use these defaults:

- **Fidelity level:** Pixel-perfect — exact match in colors, spacing, typography, animations
- **In scope:** Visual layout and styling, component structure and interactions, responsive design, mock data for demo purposes
- **Out of scope:** Real backend / database, authentication, real-time features, SEO optimization, accessibility audit
- **Customization:** None — pure emulation

If the user provides additional instructions (specific fidelity level, customizations, extra context), honor those over the defaults.

## Pre-Flight

1. **Browser automation is required.** Check for available browser MCP tools (Chrome MCP, Playwright MCP, Browserbase MCP, Puppeteer MCP, etc.). Use whichever is available — if multiple exist, prefer Chrome MCP. If none are detected, ask the user which browser tool they have and how to connect it. This skill cannot work without browser automation.
2. Parse `$ARGUMENTS` as one or more URLs. Normalize and validate each URL; if any are invalid, ask the user to correct them before proceeding. For each valid URL, verify it is accessible via your browser MCP tool.
3. Verify the base project builds: `npm run build`. The Next.js + shadcn/ui + Tailwind v4 scaffold should already be in place. If not, tell the user to set it up first.
4. Create the output directories if they don't exist: `docs/research/`, `docs/research/components/`, `docs/design-references/`, `scripts/`. For multiple clones, also prepare per-site folders like `docs/research/<hostname>/` and `docs/design-references/<hostname>/`.
5. When working with multiple sites, they'll be built one after another in this single thread — no parallelism to confirm, just let the user know the rough order you'll tackle them in.

## Guiding Principles

These are the truths that separate a successful clone from a "close enough" mess. Internalize them — they should inform every decision you make.

### 1. Completeness Beats Speed

You must have **everything** you need before writing a component: screenshot, exact CSS values, downloaded assets with local paths, real text content, component structure. If you catch yourself guessing a color, a font size, or a padding value while writing JSX, stop and go re-extract it. Take the extra minute to extract one more property rather than shipping a guess.

### 2. Small Pieces, Perfect Results

When you try to write an entire complex section in one pass — multiple card variants, each with unique hover states and internal layouts — you tend to approximate: guessed spacing, guessed font sizes, "close enough" that's clearly wrong. When you focus on one component at a time with its exact CSS values in front of you, you nail it.

Look at each section and judge its complexity. A simple banner with a heading and a button is one component, done in one pass. A complex section with 3 different card variants is one component per card variant plus one for the section wrapper, done as separate sequential passes — not because you need to hand them to anyone else, but because holding all of it in your head at once is exactly how details get dropped.

**Complexity budget rule:** If a single component's spec exceeds ~150 lines of content, it's too complex for one build pass. Split it into smaller pieces and build them one at a time. This is a mechanical check — don't override it with "but it's all related."

### 3. Real Content, Real Assets

Extract the actual text, images, videos, and SVGs from the live site. This is a clone, not a mockup. Use `element.textContent`, download every `<img>` and `<video>`, extract inline `<svg>` elements as React components. The only time you generate content is when something is clearly server-generated and unique per session.

**Layered assets matter.** A section that looks like one image is often multiple layers — a background watercolor/gradient, a foreground UI mockup PNG, an overlay icon. Inspect each container's full DOM tree and enumerate ALL `<img>` elements and background images within it, including absolutely-positioned overlays. Missing an overlay image makes the clone look empty even if the background is correct.

### 4. Foundation First

Nothing can be built until the foundation exists: global CSS with the target site's design tokens (colors, fonts, spacing), TypeScript types for the content structures, and global assets (fonts, favicons). Do this first, in full, before touching any individual component.

### 5. Extract How It Looks AND How It Behaves

A website is not a screenshot — it's a living thing. Elements move, change, appear, and disappear in response to scrolling, hovering, clicking, resizing, and time. If you only extract the static CSS of each element, your clone will look right in a screenshot but feel dead when someone actually uses it.

For every element, extract its **appearance** (exact computed CSS via `getComputedStyle()`) AND its **behavior** (what changes, what triggers the change, and how the transition happens). Not "it looks like 16px" — extract the actual computed value. Not "the nav changes on scroll" — document the exact trigger (scroll position, IntersectionObserver threshold, viewport intersection), the before and after states (both sets of CSS values), and the transition (duration, easing, CSS transition vs. JS-driven vs. CSS `animation-timeline`).

Examples of behaviors to watch for — these are illustrative, not exhaustive. The page may do things not on this list, and you must catch those too:
- A navbar that shrinks, changes background, or gains a shadow after scrolling past a threshold
- Elements that animate into view when they enter the viewport (fade-up, slide-in, stagger delays)
- Sections that snap into place on scroll (`scroll-snap-type`)
- Parallax layers that move at different rates than the scroll
- Hover states that animate (not just change — the transition duration and easing matter)
- Dropdowns, modals, accordions with enter/exit animations
- Scroll-driven progress indicators or opacity transitions
- Auto-playing carousels or cycling content
- Dark-to-light (or any theme) transitions between page sections
- **Tabbed/pill content that cycles** — buttons that switch visible card sets with transitions
- **Scroll-driven tab/accordion switching** — sidebars where the active item auto-changes as content scrolls past (IntersectionObserver, NOT click handlers)
- **Smooth scroll libraries** (Lenis, Locomotive Scroll) — check for `.lenis` class or scroll container wrappers

### 6. Identify the Interaction Model Before Building

This is the single most expensive mistake in cloning: building a click-based UI when the original is scroll-driven, or vice versa. Before writing any component for an interactive section, you must definitively answer: **Is this section driven by clicks, scrolls, hovers, time, or some combination?**

How to determine this:
1. **Don't click first.** Scroll through the section slowly and observe if things change on their own as you scroll.
2. If they do, it's scroll-driven. Extract the mechanism: `IntersectionObserver`, `scroll-snap`, `position: sticky`, `animation-timeline`, or JS scroll listeners.
3. If nothing changes on scroll, THEN click/hover to test for click/hover-driven interactivity.
4. Write down the interaction model explicitly in the component spec: "INTERACTION MODEL: scroll-driven with IntersectionObserver" or "INTERACTION MODEL: click-to-switch with opacity transition."

A section with a sticky sidebar and scrolling content panels is fundamentally different from a tabbed interface where clicking switches content. Getting this wrong means a complete rewrite, not a CSS tweak.

### 7. Extract Every State, Not Just the Default

Many components have multiple visual states — a tab bar shows different cards per tab, a header looks different at scroll position 0 vs 100, a card has hover effects. You must extract ALL states, not just whatever is visible on page load.

For tabbed/stateful content:
- Click each tab/button via browser MCP
- Extract the content, images, and card data for EACH state
- Record which content belongs to which state
- Note the transition animation between states (opacity, slide, fade, etc.)

For scroll-dependent elements:
- Capture computed styles at scroll position 0 (initial state)
- Scroll past the trigger threshold and capture computed styles again (scrolled state)
- Diff the two to identify exactly which CSS properties change
- Record the transition CSS (duration, easing, properties)
- Record the exact trigger threshold (scroll position in px, or viewport intersection ratio)

### 8. Spec Files Are the Source of Truth

Every component gets a specification file in `docs/research/components/` BEFORE you write its JSX. In the full pipeline this file is a handoff to a separate builder agent; here it's still worth writing, for a different reason — it's the difference between "I extracted this value" and "I'm pretty sure this value was around here." Writing it down forces you to actually look up every value instead of coasting on a fuzzy memory of the screenshot, and it gives the user (or a future you) an auditable trail to check against if something looks off.

Don't skip it just because there's no one else to hand it to. The discipline of writing the spec is what prevents guessing, not the act of handing it off.

### 9. Build Must Always Compile

Verify `npx tsc --noEmit` passes after each component you add, and `npm run build` passes after each phase completes. A broken build is never acceptable, even temporarily — and because everything happens in one thread with no merge step, there's no excuse for letting errors pile up before checking.

## Phase 1: Reconnaissance

Navigate to the target URL with browser MCP.

### Screenshots
- Take **full-page screenshots** at desktop (1440px) and mobile (390px) viewports
- Save to `docs/design-references/` with descriptive names
- These are your master reference for every component you build later

### Global Extraction
Extract these from the page before doing anything else:

**Fonts** — Inspect `<link>` tags for Google Fonts or self-hosted fonts. Check computed `font-family` on key elements (headings, body, code, labels). Document every family, weight, and style actually used. Configure them in `src/app/layout.tsx` using `next/font/google` or `next/font/local`.

**Colors** — Extract the site's color palette from computed styles across the page. Update `src/app/globals.css` with the target's actual colors in the `:root` and `.dark` CSS variable blocks. Map them to shadcn's token names (background, foreground, primary, muted, etc.) where they fit. Add custom properties for colors that don't map to shadcn tokens.

**Favicons & Meta** — Download favicons, apple-touch-icons, OG images, webmanifest to `public/seo/`. Update `layout.tsx` metadata.

**Global UI patterns** — Identify any site-wide CSS or JS: custom scrollbar hiding, scroll-snap on the page container, global keyframe animations, backdrop filters, gradients used as overlays, **smooth scroll libraries** (Lenis, Locomotive Scroll — check for `.lenis`, `.locomotive-scroll`, or custom scroll container classes). Add these to `globals.css` and note any libraries that need to be installed.

### Mandatory Interaction Sweep

This is a dedicated pass AFTER screenshots and BEFORE anything else. Its purpose is to discover every behavior on the page — many of which are invisible in a static screenshot.

**Scroll sweep:** Scroll the page slowly from top to bottom via browser MCP. At each section, pause and observe:
- Does the header change appearance? Record the scroll position where it triggers.
- Do elements animate into view? Record which ones and the animation type.
- Does a sidebar or tab indicator auto-switch as you scroll? Record the mechanism.
- Are there scroll-snap points? Record which containers.
- Is there a smooth scroll library active? Check for non-native scroll behavior.

**Click sweep:** Click every element that looks interactive:
- Every button, tab, pill, link, card
- Record what happens: does content change? Does a modal open? Does a dropdown appear?
- For tabs/pills: click EACH ONE and record the content that appears for each state

**Hover sweep:** Hover over every element that might have hover states:
- Buttons, cards, links, images, nav items
- Record what changes: color, scale, shadow, underline, opacity

**Responsive sweep:** Test at 3 viewport widths via browser MCP:
- Desktop: 1440px
- Tablet: 768px
- Mobile: 390px
- At each width, note which sections change layout (column → stack, sidebar disappears, etc.) and at approximately which breakpoint the change occurs.

Save all findings to `docs/research/RECON.md` (behaviors section). This is your behavior bible — reference it when writing every component spec.

### Page Topology
Map out every distinct section of the page from top to bottom. Give each a working name. Document:
- Their visual order
- Which are fixed/sticky overlays vs. flow content
- The overall page layout (scroll container, column structure, z-index layers)
- Dependencies between sections (e.g., a floating nav that overlays everything)
- **The interaction model** of each section (static, click-driven, scroll-driven, time-driven)

Save this into the same `docs/research/RECON.md` (topology section) — together with the
behaviors above, it becomes your one-stop build order.

## Phase 2: Foundation Build

Do this first, in full, before any individual component:

1. **Update fonts** in `layout.tsx` to match the target site's actual fonts
2. **Update globals.css** with the target's color tokens, spacing values, keyframe animations, utility classes, and any **global scroll behaviors** (Lenis, smooth scroll CSS, scroll-snap on body)
3. **Create TypeScript interfaces** in `src/types/` for the content structures you've observed
4. **Extract SVG icons** — find all inline `<svg>` elements on the page, deduplicate them, and save as named React components in `src/components/icons.tsx`. Name them by visual function (e.g., `SearchIcon`, `ArrowRightIcon`, `LogoIcon`).
5. **Download global assets** — write and run a Node.js script (`scripts/download-assets.mjs`) that downloads all images, videos, and other binary assets from the page to `public/`. Preserve meaningful directory structure.
6. Verify: `npm run build` passes

### Asset Discovery Script Pattern

Use browser MCP to enumerate all assets on the page:

```javascript
// Run this via browser MCP to discover all assets
JSON.stringify({
  images: [...document.querySelectorAll('img')].map(img => ({
    src: img.src || img.currentSrc,
    alt: img.alt,
    width: img.naturalWidth,
    height: img.naturalHeight,
    // Include parent info to detect layered compositions
    parentClasses: img.parentElement?.className,
    siblings: img.parentElement ? [...img.parentElement.querySelectorAll('img')].length : 0,
    position: getComputedStyle(img).position,
    zIndex: getComputedStyle(img).zIndex
  })),
  videos: [...document.querySelectorAll('video')].map(v => ({
    src: v.src || v.querySelector('source')?.src,
    poster: v.poster,
    autoplay: v.autoplay,
    loop: v.loop,
    muted: v.muted
  })),
  backgroundImages: [...document.querySelectorAll('*')].filter(el => {
    const bg = getComputedStyle(el).backgroundImage;
    return bg && bg !== 'none';
  }).map(el => ({
    url: getComputedStyle(el).backgroundImage,
    element: el.tagName + '.' + el.className?.split(' ')[0]
  })),
  svgCount: document.querySelectorAll('svg').length,
  fonts: [...new Set([...document.querySelectorAll('*')].slice(0, 200).map(el => getComputedStyle(el).fontFamily))],
  favicons: [...document.querySelectorAll('link[rel*="icon"]')].map(l => ({ href: l.href, sizes: l.sizes?.toString() }))
});
```

Then write a download script that fetches everything to `public/`. Use batched parallel downloads (4 at a time) with proper error handling.

## Phase 3: Component Specification & Build

This is the core loop. For each section in your page topology (top to bottom), you do THREE things yourself, back to back: **extract**, **write the spec file**, then **build it**.

### Step 1: Extract

For each section, use browser MCP to extract everything:

1. **Screenshot** the section in isolation (scroll to it, screenshot the viewport). Save to `docs/design-references/`.

2. **Extract CSS** for every element in the section. Use the extraction script below — don't hand-measure individual properties. Run it once per component container and capture the full output:

```javascript
// Per-component extraction — run via browser MCP
// Replace SELECTOR with the actual CSS selector for the component
(function(selector) {
  const el = document.querySelector(selector);
  if (!el) return JSON.stringify({ error: 'Element not found: ' + selector });
  const props = [
    'fontSize','fontWeight','fontFamily','lineHeight','letterSpacing','color',
    'textTransform','textDecoration','backgroundColor','background',
    'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
    'margin','marginTop','marginRight','marginBottom','marginLeft',
    'width','height','maxWidth','minWidth','maxHeight','minHeight',
    'display','flexDirection','justifyContent','alignItems','gap',
    'gridTemplateColumns','gridTemplateRows',
    'borderRadius','border','borderTop','borderBottom','borderLeft','borderRight',
    'boxShadow','overflow','overflowX','overflowY',
    'position','top','right','bottom','left','zIndex',
    'opacity','transform','transition','cursor',
    'objectFit','objectPosition','mixBlendMode','filter','backdropFilter',
    'whiteSpace','textOverflow','WebkitLineClamp'
  ];
  function extractStyles(element) {
    const cs = getComputedStyle(element);
    const styles = {};
    props.forEach(p => { const v = cs[p]; if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[p] = v; });
    return styles;
  }
  function walk(element, depth) {
    if (depth > 4) return null;
    const children = [...element.children];
    return {
      tag: element.tagName.toLowerCase(),
      classes: element.className?.toString().split(' ').slice(0, 5).join(' '),
      text: element.childNodes.length === 1 && element.childNodes[0].nodeType === 3 ? element.textContent.trim().slice(0, 200) : null,
      styles: extractStyles(element),
      images: element.tagName === 'IMG' ? { src: element.src, alt: element.alt, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight } : null,
      childCount: children.length,
      children: children.slice(0, 20).map(c => walk(c, depth + 1)).filter(Boolean)
    };
  }
  return JSON.stringify(walk(el, 0), null, 2);
})('SELECTOR');
```

3. **Extract multi-state styles** — for any element with multiple states (scroll-triggered, hover, active tab), capture BOTH states:

```javascript
// State A: capture styles at current state (e.g., scroll position 0)
// Then trigger the state change (scroll, click, hover via browser MCP)
// State B: re-run the extraction script on the same element
// The diff between A and B IS the behavior specification
```

Record the diff explicitly: "Property X changes from VALUE_A to VALUE_B, triggered by TRIGGER, with transition: TRANSITION_CSS."

4. **Extract real content** — all text, alt attributes, aria labels, placeholder text. Use `element.textContent` for each text node. For tabbed/stateful content, **click each tab and extract content per state**.

5. **Identify assets** this section uses — which downloaded images/videos from `public/`, which icon components from `icons.tsx`. Check for **layered images** (multiple `<img>` or background-images stacked in the same container).

6. **Assess complexity** — how many distinct sub-components does this section contain? A distinct sub-component is an element with its own unique styling, structure, and behavior (e.g., a card, a nav item, a search panel). If there are 3+, you'll build them as separate sequential passes rather than one big pass (see Complexity Budget above).

### Step 2: Write the Component Spec File

For each section (or sub-component, if you're breaking it up), create a spec file in `docs/research/components/` BEFORE writing its JSX.

**File path:** `docs/research/components/<component-name>.spec.md`

**Template:**

```markdown
# <ComponentName> Specification

## Overview
- **Target file:** `src/components/<ComponentName>.tsx`
- **Screenshot:** `docs/design-references/<screenshot-name>.png`
- **Interaction model:** <static | click-driven | scroll-driven | time-driven>

## DOM Structure
<Describe the element hierarchy — what contains what>

## Computed Styles (exact values from getComputedStyle)

### Container
- display: ...
- padding: ...
- maxWidth: ...
- (every relevant property with exact values)

### <Child element 1>
- fontSize: ...
- color: ...
- (every relevant property)

### <Child element N>
...

## States & Behaviors

### <Behavior name, e.g., "Scroll-triggered floating mode">
- **Trigger:** <exact mechanism — scroll position 50px, IntersectionObserver rootMargin "-30% 0px", click on .tab-button, hover>
- **State A (before):** maxWidth: 100vw, boxShadow: none, borderRadius: 0
- **State B (after):** maxWidth: 1200px, boxShadow: 0 4px 20px rgba(0,0,0,0.1), borderRadius: 16px
- **Transition:** transition: all 0.3s ease
- **Implementation approach:** <CSS transition + scroll listener | IntersectionObserver | CSS animation-timeline | etc.>

### Hover states
- **<Element>:** <property>: <before> → <after>, transition: <value>

## Per-State Content (if applicable)

### State: "Featured"
- Title: "..."
- Subtitle: "..."
- Cards: [{ title, description, image, link }, ...]

### State: "Productivity"
- Title: "..."
- Cards: [...]

## Assets
- Background image: `public/images/<file>.webp`
- Overlay image: `public/images/<file>.png`
- Icons used: <ArrowIcon>, <SearchIcon> from icons.tsx

## Text Content (verbatim)
<All text content, copy-pasted from the live site>

## Responsive Behavior
- **Desktop (1440px):** <layout description>
- **Tablet (768px):** <what changes — e.g., "maintains 2-column, gap reduces to 16px">
- **Mobile (390px):** <what changes — e.g., "stacks to single column, images full-width">
- **Breakpoint:** layout switches at ~<N>px
```

Fill every section. If a section doesn't apply (e.g., no states for a static footer), write "N/A" — but think twice before marking States & Behaviors as N/A. Even a footer might have hover states on links.

### Step 3: Build It

With the spec file written and the screenshot in front of you, write the component directly:

**Simple section** (1-2 sub-components): Write the whole section in one pass.

**Complex section** (3+ distinct sub-components): Build sub-components one at a time in separate passes, then the section wrapper that imports them, so you're never holding more than one component's worth of detail in your head at once.

**Before moving to the next section:**
- Verify with `npx tsc --noEmit`
- Spot-check the component against its spec file and the screenshot
- Fix any drift immediately — don't defer it to a later QA pass

Then move to extracting the next section, in order, top to bottom. There's no parallel work happening in the background here — extract, spec, build, verify, repeat.

## Phase 4: Page Assembly

After all sections are built, wire everything together in `src/app/page.tsx`:

- Import all section components
- Implement the page-level layout from your topology doc (scroll containers, column structures, sticky positioning, z-index layering)
- Connect real content to component props
- Implement page-level behaviors: scroll snap, scroll-driven animations, dark-to-light transitions, intersection observers, smooth scroll (Lenis etc.)
- Verify: `npm run build` passes clean

## Phase 5: Visual QA Diff

After assembly, do NOT declare the clone complete. Take side-by-side comparison screenshots:

1. Open the original site and your clone side-by-side (or take screenshots at the same viewport widths)
2. Compare section by section, top to bottom, at desktop (1440px)
3. Compare again at mobile (390px)
4. For each discrepancy found:
   - Check the component spec file — was the value extracted correctly?
   - If the spec was wrong: re-extract from browser MCP, update the spec, fix the component
   - If the spec was right but you built it wrong: fix the component to match the spec
5. Test all interactive behaviors: scroll through the page, click every button/tab, hover over interactive elements
6. Verify smooth scroll feels right, header transitions work, tab switching works, animations play

Only after this visual QA pass is the clone complete.

## Pre-Build Checklist

Before writing the JSX for ANY component, verify you can check every box. If you can't, go back and extract more.

- [ ] Spec file written to `docs/research/components/<name>.spec.md` with ALL sections filled
- [ ] Every CSS value in the spec is from `getComputedStyle()`, not estimated
- [ ] Interaction model is identified and documented (static / click / scroll / time)
- [ ] For stateful components: every state's content and styles are captured
- [ ] For scroll-driven components: trigger threshold, before/after styles, and transition are recorded
- [ ] For hover states: before/after values and transition timing are recorded
- [ ] All images in the section are identified (including overlays and layered compositions)
- [ ] Responsive behavior is documented for at least desktop and mobile
- [ ] Text content is verbatim from the site, not paraphrased
- [ ] The component's spec is under ~150 lines; if over, split it into smaller pieces and build them one at a time

## What NOT to Do

These are lessons from previous failed clones — each one cost hours of rework:

- **Don't build click-based tabs when the original is scroll-driven (or vice versa).** Determine the interaction model FIRST by scrolling before clicking. This is the #1 most expensive mistake — it requires a complete rewrite, not a CSS fix.
- **Don't extract only the default state.** If there are tabs showing "Featured" on load, click Productivity, Creative, Lifestyle and extract each one's cards/content. If the header changes on scroll, capture styles at position 0 AND position 100+.
- **Don't miss overlay/layered images.** A background watercolor + foreground UI mockup = 2 images. Check every container's DOM tree for multiple `<img>` elements and positioned overlays.
- **Don't build mockup components for content that's actually videos/animations.** Check if a section uses `<video>`, Lottie, or canvas before building elaborate HTML mockups of what the video shows.
- **Don't approximate CSS classes.** "It looks like `text-lg`" is wrong if the computed value is `18px` and `text-lg` is `18px/28px` but the actual line-height is `24px`. Extract exact values.
- **Don't try to build a whole complex section in one shot to save time.** That's exactly how details get dropped. Split it and build sequentially, one component per pass.
- **Don't skip writing the spec file because "I'll just build it directly."** It's not a handoff document anymore, but it's still what forces you to look up real values instead of guessing from memory.
- **Don't skip asset extraction.** Without real images, videos, and fonts, the clone will always look fake regardless of how perfect the CSS is.
- **Don't skip responsive extraction.** If you only inspect at desktop width, the clone will break at tablet and mobile. Test at 1440, 768, and 390 during extraction.
- **Don't forget smooth scroll libraries.** Check for Lenis (`.lenis` class), Locomotive Scroll, or similar. Default browser scrolling feels noticeably different and the user will spot it immediately.
- **Don't spawn subagents, agent teams, or git worktrees for this skill.** That's the entire point of the medium tier — if the user wanted the parallel multi-agent pipeline, they'd ask for `clone-website-full` instead.
- **Don't let verification pile up.** Since there's no merge step to force a build check, it's easy to skip `npx tsc --noEmit` "just this once." Don't — errors compound fast when nothing else is catching them.

## Completion

When done, report:
- Total sections built
- Total components created
- Total spec files written (should match components)
- Total assets downloaded (images, videos, SVGs, fonts)
- Build status (`npm run build` result)
- Visual QA results (any remaining discrepancies)
- Any known gaps or limitations
