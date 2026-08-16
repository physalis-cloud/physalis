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
- A **Google Play developer account** — sign up at
  [play.google.com/console/signup](https://play.google.com/console/signup),
  $25 once.

> **Open it first.** It is the one item in this guide that cannot be settled the
> same day, and the rest will wait without you. At sign-up you choose between a
> **personal** and an **organization** account: that is the name shown under the
> app on the store. Google verifies the identity of new developers, and an
> organization account additionally requires a **D-U-N-S** number — the same
> identifier Apple asks for — which takes anywhere from a few days to several
> weeks to be issued depending on the country. If your company already has one,
> check before requesting a new one.

![Mobile deployment enabled in the project settings](/tutos/en/publish-android-01.png)

> **Already published, or brand new?** Both work. Only one thing cannot go
> through the API: **creating the app entry** in the Play Console (step 3). The
> first AAB itself ships from the pipeline like every other one — that is what
> step 8 is for. It is also the safest order: Play App Signing enrols the upload
> key from the key that signs the **first** release. A first AAB uploaded by
> hand with a keystore other than the one held by Physalis dooms every later run.

## 1. Create the application in Physalis

Project **Mobile** tab → **New application**:

- **Platform**: Android
- **applicationId**: the package identifier, reverse-DNS (e.g.
  `com.example.myapp`)
- **Name**: a readable label
- (optional) **Group**: to sort dev/staging/prod

![New Android application form](/tutos/en/publish-android-02.png)

The **Version** and **Last published build no.** fields on the same form are
what step 5 is about — leave them as they are for now.

## 2. The keystore

Two paths. The first needs no tooling at all.

### Let Physalis generate it

On the application's card, **Generate signing material**. Physalis builds the
upload key (RSA pair + certificate, ~27 years), its password and its alias, and
stores them encrypted: **four of the five credentials** land at once. The
private key is created inside the vault, so it never has to travel. No account
is required for this step; only the Google Play service account will be left,
in step 4.

> ⚠️ This is the **upload key**, the one Google can reset if you lose it — as
> long as Play App Signing is on. Not the app signing key, which stays with
> Google.

### Or import your own

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
| Google Play service account | the JSON from step 4 |

> ⚠️ The password entered when importing the keystore only serves to **read the
> expiry date** — it is not kept. Import it **also** as the "Keystore password"
> credential. Without the three text values, signing will fail.

## 3. Create the app entry on the Play Console

The one thing the API cannot do: it works on a `packageName` that already
exists, it does not create applications. Skip this step if your app is already
live.

1. [play.google.com/console](https://play.google.com/console) → **Create app**.
   Name, default language, app or game, free or paid.
2. The console **does not ask** for the package identifier: the **first AAB
   uploaded** is what binds the `applicationId`, permanently. All the more
   reason to let it ship from the pipeline, with the `applicationId` declared in
   step 1.
3. Fill in **App content**: privacy policy, app access, ads, content rating,
   target audience, data safety. While any of these is missing, no release can
   be sent for review — the upload itself already goes through.

The app stays listed as a **draft** until its first reviewed release: that is
expected at this point, step 8 deals with it.

## 4. The Google Play service account

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
> account. A `permission denied` right after is normal — the verification below
> will tell you when it has gone through.

Finally import the JSON into Physalis (app → Google Play service account), then
**delete the local copy of the file** — it is a secret.

### Verify before running a pipeline

The material is now complete. On the application's card, **Verify material**
first checks the consistency of what is stored — keystore readable with its
password, declared alias actually inside it — then **queries Google Play** for
what your service account is really allowed to do.

That is where you read, in two seconds, the three cases a `permission denied` at
the end of a pipeline cannot tell apart: invalid key, valid key but service
account not invited to the Play Console, or invited but with no right over
**this** application. Better known before ten minutes of build.

## 5. Version and build number

On the application's card — or right from the creation form in step 1 — set the
**version** (e.g. `1.4`) and the **last published build number** (the
`versionCode` of your last release, e.g. `4`).
Physalis will serve `5`, `6`… automatically on each deployment.

![The Version and Last published build no. fields](/tutos/en/publish-android-03.png)

For a brand-new app, leave the counter at **`0`**, as above: the first
deployment will serve `1`.

## 6. Authorize the pipeline (the policies)

A Capacitor app first builds its web layer, so **two** policies on the same
`(repo, workflow, branch)`:

- **Mobile policy** (in the app, "Publishing from CI" section): workflow
  `release-android.yml`, branch `production`.

  ![The application's "Authorize a pipeline" form](/tutos/en/publish-android-04.png)

- **Server policy** (project **Policies** tab): same workflow, same branch,
  environment `production` — it serves the web build's `VITE_*`.

  ![The project's Policies tab, binding repo · workflow · branch → environment](/tutos/en/publish-android-05.png)

A pure-native app only needs the mobile policy.

## 7. The workflow

Two files to copy from the public repo, then adapt (see the "ADAPT" header):

- `.github/workflows/release-android.yml` — template
  [deploy-mobile-android-capacitor.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy-mobile-android-capacitor.modele.yml)
- `fastlane/Fastfile` — template
  [fastlane.Fastfile.modele](https://github.com/physalis-cloud/physalis/blob/main/docs/fastlane.Fastfile.modele)
  (both the iOS **and** Android lanes live in this single file, at the repo root)

### What the run does

1. **Two calls to Physalis, before any build**: `/api/deploy` for the `VITE_*`,
   `/api/deploy/mobile` for the keystore, its passwords and the service
   account. Each with its own OIDC token, each covered by its own policy. An
   incomplete setup fails right here, within seconds.
2. **Immediate checks**: platform of the app served, empty credentials, alias
   actually present in the keystore. Without them, a configuration mistake
   would only surface after ~5 min of build, on a gradle message that does not
   name it.
3. **Build**: `npm run build` (Vite reads `frontend/.env.production`),
   `npx cap sync`, applying the `versionCode`/`versionName` served by Physalis,
   icons, manifest permissions.
4. **Signing and upload**: gradle signs with the fetched keystore, through
   `android.injected.signing.*` properties — nothing is written to the repo —
   then `fastlane supply` uploads the AAB.
5. **Report to the registry**: the run tells Physalis the build number, the
   track and the outcome — `uploaded`, or `failed` if publishing broke. That is
   what feeds the application's **Releases** tab. A rejected report does not
   fail the run: the AAB is already at Google.
6. **Cleanup**: signing material and `.env.production` wiped from the runner.

No GitHub `secrets.*` is consumed, and that is the whole point of the setup.

### What to adapt

- `VAULT_PROJECT` and `MOBILE_APP`: the Physalis project slug and the
  `applicationId`.
- The template assumes a `frontend/` web root: adjust the paths if yours
  differs.
- The "Generate app icons" and "Add permissions to AndroidManifest" steps are
  specific to your app.

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

![The Mobile tab: each application carries its own pause button](/tutos/en/publish-android-06.png)

### A pure native app (no Capacitor)

The templates provided are those of a **Capacitor** app. For a 100 % native
app, drop the whole web part: the `/api/deploy` call, writing
`frontend/.env.production`, `npm ci`, `npm run build`, `npx cap add|sync`. What
remains is the signing bundle, your gradle build and `fastlane supply` — and a
**single** policy, the mobile one: the server policy only serves the `VITE_*`.

## 8. First publication

This step only concerns the **very first** upload of a package. Skip ahead if
the app is already live.

While an application has never been published, the Play Console treats it as a
**draft**, and the API adds two rules:

- a non-`draft` release is refused — `Only releases with status draft may be
  created on draft app`;
- the edit cannot be sent for review on its own — `Changes cannot be sent for
  review automatically. Please set the query parameter changesNotSentForReview
  to true`.

The template handles both: run the workflow with **`first_release` ticked**. The
run builds and uploads the AAB exactly as usual, as a *draft* release — that AAB
is what binds the package's `applicationId` and enrols your upload key into Play
App Signing.

That leaves **one human gesture, once per package lifetime**: Play Console →
your app → **Send for review**. While the app is a draft, testers receive
nothing, whatever the pipeline did.

Once the app is out of draft, run it again **without** ticking `first_release`:
later publications are fully automatic.

> **Forgot the tick on the first run?** The error lands after the build, ~5 min
> later, and costs nothing: tick it and re-run. The `versionCode` served by
> Physalis will simply have moved up one — a build number has to increase, not
> to be contiguous.

## Published

The green run drops the AAB on your test track. Check it in the Play Console.
The build number incremented itself in Physalis, and the release shows up in the
application's **Releases** tab: build, track, status and the pipeline that
produced it.

Physalis also watches the keystore's expiry and will warn you by email at D-60,
D-30 and D-7 — neither Google nor GitHub will.

For the iOS version, follow the tutorial
[Publish an iOS app to the App Store](tuto:publish-ios).
