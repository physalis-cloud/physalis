---
title: Publish an iOS app to the App Store
order: 6
icon: RiAppleLine
summary: From zero to an iOS build on TestFlight from your CI — create the app in Physalis, get the App Store Connect API key, the certificate and the profile, and trigger publishing with no secret in the pipeline.
level: intermediate
duration: ~30 min
published: true
---

# Publish an iOS app to the App Store

This guide takes you from an iOS application to its **publishing on TestFlight
(then the App Store) from your CI**, with no signing secret in your repo.
Physalis holds the certificate, the profile and the API key; your CI builds the
`.ipa` on a macOS runner and uploads it directly to Apple.

> **No Mac needed for this guide.** Your CI's macOS runner compiles; you only
> need to grab three things from App Store Connect.

## Prerequisites

- Mobile deployment is **enabled on your project** (Settings → Mobile
  deployment). See [Mobile deployment](mobile-deployment).
- A **CI/CD connection** is linked to the project and the **repo** is set.
- An **Apple Developer** account with admin rights.

## 1. Create the application in Physalis

Project **Mobile** tab → **New application**:

- **Platform**: iOS
- **bundleId**: the identifier, reverse-DNS (e.g. `com.example.myapp`)
- **Name**: a readable label
- **Team ID / publisher** (optional but useful): your Apple Team ID (10
  characters)

## 2. The App Store Connect API key (`.p8`)

This is the bootstrap credential: it authenticates your CI to Apple, without an
Apple ID or two-factor.

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users and
   Access** → **Integrations** tab (or **Keys**) → **App Store Connect API**.
2. **Generate API Key** → give it a name, role **App Manager** (enough to
   publish).
3. Note the **Key ID** and the **Issuer ID** (the Issuer ID is at the top of the
   page and may show **only once** — copy it).
4. **Download API Key** → the `.p8` file. ⚠️ **It can never be re-downloaded**:
   keep it just long enough to import it, then delete the local copy.

In Physalis, import three credentials:

| Type | Value |
|---|---|
| App Store Connect API key (`.p8`) | the downloaded file |
| Key ID | the key identifier |
| Issuer ID | the issuer identifier |

## 3. The distribution certificate (`.p12`) and the profile

You need a **distribution certificate** and an **App Store provisioning
profile** for the app's bundleId.

- If you already have them (exported from Keychain or previously generated),
  reuse them.
- A `.p12` exported from the **macOS Keychain** is protected by a password: note
  it, you will be asked for it.

In Physalis, import:

| Type | Value |
|---|---|
| Distribution certificate (`.p12`) | the file |
| `.p12` password | the export password |
| Provisioning profile (`.mobileprovision`) | the file |

> ⚠️ The password entered when importing the `.p12` serves to **read the expiry
> date** — it is not kept. Import it **also** as the ".p12 password" credential.

The certificate and profile last ~1 year. Physalis extracts their expiry date on
import and will alert you before it lapses.

## 4. Version and build number

On the application's card, set the **version** (e.g. `1.9`) and the **last
published build number** (the `CFBundleVersion` of your last release, e.g. `10`).
Physalis will serve `11`, `12`… automatically.

## 5. Authorize the pipeline (the policies)

A Capacitor app first builds its web layer, so **two** policies on the same
`(repo, workflow, branch)`:

- **Mobile policy** (in the app, "Publishing from CI" section): workflow
  `release-ios.yml`, branch `production`.
- **Server policy** (project **Policies** tab): same workflow, same branch,
  environment `production` — it serves the web build's `VITE_*`.

A pure-native app only needs the mobile policy.

## 6. The workflow

Copy the templates from the public repo into your repo and adapt the `env` block
(see the "ADAPT" header):

- `.github/workflows/release-ios.yml` (template
  `deploy-mobile-ios-capacitor.modele.yml`)
- `fastlane/Fastfile` (template `fastlane.Fastfile.modele`)

The workflow runs on a **macOS runner**. It fetches the `VITE_*` and the signing
material via OIDC, extracts the profile name and Team ID from the
`.mobileprovision` (nothing is hardcoded), builds the `.ipa` with manual
signing, and uploads it to TestFlight. By default it is triggered **manually**
(`workflow_dispatch`).

> **Capacitor.** The native project is always named `App.xcworkspace` / scheme
> `App` (imposed by Capacitor), and it is regenerated on each build by
> `npx cap add`. The template already handles this.

## On TestFlight

The green run drops the build on TestFlight. You find it in App Store Connect
after a few minutes of Apple processing. The build number incremented itself in
Physalis.

For the Android version, follow the tutorial
[Publish an Android app to Google Play](tuto:publish-android).
