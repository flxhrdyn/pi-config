---
name: clone-website-lite
description: Reverse-engineer and clone a website (or blend multiple sites) into a Next.js/Tailwind page using a token-frugal, single-agent workflow — no subagent teams, no worktrees, no exhaustive getComputedStyle dumps, and reduced extraction depth. This is the lightest of three clone-website tiers (full / medium / lite) — trades some fidelity for speed and low usage. Use whenever the user wants to clone, replicate, rebuild, mood-reference, or blend the look of one or more websites, especially when they say "keep it cheap", "hemat usage/token", "don't spawn a bunch of agents", or "just do it yourself" and don't need pixel-perfect accuracy. If they want the same exhaustive rigor as a full clone but still no subagents, use clone-website-medium instead; for the full multi-agent pixel-perfect pipeline, use clone-website-full.
---

# Clone Website (Lite)

Same goal as a full site-clone pipeline — capture a target site's look and rebuild it as real
code — but optimized to burn as few tokens and tool calls as possible. The tradeoff you're
making on purpose: fewer screenshots, coarser CSS extraction (eyeballed from screenshots plus a
handful of targeted `getComputedStyle` reads instead of a full DOM dump), bigger page sections
per pass, and **you write all the code yourself** — no builder subagents, no worktrees, no
parallel agent teams. For most "give me something that looks like X" requests this is plenty;
only escalate to `clone-website-medium` or `clone-website-full` if the user explicitly asks for
pixel-perfect fidelity or a large multi-page site.

## When to reach for a heavier tier instead

- If the user wants genuine pixel-perfect fidelity, exhaustive state/breakpoint coverage, and
  per-component spec files, but still explicitly wants no subagents/worktrees, use
  `clone-website-medium` — same rigor as full, solo execution, tuned for lower token overhead.
- If the user is fine with a parallel multi-agent build (builder subagents, git worktrees, a
  merge step) for maximum thoroughness on a large/multi-page site, use `clone-website-full`.

This lite version is for moodboards, single landing pages, weighted blends of a few references,
and "close enough, don't burn my budget" requests — not for either of the above.

## Step 0: Clarify scope before touching the browser

Browser recon is the expensive part. Before opening a tab, nail down in one short exchange
(use AskUserQuestion if genuinely ambiguous, otherwise just state your assumption and proceed):

1. **Output target** — a new standalone page/route, or should it replace/theme an existing page?
2. **Depth** — hero + a couple of signature sections, or the whole page top to bottom? Default to
   "hero + signature sections" unless the user says "the whole page" or "every section."
3. **Fidelity** — literal pixel clone, or a blended/mood reference (common when multiple URLs are
   given with weights, e.g. "70% site A, 30% site B")? Default to mood-reference blend when
   multiple sources are given.

Getting this wrong costs a full redo, so it's worth the one clarifying round-trip. Getting it
right the first time is what actually saves tokens here — not skipping the question.

## Step 1: One recon pass per site (not per section)

For each target URL, do ONE batched browser pass, not a slow section-by-section crawl:

1. Navigate.
2. Screenshot the hero/fold.
3. `get_page_text` for real copy (never invent placeholder text — real words are cheap to grab
   and make the result look far less fake).
4. One `javascript_tool` call that returns fonts, background/text colors, and any obviously
   distinctive accent colors in a single JSON blob (see snippet below). This replaces the heavy
   per-element `getComputedStyle` walk from the full pipeline — you're extracting the palette and
   type system, not auditing every pixel.
