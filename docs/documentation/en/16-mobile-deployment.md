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
developer account, and Apple caps distribution certificates (2 to 3 per account).
Regenerating **everything** consumes one and stops the profiles tied to the old
certificate from signing.

> ⚠️ **Replacement cannot be undone.** Physalis does keep the previous value, but
> **no screen currently restores it**: keep a local copy of your `.p12` and your
> profile before regenerating.

### Regenerate the profile only

This is the most frequent case, and the one to prefer: a profile lasts a year, a
certificate too, but **their dates do not line up**. When only the profile
expires, regenerating everything would consume a certificate for nothing — and
you would hit the cap after twice.

**Regenerate profile only** reuses the certificate already in service: it
consumes no slot and touches neither the certificate nor the private key.
Physalis finds the right certificate by comparing **fingerprints**, not names —
two certificates on the same account often share a label.

> The regenerated profile may show the **certificate's** expiry rather than a
> year: Apple caps a profile's validity to that of the certificate it embeds.
> That is not an anomaly.

### The cap, and revocation

**Show Apple certificates** lists the account's distribution certificates and
flags the one **in use** — the one whose private key is in the vault, hence the
one signing your builds. Without that, revoking is a coin toss.

At the cap you must revoke before generating. **Revoke** calls Apple's API for
you, from Physalis, and writes it to the audit log — this is what replaces
fastlane's `match nuke`, while keeping the trace.

> ⚠️ Physalis **refuses** to revoke the certificate in use, and overrides only
> after an explicit confirmation. Doing it anyway breaks your releases until a new
> certificate is generated. The audit entry then carries `forced: true`: that is
> the trace to look for the day a signature fails for no apparent reason.

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

### ⚠️ "Live" means "published on the track", not "approved"

Two API limits worth knowing, because they look like bugs:

- **Google Play exposes the review state nowhere.** A version can be `completed`
  on its track — hence shown as **live** here — and have been **rejected** by
  Play's policy review. Only the console shows it. There is no endpoint to read
  it; when in doubt, the Play Console is authoritative.
- **At Apple, `VALID` means "binary processed"**, not "on sale". Review and
  release for sale live in another part of the API, which Physalis does not
  read — so we show `uploaded`, never `live`, rather than announcing a release
  we have not observed.

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

## Native or hybrid project: the delta

Four templates ship, two per platform:

| Project | Templates |
|---|---|
| **Hybrid** (Capacitor, Cordova, Ionic) | `deploy-mobile-android-capacitor.modele.yml`, `deploy-mobile-ios-capacitor.modele.yml` |
| **Native** (Gradle/Kotlin, Xcode/Swift) | `deploy-mobile-android-native.modele.yml`, `deploy-mobile-ios-native.modele.yml` |

A **single `fastlane/Fastfile`** serves all four: what separates the two families
is what the *workflow* does before calling the lane, not the lane itself.

⚠️ **The Capacitor templates have shipped for real** (Google Play and TestFlight,
from CI, with no secrets). The native ones are their transposition and **have not
run yet** in real conditions — their header says so. The sensitive parts (bundle
fetch, fingerprint check, release report, fastlane lane) are reused verbatim;
read the two points below before your first run.

### What native does less of

- **No call to `/api/deploy`.** With no web layer there are no build secrets to
  inject: a **single mobile policy** is enough (see the previous section).
- **No `npm ci`, no `npx cap sync`.** The native project lives in your repo, under
  version control; it is not regenerated on every build.
- **No icon or permission step.** They live in the project, in git.

### The point that really differs: the version

Physalis is authoritative on the build number, but **how it is applied differs**,
and that is not cosmetic.

**Android.** The templates patch the app module's `build.gradle`, then **read the
file back** to confirm the substitution bit. The native template accepts both
syntaxes — `versionCode 12` (Groovy) and `versionCode = 12` (Kotlin DSL). If your
project **computes** its version (commit count, properties file, versioning
plugin), the substitution will match nothing: the workflow stops and says so,
rather than shipping a wrong number. Replace that step with whatever your project
expects.

**iOS.** This is where the two families diverge most:

- **Capacitor** generates an `Info.plist` with **literal** values, which `agvtool`
  cannot read. The template therefore writes it directly with `plutil -replace`.
- **A native Xcode project** writes `CFBundleVersion = $(CURRENT_PROJECT_VERSION)`
  and keeps the value in its *build settings*. Writing a literal there with
  `plutil` would **disconnect the plist from the project settings**: the number
  actually embedded would revert to the build settings on the next build. So the
  native template uses `agvtool new-version -all`, which is the right method here.

⚠️ `agvtool` requires **Apple Generic** versioning (`VERSIONING_SYSTEM =
apple-generic`), the default for recent Xcode projects. The template checks this
**before** building and stops outright otherwise — a 20-minute build ending in a
"redundant build version" rejection costs more than an immediate failure.

### What to adapt

In both native templates, an `À ADAPTER POUR VOTRE PROJET` box lists the
variables: app identifier, Gradle module (`app` by convention), Xcode project
folder and scheme name.

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
