# Documentation rules

Hard constraints for every doc in this repo: `docs/**`, READMEs, and docblocks.

## Docs depend in the direction the code does

A consumer depends on its provider; a provider never depends on its consumers. Docs follow the same
direction, so changing or removing something never means searching the repo for docs that mention it —
only its own docs, and the docs of what consumes it, can.

- **A provider's doc explains what it offers on its own terms.** It never explains an offering by who
  uses it. The catalog serves S3-style listings because that is its job, not because some service reads
  them; that service may disappear tomorrow and the catalog's doc must still be true.
- **A consumer's doc explains how and why it uses its providers.** That is where the dependency is
  written down.
- **Venues are providers to everything.** `docs/venues/**` describes the venue — its archives, APIs,
  formats, quirks, limits — and never names a service of this repo or what a service does with the venue.
  How a service handles a venue's quirk is the service's doc.
- **`docs/VOCABULARY.md` depends on nothing.** Definitions only: no venue facts, no service internals.
- **The exception is a pointer, never an explanation.** A doc may point at a doc it does not depend on
  for context ("for examples of consumers, see X"). It must be fully understandable without following
  the pointer, and a stale pointer must not make it wrong.

A provider can change to suit its consumers. That is a decision someone takes, not a dependency, and the
provider's doc then describes the new offering on its own terms.

## Each subject has one home

Like an encyclopedia: a subject has one article that goes deepest, and other docs touch it at their
own depth and focus, pointing to that article for the rest. Some overlap is expected and often needed
for a doc to be understandable on its own. What must not happen is two docs going deep on the same
thing — that is what goes stale and contradicts itself.

## Only what is true today

Tech docs describe the current state. No history ("was X, now Y"), no plans, no future tense. Plans live in
`docs/planning/`, and are cut as they land.

## A doc is about its own subject

A doc on X explains X. It does not explain its neighbours, and is not framed around the problem that
motivated it.
