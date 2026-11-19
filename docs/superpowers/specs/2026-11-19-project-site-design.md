# Project site — design

**Date:** 2026-11-19 · **Status:** approved in conversation, built
**Domain:** `https://dsh-frp.tryme.cc`

## Intent

Give the repository a front door that a stranger can evaluate in about ten seconds. The
README is already a complete manual (install, configuration, security model, troubleshooting,
in two languages). A site that repeats it would create two documents that drift apart, so the
site answers a different question: *what is this, why does the gateway exist, and can I trust
it enough to try it?* Detail stays in the repository.

Audience: someone who found the repo through GitHub search, the npm package, or a link, and is
deciding whether to run a tunnel from their own machine.

## Goals

- State the product in one sentence, with the install command immediately copyable.
- Explain the three reasons a bare `frpc` tunnel is not enough (the fence, the cookie, revocation).
- Show the request path end to end and the concrete security behaviours, in plain language.
- Name the limits before someone installs it: no TLS termination, single user, no MFA.
- Serve both English and Chinese, matching the two READMEs.
- Deploy automatically to GitHub Pages on `main`.

## Non-goals

- A documentation site. There is no second copy of the configuration reference; links go to the
  README and `docs/`.
- A blog, changelog, or version picker.
- Screenshots of the DSH panel. None exist in the repository, and inventing UI would be a lie.

## Constraints

- **No build step, no dependencies.** The bundle's selling point is "plain ESM, Node core only";
  a fabricated toolchain for one page would contradict it.
- **GitHub Pages** is the host: static files only, no server-side anything.
- **Custom domain** already owned (`dsh-frp.tryme.cc`), DNS on Cloudflare.

## Approaches considered

1. **Static generator (Astro/Eleventy) in the repo.** Real i18n and templating, but adds a
   toolchain, a lockfile, and CI minutes to a project whose pitch is having none.
2. **Host the README with a theme (e.g. docsify/just-the-docs).** Cheapest, but the result reads
   as a manual — no landing page, no positioning, and it inherits the README's length.
3. **One hand-written `index.html` with inline CSS/JS.** *(chosen)* Zero dependencies, opens
   directly from disk, deploys as a static artifact, and lets the page carry the product's voice
   and visual language instead of a documentation theme's.

## Decisions

- **Single page, six sections**: hero (with the install command), the problem, the request path,
  the security model, the limits, setup. Anchors in the header for the four long ones.
- **Bilingual without a runtime**: every string exists twice in the markup (`en`/`zh` spans) and a
  `data-lang` attribute on `<html>` decides which is painted. No i18n library, no build step, no
  flicker (the choice is applied by an inline script in `<head>`). Browser language is used on
  first visit; the toggle persists in `localStorage` under `dshfrp.lang`.
- **Visual continuity with the social card**: same `#070b14` canvas, the same blue→violet
  gradient, the same artwork, inlined as a cropped viewBox so the tunnel can animate.
- **Reveal-on-scroll is additive**: the hidden state is applied by JavaScript, so a broken script,
  a crawler, or `prefers-reduced-motion` still gets the full page.
- **Pages via Actions artifact** (`upload-pages-artifact` + `deploy-pages`), triggered only by
  changes under `site/`. `site/CNAME` carries the custom domain into the artifact.

## What the builder still owns

- DNS: a `CNAME` for `dsh-frp` → `trymesoft.github.io`, **DNS only** (no Cloudflare proxy), then
  enabling the custom domain and HTTPS in the repository settings.
- Whether the site should later grow a changelog or a docs route.
