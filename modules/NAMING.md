# Module and Service Naming Suggestions

This document collects alternative naming ideas for modules and services in the TradeBot monorepo. Use these as inspiration for future modules or when renaming for clarity, branding, or expansion.

---

## Thematic Naming (Finance/Trading)
- **collector** → ticker, harvester, feed
- **archivist** → vault, ledger, coldstore
- **rearchivist** → compressor, packer, archiver
- **unarchivist** → extractor, thawer, restorer
- **statekeeper** → oracle, sentinel, keeper
- **broadcaster** → relay, caster, announcer
- **mirror** → reflector, echo, simulator

## Functional/Process-Oriented
- **collector** → ingest
- **archivist** → archive
- **rearchivist** → repack
- **unarchivist** → unpack
- **statekeeper** → snapshot
- **broadcaster** → fanout
- **mirror** → ws-gateway

## Playful/Metaphorical
- **collector** → sponge, funnel
- **archivist** → deepfreeze
- **rearchivist** → shrinker
- **unarchivist** → inflator
- **statekeeper** → lighthouse
- **broadcaster** → megaphone
- **mirror** → shadow

---

**Tips:**
- All names should be unique across modules and services.
- Compound names (e.g., `data-vault`, `ws-mirror`, `state-oracle`) can help with clarity and future-proofing.
- Prefixes or branding can be added as the platform grows.

Feel free to expand this list as new patterns or requirements emerge!