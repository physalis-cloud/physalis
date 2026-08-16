---
title: Mobile deployment
order: 16
icon: RiSmartphoneLine
summary: Publish your Android and iOS apps from your CI with no secret in the pipeline — Physalis holds the signing material, your CI builds and uploads directly to the stores.
---

# Mobile deployment

Physalis stores the **signing material** for your mobile apps (Android keystore,
iOS certificate, profiles, store API keys), encrypted and versioned, and serves
it to your CI **on demand via OIDC** — with no secret stored in your repository.

It is the mobile counterpart of [OIDC deployment](oidc-deployment): the same
CI-signed token principle, applied to app publishing.

## What Physalis does — and doesn't

- **Physalis does not build or store the artifact.** The build (`.apk`, `.aab`,
  `.ipa`) stays with you, on your CI runner. Physalis keeps only a **record**,
  never the binary.
- **The CI uploads directly** to Google Play / App Store Connect. The published
  data does not transit through Physalis.
- **Physalis replaces `fastlane match`**: the material no longer lives in a git
  repo encrypted with a team passphrase, but in the vault — with per-project
  access control, audit, versioning, and immediate removal of a departing
  member.

## Enabling the service

1. **Plan.** Mobile deployment is a paid-plan feature (not available on the free
   plan).
2. **Per project.** Open the project **Settings** → **Mobile deployment**
   section → tick the toggle. The **Mobile** tab then appears on the project.
   Each project is enabled separately: a project that doesn't publish to the
   stores need not carry the tab.

## The signing material

In the **Mobile** tab, an **application** = a (platform, store identifier) pair.
Each application holds its credentials, imported one by one:

**Android** (5)
| Credential | Content |
|---|---|
| Keystore | the `.jks`/`.p12` signing file |
| Keystore password | text |
| Key alias | text |
| Key password | text |
| Google Play service account | the JSON downloaded from Google Cloud |

**iOS** (6)
| Credential | Content |
|---|---|
| Distribution certificate (`.p12`) | + its password |
| Provisioning profile (`.mobileprovision`) | |
| App Store Connect API key (`.p8`) | + Key ID + Issuer ID |

Only the certificate, the profile and the keystore carry an **expiry date**,
extracted on import (the others are passwords or identifiers). For a protected
`.p12`/keystore, provide the **passphrase** on import: it is used to read the
date, it is not kept.

## Generate rather than import

You do not have to produce this material yourself. On the application's card,
**Generate signing material** creates it inside the vault — the private key is
born where it will be kept, so it never has to travel. Available on every paid
plan, like the rest of mobile deployment.

**Android** — Physalis builds the upload key (RSA pair + certificate, ~27
years), its password and its alias: **four of the five credentials**. Only the
Google Play service account is left for you. No account is required for this
generation.

> ⚠️ This is the **upload key**, the one Google can reset if you lose yours —
> not the app signing key held by Play App Signing.

**iOS** — from your **App Store Connect API key** alone (`.p8`, with its Key ID
and Issuer ID), Physalis chains the key pair, the CSR, the distribution
certificate, the `.p12` and the provisioning profile: **three credentials out of
six**, the other three being precisely the API key used as input.

> **No Mac required.** A Mac is for *compiling*, not for generating: a CSR and a
> `.p12` are cryptography, not Xcode. This is what really replaces `fastlane
> match` — and the round trip through the macOS Keychain.

Two Apple-side limits to know: the **App ID must already be registered** in your
developer account, and Apple caps distribution certificates (2 to 3 per
account). Regenerating consumes one and **stops the profiles tied to the old
certificate from signing** — the old material stays visible in the
application's history.

## Verifying the material

**Verify material** answers "will this work?" before spending ten minutes of CI.
The check comes in two parts: the consistency of what is stored, then a **real
query to the stores**.

| Group | What is checked |
|---|---|
| Completeness | are all the required credentials present |
| Keystore | readable with the given password, declared alias actually present, key password consistent |
| Certificate / Profile | readable, not expired, expiry known |
| Google Play | the service account exists, is invited to the console, and may publish **this** application |
| App Store Connect | the key is accepted and **sees** this bundle id |

Those last two rows are the time-savers: they tell "invalid key" apart from
"valid key but not invited to the console", and "app unknown to Apple" from
"role too narrow". A `permission denied` at the bottom of a pipeline log makes
none of those distinctions.

## Watching expiry

An Apple distribution certificate lasts a year, a provisioning profile too —
and **neither Google, nor Apple, nor your forge sends a usable reminder** about
it. They expire on a release Friday.

Physalis reads the deadline on import (or on generation) and warns the
**organization owners** by email at **D-60, D-30, D-7**, then on expiry. Three
reminders rather than one because the remedy differs: at 60 days you plan, at 30
you act, at 7 you are late. The Mobile tab shows a banner on the affected
application in parallel.

The reminder is sent **once per band**: the check runs daily without flooding
inboxes, and a deadline pushed back (material renewed) rearms the mechanism
cleanly. A project whose Mobile tab is disabled generates no reminder at all —
you said you no longer publish from there.

## The release registry

An application's **Releases** tab answers "which version is in review, which is
live, who published it, with what material" — a question whose answer normally
lives in three consoles and a chat thread.

A row is written in two moments, and the distinction is the heart of the design:

- **what Physalis observes** — as it hands over the material: build number
  consumed, fingerprints of the material served, OIDC identity of the pipeline.
  That half cannot lie;
- **what the pipeline reports** — track and status, through
  `POST /api/deploy/mobile/report`, with the same OIDC token and the same policy
  as the bundle. Declarative by nature.

Statuses run from `material served` to `live`, through `uploaded`,
`processing`, `in review`, `halted`, `rejected`, `failed`. A row left at
`material served` is not a bug: it says someone obtained signing material and
published nothing — precisely what a registry should show.

> **Physalis does not hold the artifact.** A release is a **dated report**, not
> proof that a binary exists nor that a store accepted it. The registry also
> flags releases signed with material that has **since been replaced**: that
> build will never be reproduced identically.

The workflow templates provided call `/report` at the end of the run, including
when the run fails — a failure occurring **after** the material was handed over
is exactly what you want to see.

## The version number

Apple and Google reject a build number that does not increase. Physalis tracks
it for you: on the application's card, set the **version** (marketing, e.g.
`1.4`) and the **last published build number**. On each deployment, Physalis
serves the next number and increments it — you no longer touch it. The marketing
version stays under your control.

## Policies: two, if your app is hybrid

As with server deployment, a **policy** authorizes a specific pipeline
`(repo, workflow, branch)` to fetch the material. Two kinds:

- a **mobile policy** (the app's Mobile tab) → serves the **signing material**;
- a **server policy** (the project's Policies tab) → serves the **build
  secrets** (`VITE_*`, etc.).

⚠️ **A Capacitor / Cordova / Ionic app first builds a web layer**, which needs
its build secrets. It therefore needs **both** policies, on the same
`(repo, workflow, branch)`. A pure-native app only needs the mobile policy.

## Kill-switch

A **pause/resume** button on each application freezes its deploys: the CI then
gets a clear, audited denial, without you touching the repo. The signing
material stays intact — it is a one-off veto, not a revocation.

## Step-by-step guides

Most of the friction is at Google and Apple. Two tutorials walk you through it,
console by console:

- **[Publish an Android app to Google Play](tuto:publish-android)** — service
  account, API, permissions, keystore.
- **[Publish an iOS app to the App Store](tuto:publish-ios)** — App Store
  Connect API key, certificate, profile.
