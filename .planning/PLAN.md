# Plan: Broader web framework detection

## Goal
Extend `detectNodePort()` in `lib/registry.js` to guess default dev ports for more
frontend frameworks, so "rescan projects" (`R` key, already implemented) picks up
correct ports for a wider range of web app types, not just Next/Vite/react-scripts.

Note: lowercase `r` is already bound to "restart server" and capital `R` already
does "rescan for new projects" — no keybinding changes needed, we're using the
existing `R` shortcut.

## Steps
- [x] Add dependency-based port guesses to `detectNodePort()` (lib/registry.js) for:
  - Nuxt (`nuxt`) → 3000
  - SvelteKit (`@sveltejs/kit`) → 5173
  - Astro (`astro`) → 4321
  - Remix (`@remix-run/dev` / `@remix-run/react`) → 3000
  - Angular CLI (`@angular/cli`) → 4200
  - Gatsby (`gatsby`) → 8000
  - Vue CLI (`@vue/cli-service`) → 8080
  - NestJS (`@nestjs/core`) → 3000
- [x] Keep existing checks (next/vite/react-scripts) and env/cmd/source-based
  detection taking priority over these dependency guesses (unchanged order).

## Verification
- [x] Create temp directories with minimal `package.json` files declaring each new
  framework dependency (no `.env`/port config), run `generateRegistry()` against
  that root, and confirm each project is assigned the expected default port.
  Result: all 11 frameworks (nuxt, sveltekit, astro, remix, angular, gatsby, vue,
  nest, next, vite, cra) resolved to their expected default ports.
- [x] Confirm existing frameworks (Next/Vite/react-scripts) and env/cmd detection
  still take priority and are unaffected. Confirmed — order preserved, same
  detection path used for all.
