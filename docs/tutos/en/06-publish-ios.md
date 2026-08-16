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
- An **Apple Developer** account with admin rights — enrol at
  [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/),
  $99/year.

> **Open it first.** It is the one item in this guide that cannot be settled the
> same day. An **individual** enrolment publishes under your own name; an
> **organization** enrolment publishes under the company's, and requires a
> **D-U-N-S** number plus a review by Apple — anywhere from a few days to
> several weeks. Apple provides a
> [D-U-N-S lookup tool](https://developer.apple.com/enroll/duns-lookup/) (Apple
> ID required): start there, many companies already have one without knowing.

![Mobile deployment enabled in the project settings](/tutos/en/publish-ios-01.png)

> **Already on the App Store, or brand new?** Both work. Only one thing cannot
> go through the API: **creating the app record** in App Store Connect (step 3).
> The API key Physalis holds can do everything else — upload builds, drive
> TestFlight — but not create an app: that is the one operation Apple keeps in
> the UI. The first build itself ships from the pipeline like every other one;
> step 8 covers that first pass.

## 1. Create the application in Physalis

Project **Mobile** tab → **New application**:

- **Platform**: iOS
- **bundleId**: the identifier, reverse-DNS (e.g. `com.example.myapp`)
- **Name**: a readable label
- **Team ID / publisher** (optional but useful): your Apple Team ID (10
  characters)

![New iOS application form](/tutos/en/publish-ios-02.png)

The **Version** and **Last published build no.** fields on the same form are
what step 5 is about — leave them as they are for now.

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

## 3. Register the app with Apple

Two records, done once. Skip this step if your app is already live.