5. Scroll down in 1-2 big jumps (not slow section-by-section increments). Screenshot only the
   landing spots you're actually going to rebuild — if you just need to know *what sections
   exist* rather than exactly how they look, a text/structure read is enough to identify them;
   save the screenshot budget for the ones you'll actually clone. Stop once you've seen the
   sections you actually plan to use (see Step 0's depth decision) — don't scroll to the footer
   of a page you're only borrowing a hero from.
6. **Extract repeated components once.** If a section is a grid of near-identical cards, a nav
   with several identical-style links, or a row of logos, grab the full look (screenshot + copy)
   for ONE instance only, then just list the per-instance data (text, image src/alt, href) for
   the rest via `get_page_text` or a small selector query — never repeat the full visual
   extraction per instance. This is usually the single biggest avoidable cost on list-heavy
   pages (pricing tiers, testimonial grids, logo walls, feature lists).

```javascript
JSON.stringify({
  fonts: [...new Set([...document.querySelectorAll('h1,h2,h3,p,button,code')]
    .map(el => getComputedStyle(el).fontFamily))],
  bg: getComputedStyle(document.body).backgroundColor,
  accents: [...document.querySelectorAll('*')]
    .map(e => getComputedStyle(e).color)
    .filter(c => c.includes('rgb') && !['rgb(255, 255, 255)', 'rgb(0, 0, 0)'].includes(c))
    .slice(0, 8)
})
```

If a domain needs permission and the batch call fails, do a single standalone `navigate` first to
trigger the permission prompt, then resume batching.

Skip unless the request specifically needs it: hover-state extraction, scroll-trigger threshold
measurements, per-tab content states, responsive sweeps at 3 breakpoints, asset download
scripts. These are exactly what makes the full pipeline thorough and exactly what makes it
expensive — only pay for them when literal fidelity was requested in Step 0.

## Step 2: Skip the spec-file ceremony

The full pipeline writes a markdown spec file per component before building it, so an
independent builder subagent has zero ambiguity. You don't need that here: you're about to write
the component yourself, immediately, with the screenshots and extracted tokens still in context.
Writing a spec file to hand to yourself is pure overhead — go straight to code. (If you're
mid-task and about to lose context, a short one-paragraph note is fine, but don't template it.)

## Step 3: Build it yourself, directly, in one or a few passes

- No subagents, no agent teams, no git worktrees for this skill — you write the components and
  the page directly with Read/Write/Edit, in the main thread. That's the whole point of the lite
  path: the coordination overhead of dispatching and merging worktrees costs more tokens than
  just writing the code.
- Group by visual section, not by DOM node — one component per section (hero, feature grid,
  footer) is the right grain. Splitting a simple section into multiple tiny components just to
  mirror the source DOM wastes calls for no visual benefit.
- Reuse whatever the project already has: check `next/font` setup, existing Tailwind tokens in
  `globals.css`, and existing UI primitives before adding new ones or new dependencies. Matching
  Geist Sans/Mono, existing color variables, etc. is usually enough — you don't need to reinstall
  fonts.
- Recreate simple visual effects (gradients, glows, dot grids, line-art) with inline CSS/SVG
  instead of downloading and hosting image assets, unless the user is cloning literal brand
  assets (logos, real product screenshots) they specifically want reused.
- If blending multiple sites, keep the weighting concrete: assign which section of the page
  belongs to which source's pattern language rather than trying to merge every source into every
  section.

## Step 4: One verify pass, not a QA loop

Run `npx tsc --noEmit` once at the end (and `npm run build` if the change is nontrivial or
touches shared files). If it fails, fix and re-run — don't add a full visual-diff QA pass unless
the user asked for pixel-perfect fidelity. A quick look at the rendered page (dev server +
one or two screenshots scrolled through) is enough to catch anything obviously broken.

## What this skill deliberately does NOT do (vs. the full clone-website pipeline)

- No per-component spec files in `docs/research/components/`
- No builder subagents, no agent teams, no worktree-per-component, no merge step
- No full `getComputedStyle` DOM-tree dump per element
- No mandatory hover/scroll/click/responsive sweep across every element
- No asset-download script unless real brand assets are explicitly wanted
- No multi-round visual QA diffing pass

All of those are exactly right for a large, literal, multi-page pixel-perfect clone — that's what
`clone-website-full` (and, without subagents, `clone-website-medium`) is for. This skill trades
some of that rigor for speed and low token spend, which is the right trade for moodboards,
single reference pages, and quick blends.
