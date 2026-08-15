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
