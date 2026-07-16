---
title: Email
order: 12
icon: RiMailSendLine
summary: Send emails from your own domain through Physalis's sending service — DNS authentication (SPF/DKIM/DMARC), authorised senders, history and an API key injected into your environments.
---

# Email

The **Email** module lets a project send emails from **your own domain**
through Physalis's sending service. The API key and the domain are injected
into each environment's `.env` at deployment — your application just reads
them.

Physalis handles:

- Registering your sending domain
- Generating the DNS records (SPF, DKIM, DMARC) and verifying them
- Managing **authorised senders** ("From" addresses)
- Sending test emails and browsing the **history**
- Automatic API key rotation

## Prerequisites

The email service must first be **enabled for the client** (organisation).
An OWNER enables it from the **Security** page (click your email in the
header). Until then, the tab shows: *"The email service is not enabled for
this client."*

> Permissions: connecting, verifying, sending and managing senders require the
> **EDITOR** role or above on the project. **VIEWER** roles can view the state,
> the senders and the history.

## Concepts

```
Project
  └── Email configuration
        ├── Sending domain (e.g. mydomain.com)
        ├── DNS records (SPF · DKIM · DMARC)
        ├── API key (encrypted, injected at deployment)
        ├── Authorised senders ("From" addresses)
        └── Send history
```

A project can only connect **one domain** at a time.

## Connect a domain

> Permissions: **EDITOR** or above.

1. Open a project → **Email** tab.
2. Enter your **sending domain** (e.g. `mydomain.com`) then click **Connect**.
3. Physalis registers the domain with the sending service, generates a
   project-specific API key (encrypted immediately) and displays the **DNS
   records to create**.

## DNS records and verification

After connecting, the **Details** tab shows a table of records to create at
your registrar (Type / Name / Value):

- **SPF** — authorises the service to send for your domain.
- **DKIM** — cryptographically signs your emails.
- **DMARC** — authentication and reporting policy.

1. Add these records at your **DNS registrar**.
2. Click **Verify DNS**.
3. Physalis checks SPF / DKIM / DMARC and shows the result (e.g.
   *"SPF: yes · DKIM: yes · DMARC: yes"*). Once everything is valid, the badge
   turns to **Verified**.

> DNS propagation can take a few minutes to a few hours. Physalis does not
> create the records for you: verification only checks that they are present.

## Authorised senders

Before sending, declare at least one sending ("From") address on your domain.

- **Senders** tab → fill in **Address** (e.g. `hello@mydomain.com`) and
  **Name** (e.g. `Support`), then **Add**.
- You can delete a sender at any time.

> A sender is an authorised sending identity on your domain, not a mailbox.

## Injected environment variables

The **Details → Environment variables** tab lists the variables injected into
**each environment's** `.env` at deployment:

```
PHYSALIS_EMAIL_API_KEY=...           # project API key (secret)
PHYSALIS_EMAIL_DOMAIN=mydomain.com   # your sending domain
PHYSALIS_EMAIL_URL=https://...       # sending service endpoint
```

- `PHYSALIS_EMAIL_API_KEY` is never stored in clear text: it is encrypted
  (AES-256-GCM) and decrypted only at deployment. You can **Reveal** it
  occasionally from the UI (EDITOR+, audited action).
- Your application reads these variables to call the sending service.

> ⚠️ Revealing the key is rate-limited (anti-abuse) and logged
> (`SECRET_REVEAL`).

## Send a test email

From the **Send** tab (EDITOR+):

1. Choose the **Sender** (one of the authorised senders).
2. Fill in the **Recipient**, the **Subject** and the **Message (HTML)**.
3. Click **Send**.

> Sends from the UI are rate-limited (anti-abuse). This tab is for testing; for
> application sending, use the variables injected into your code.

## History

The **History** tab lists the domain's sends (Status, Recipient, Subject,
Date), with a **Refresh** button. Possible statuses are **Sent** and **Failed**.

## Automatic key rotation

If key rotation is enabled for your organisation, the **Details** tab offers an
**Automatic rotation** section:

1. Tick **Enable automatic API key rotation**.
2. Set the **interval (in days)**.
3. **Save** — the next rotation date is displayed.

Rotation follows a **blue/green** strategy:

1. A **new key** is generated and encrypted.
2. A **redeploy** is triggered to reload the new value.
3. The **old key is only revoked at the next cycle**, giving every environment
   time to redeploy.

> If a rotation fails, no key is revoked and a retry is scheduled automatically.

See [Secret rotation](rotations) for the general principle.

## Disconnect

**Details → Disconnect** (EDITOR+). Disconnecting **revokes the API key** with
the sending service and deletes the local configuration. The variables are no
longer injected into subsequent deployments.

## Permissions

| Action                                  | Required role                       |
|-----------------------------------------|-------------------------------------|
| View state, senders, history            | VIEWER+                            |
| Connect / disconnect a domain           | EDITOR+                            |
| Verify DNS                              | EDITOR+                            |
| Add / delete a sender                   | EDITOR+                            |
| Send an email, reveal the key           | EDITOR+                            |
| Configure automatic rotation            | EDITOR+ (rotation enabled for org)  |