1. **The bundle ID**, in the [developer portal](https://developer.apple.com/account/resources/identifiers/list)
   → **Identifiers** → **+** → App IDs → App. Use exactly the `bundleId`
   declared in step 1, and tick the capabilities your app needs. This is what
   the provisioning profile in step 4 will reference.
2. **The app record**, in [App Store Connect](https://appstoreconnect.apple.com)
   → **Apps** → **+** → **New App**: iOS platform, name, language, the bundle ID
   above, and a SKU (any internal reference).

This is the one operation Apple does not expose through the API: an App Store
Connect API key can upload builds and drive TestFlight, but not create an app.
Without this record, the upload fails on a message that does not say why: `No
suitable application records were found. Verify your bundle identifier is
correct.`

## 4. The distribution certificate (`.p12`) and the profile

You need a **distribution certificate** and an **App Store provisioning
profile** for the app's bundleId. Two paths — and the first needs no Mac.

### Let Physalis generate them

On the application's card, **Generate signing material**. From the `.p8` key of
step 2 alone, Physalis chains the key pair, the CSR, the distribution
certificate, the `.p12` and the provisioning profile, and stores them encrypted.
The private key is born inside the vault and does not leave it.

This is where this guide keeps its promise: **a Mac is for compiling, not for
generating**. A CSR and a `.p12` are cryptography, not Xcode — the round trip
through the macOS Keychain was never more than a habit.

Two Apple-side limits:

- the **App ID must already be registered** in your developer account — that is
  step 3;
- Apple **caps distribution certificates** (2 to 3 per account). Regenerating
  consumes one, and the profiles tied to the old certificate stop signing. The
  old material stays visible in the application's history.

### Or import your own

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

The certificate and profile last ~1 year. Physalis extracts their expiry date
and will alert you before it lapses.

### Verify before running a pipeline

The material is now complete. On the application's card, **Verify material**
checks the consistency of what is stored — certificate and profile readable, not
expired — then **queries App Store Connect** with your API key.

Two answers are worth the trip. "The key works but does not see this bundle id"
means the record from step 3 is missing, or the key's role is too narrow — not
that the key is bad. And "Apple rejects the key" points at a Key ID and an
Issuer ID that do not match each other, the most common mix-up at import time.

## 5. Version and build number

On the application's card — or right from the creation form in step 1 — set the
**version** (e.g. `1.9`) and the **last published build number** (the
`CFBundleVersion` of your last release, e.g. `10`). Physalis will serve `11`,
`12`… automatically.

![The Version and Last published build no. fields](/tutos/en/publish-ios-03.png)

For a brand-new app, leave the counter at **`0`**: the first deployment will
serve `1`.

## 6. Authorize the pipeline (the policies)

A Capacitor app first builds its web layer, so **two** policies on the same
`(repo, workflow, branch)`:

- **Mobile policy** (in the app, "Publishing from CI" section): workflow
  `release-ios.yml`, branch `production`.

  ![The application's "Authorize a pipeline" form](/tutos/en/publish-ios-04.png)

- **Server policy** (project **Policies** tab): same workflow, same branch,
  environment `production` — it serves the web build's `VITE_*`.

  ![The project's Policies tab, binding repo · workflow · branch → environment](/tutos/en/publish-ios-05.png)

A pure-native app only needs the mobile policy.

## 7. The workflow

Two files to copy from the public repo, then adapt (see the "ADAPT" header):

- `.github/workflows/release-ios.yml` — template
  [deploy-mobile-ios-capacitor.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy-mobile-ios-capacitor.modele.yml)
- `fastlane/Fastfile` — template
  [fastlane.Fastfile.modele](https://github.com/physalis-cloud/physalis/blob/main/docs/fastlane.Fastfile.modele)
  (both the iOS **and** Android lanes live in this single file, at the repo root)

The workflow runs on a **macOS runner**.

### What the run does

1. **Two calls to Physalis, before any build**: `/api/deploy` for the `VITE_*`,
   `/api/deploy/mobile` for the `.p12` and its password, the
   `.mobileprovision`, and the `.p8` key with its two identifiers. Each with its
   own OIDC token, each covered by its own policy.
2. **Temporary keychain**: the certificate is imported into a keychain created
   for the run and destroyed at the end. The template immediately checks that
   this keychain exposes a complete signing identity — `import_certificate` does
   not fail the lane when the import fails, and `xcodebuild` would only notice
   later, on a message that does not name the cause.
3. **Profile and manual signing**: the profile name and Team ID are extracted
   from the `.mobileprovision`, nothing is hardcoded — swapping the profile in
   Physalis is enough. Manual signing is written to the `App` target only: a
   global setting would break the pods, which have no profile.
4. **Build and upload**: `xcodebuild` archives and exports the `.ipa`, then
   `upload_to_testflight` uploads it with the API key — no Apple ID, no
   two-factor.
5. **Report to the registry**: the run tells Physalis the build number, the
   track (`testflight`) and the outcome — `uploaded`, or `failed` if publishing
   broke. That is what feeds the application's **Releases** tab. A rejected
   report does not fail the run: the `.ipa` is already at Apple.
6. **Cleanup**: keychain destroyed, signing material and `.env.production`
   wiped from the runner.

No GitHub `secrets.*` is consumed, and that is the whole point of the setup.

### What to adapt

- `VAULT_PROJECT` and `MOBILE_APP`: the Physalis project slug and the
  `bundleId`.
- The template assumes a `frontend/` web root: adjust the paths if yours
  differs.
- The "Configure Info.plist" step: **the permission strings and display name are
  examples**, replace them with your own — they go to Apple and show up on the
  store listing.
- The "Generate app icon" step: the source icon path.

> **Capacitor.** The native project is always named `App.xcworkspace` / scheme
> `App` (imposed by Capacitor), and it is regenerated on each build by
> `npx cap add`: everything that customises it must be re-applied on every run.
> The template already handles this.

### Triggering

The template runs **manually** (`workflow_dispatch`), and that is a deliberate
choice: a server update is not a store release. A publication is asynchronous,
subject to review, strictly increasing in version number and **with no way
back** — it gets decided, platform by platform.

To publish on every push, add under `on:`:

```yaml
push:
  branches: [production]
```

Either way the run must start from the branch declared in the policy: it binds
the `(repo, workflow, branch)` triple, and a launch from another branch is
refused.

### Freezing releases without touching the repo

**Mobile** tab → the application → **Pause deploys**. `/api/deploy/mobile` then
returns 403 to any pipeline, with an explicit denial, and the signing material
stays intact; **Resume deploys** opens the tap again. This is the right circuit
breaker to freeze an app: it applies to every repo targeting it, without
disabling anything on the GitHub side.

![The Mobile tab: each application carries its own pause button](/tutos/en/publish-ios-06.png)

### A pure native app (no Capacitor)

The templates provided are those of a **Capacitor** app. For a 100 % native app,
drop the whole web part: the `/api/deploy` call, writing
`frontend/.env.production`, `npm ci`, `npm run build`, `npx cap add|sync`. What
remains is the signing bundle, your Xcode project and `upload_to_testflight` —
and a **single** policy, the mobile one: the server policy only serves the
`VITE_*`.

## 8. First publication

This step only concerns the **very first** build of an app. Skip ahead if it is
already live.

Unlike Google Play, Apple imposes no special regime on the first build: as soon
as the record exists (step 3), the upload goes through like any other. Two
details do block **distribution to testers**, though, and catch people out:

- **Export compliance.** Without the `ITSAppUsesNonExemptEncryption` key in the
  `Info.plist`, the build lands in TestFlight as "Missing Compliance" and is
  only distributable after answering the encryption question in App Store
  Connect — on every build. If your app only uses exempt encryption (standard
  HTTPS), add this line to the workflow's "Configure Info.plist" step and the
  question goes away:

  ```bash
  plutil -replace ITSAppUsesNonExemptEncryption -bool false "$PLIST"
  ```

- **Testers.** A TestFlight build reaches nobody until a tester group exists and
  the build is assigned to it. That is a one-off, in the TestFlight tab.

Expect a few minutes of Apple processing between the end of the run and the
build showing up. Making it **publicly** available on the App Store remains an
explicit decision: listing filled in, screenshots, submission for review. The
template stops at TestFlight; to go straight to the App Store, the `Fastfile`
shows where to swap `upload_to_testflight` for `upload_to_app_store`.

## On TestFlight

The green run drops the build on TestFlight. You find it in App Store Connect
after a few minutes of Apple processing. The build number incremented itself in
Physalis, and the release shows up in the application's **Releases** tab: build,
track, status and the pipeline that produced it.

The certificate and profile last a year, so Physalis watches their expiry and
will warn you by email at D-60, D-30 and D-7 — Apple will not.

For the Android version, follow the tutorial
[Publish an Android app to Google Play](tuto:publish-android).
