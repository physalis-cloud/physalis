---
title: Publish an Android app to Google Play
order: 5
icon: RiAndroidLine
summary: From zero to an AAB published on Google Play from your CI — create the app in Physalis, get the Google service account, import the keystore, and trigger publishing with no secret in the pipeline.
level: intermediate
duration: ~30 min
published: true
---

# Publish an Android app to Google Play

This guide takes you from an Android application to its **automatic publishing
to Google Play from your CI**, without ever putting a signing secret in your
repo. Physalis holds the keystore and the service account; your CI builds the
AAB and uploads it directly.

The real friction is not in Physalis — it is at Google. This tutorial walks you
through both consoles (Google Cloud + Play Console) screen by screen.

## What you'll accomplish

- An Android application declared in Physalis, with its keystore and Google Play
  access.
- A GitHub workflow that publishes a signed AAB to a test track on each trigger —
  with no GitHub secret.

## Prerequisites

- Mobile deployment is **enabled on your project** (project Settings → Mobile
  deployment). See the [Mobile deployment](mobile-deployment) reference.
- A **CI/CD connection** is linked to the project and the **repo** is set
  (Settings tab).
- Your app **already exists** on the Play Console (the very first AAB of a
  package must be published manually once; the API takes over afterwards).

## 1. Create the application in Physalis

Project **Mobile** tab → **New application**:

- **Platform**: Android
- **applicationId**: the package identifier, reverse-DNS (e.g.
  `com.example.myapp`)
- **Name**: a readable label
- (optional) **Group**: to sort dev/staging/prod

## 2. The keystore

If you already have a signing keystore, keep it. Otherwise generate one:

```bash
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias upload
```

> **Play App Signing (recommended).** Let Google manage the final signing key
> and provide only an **upload key**. A lost upload key can be reset; a signing
> key lost **outside** Play App Signing is permanent (republish under another
> package). Enable Play App Signing in the console.

In the Physalis app, import **five** credentials (the "Import a credential"
button):

| Type | Value |
|---|---|
| Android keystore | the `.jks` file |
| Keystore password | the `storepass` |
| Key alias | the alias (`upload` above) |
| Key password | the `keypass` |
| Google Play service account | the JSON from step 3 |

> ⚠️ The password entered when importing the keystore only serves to **read the
> expiry date** — it is not kept. Import it **also** as the "Keystore password"
> credential. Without the three text values, signing will fail.

## 3. The Google Play service account

This is what lets your CI upload via the API. Two parts.

### a. Create the service account (Google Cloud)

1. [console.cloud.google.com](https://console.cloud.google.com) → select (or
   create) a project.
2. **☰ → IAM & Admin → Service Accounts → Create service account**. Name it
   (`play-ci`), **no role**, Done.
3. Open it → **Keys → Add key → JSON** → the file downloads. **This is what you
   import into Physalis.**
4. **☰ → APIs & Services → Library** → search **Google Play Android Developer
   API** → **Enable**. (Often forgotten — without it nothing works.)

### b. Grant access (Play Console)

The "API access" page having moved, the simplest path is via users:

1. [play.google.com/console](https://play.google.com/console) → **Users and
   permissions** → **Invite new users**.
2. Paste the **service account email**
   (`play-ci@…iam.gserviceaccount.com`).
3. Under **App permissions**, select your app and tick the **minimum** (not
   "Admin"):
   - **Release apps to testing tracks**;
   - **Manage testing tracks and edit tester lists**.
   (To publish to production later, then add "Release to production, exclude
   devices, and use Play App Signing".)
4. **Invite**.

> **Delay.** The API may take a few minutes to ~24 h before it accepts the
> account. A `permission denied` right after is normal — retry.

Finally import the JSON into Physalis (app → Google Play service account), then
**delete the local copy of the file** — it is a secret.

## 4. Version and build number

On the application's card, set the **version** (e.g. `1.4`) and the **last
published build number** (the `versionCode` of your last release, e.g. `4`).
Physalis will serve `5`, `6`… automatically on each deployment.

## 5. Authorize the pipeline (the policies)

A Capacitor app first builds its web layer, so **two** policies on the same
`(repo, workflow, branch)`:

- **Mobile policy** (in the app, "Publishing from CI" section): workflow
  `release-android.yml`, branch `production`.
- **Server policy** (project **Policies** tab): same workflow, same branch,
  environment `production` — it serves the web build's `VITE_*`.

A pure-native app only needs the mobile policy.

## 6. The workflow

Copy the templates from the public repo into your repo and adapt the `env` block
(see the "ADAPT" header):

- `.github/workflows/release-android.yml` (template
  `deploy-mobile-android-capacitor.modele.yml`)
- `fastlane/Fastfile` (template `fastlane.Fastfile.modele`)

The workflow fetches the `VITE_*` and the signing material via OIDC, builds the
signed AAB and uploads it with `fastlane supply`. By default it is triggered
**manually** (`workflow_dispatch`): launch it from GitHub's Actions tab,
choosing the track (`internal` by default).

## Published

The green run drops the AAB on your test track. Check it in the Play Console.
The build number incremented itself in Physalis.

For the iOS version, follow the tutorial
[Publish an iOS app to the App Store](tuto:publish-ios).
