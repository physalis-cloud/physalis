---
title: Set up the email service
order: 4
icon: RiMailSendLine
summary: Send emails from your own domain — domain connection, DNS (SPF/DKIM/DMARC), senders, test email, and API key injected into your environments.
level: intermediate
duration: ~15 min
published: true
---

# Set up the email service

This guide wires **sending emails from your own domain** into a project.

By the end, your application will send its emails through the Physalis service,
with an API key and a domain **injected automatically** into the `.env` of every
environment at deployment.

## What you will achieve

- Your **sending domain** connected and authenticated (SPF/DKIM/DMARC verified)
- An **authorized sender** declared and a **test email** sent
- The **email variables injected** into your environments, ready to use

## Prerequisites

- The **email service enabled for the client**.
- The **EDITOR** role or above on the project (connection, DNS, sending).
- Access to your **DNS registrar** to create records.
- An existing **project** (see [Create a project…](tuto:first-github-deployment)).

### Notes

**Enabling the email service** is a **client-level** setting, done **once**.

Each project then connects its own domain. A project can connect **only one
domain** at a time.

---

## 1. Enable the service and connect your domain

### Email service

Go to **My account** → **Services** tab → click the **“Enable email service”**
button.

![Enabling the email service from My account](/tutos/en/configure-email-service-01.png)

### Connect your domain

> Requires the **EDITOR** role or above.

1. Open a project → **Email** tab.
2. Enter your **sending domain** (e.g. `mydomain.com`) → **Connect**.
3. Physalis registers the domain, generates a **dedicated API key** (encrypted
   immediately) and displays the **DNS records to create**.

![Connecting the sending domain in the project's Email tab](/tutos/en/configure-email-service-02.png)

## 2. Create the DNS records

The **Details** tab shows a table (Type / Name / Value) to copy over to your
registrar:

- **SPF** — authorizes the service to send on behalf of your domain
- **DKIM** — cryptographically signs your emails
- **DMARC** — authentication and reporting policy

![DNS records to create](/tutos/en/configure-email-service-03.png)

Add these three records at your **DNS registrar**.

> ⚠️ Physalis **does not create** the records for you. DNS propagation can take
> anywhere from a few minutes to a few hours.

## 3. Verify the DNS

Back in the **Details** tab, click **“Verify DNS”**.

Physalis checks SPF / DKIM / DMARC and shows the result (e.g. *“SPF: yes ·
DKIM: yes · DMARC: yes”*).

Once everything is validated, the badge switches to **Verified**.

![DNS verification](/tutos/en/configure-email-service-04.png)

## 4. Add an authorized sender

Before sending, declare at least one “From” address on your domain.

**Senders** tab → fill in the **Address** (e.g. `hello@mydomain.com`) and the
**Name** (e.g. `Support`) → **Add**.

![Adding an authorized sender in the Senders tab](/tutos/en/configure-email-service-05.png)

> A sender is an authorized **sending identity**, not an inbox.

## 5. Send a test email

**Send** tab (EDITOR+):

1. pick the **Sender** (from the authorized ones);
2. fill in **Recipient**, **Subject** and **Message (HTML)**;
3. **Send**.

![Sending a test email](/tutos/en/configure-email-service-06.png)

> Sends from the UI are **rate-limited** (anti-abuse): this tab is for testing.
> For application sending, use the injected variables (step 6).

## 6. Use the injected variables

The **Details → Environment variables** tab lists what gets injected into the
`.env` of **every environment** at deployment:

```
PHYSALIS_EMAIL_API_KEY=...           # project API key (secret, encrypted)
PHYSALIS_EMAIL_DOMAIN=mydomain.com   # your sending domain
PHYSALIS_EMAIL_URL=https://...       # sending service endpoint
```

Your application reads these variables to call the service. The key is never
stored in plain text: it is decrypted only at deployment.

> You can **Reveal** the key occasionally from the UI (EDITOR+, a rate-limited
> action logged as `SECRET_REVEAL`).

## 7. (Optional) Enable automatic key rotation

If rotation is enabled for your organization, the **Details** tab offers an
**Automatic rotation** section:

1. tick **Enable automatic API key rotation**;
2. set the **Interval (days)**;
3. **Save**.

Rotation follows a **blue/green** strategy:

new key generated → redeployment → the old one is only revoked on the next cycle
(giving every environment time to redeploy).

![Automatic API key rotation section in the Details tab](/tutos/en/configure-email-service-07.png)

## Check that everything works

- The domain shows the **Verified** badge (step 3).
- The **test email** is received (step 5).
- The **History** tab lists the send with the **Sent** status.
- After a deployment, your application finds the `PHYSALIS_EMAIL_*` variables in
  its environment.

## Troubleshooting

- **“The email service is not enabled for this client”** → enable it from
  **My account → Services tab** (step 1).
- **DNS verification fails** → propagation still in progress, or a record copied
  incorrectly. Wait and re-verify; compare against the table from step 2.
- **Cannot send** → no **sender** declared (step 4), or the domain is not
  **Verified** yet.
- **The variables don't show up in the app** → they are injected **at
  deployment**: redeploy after connecting the domain.

## What's next?

- To go further:
  - [Email](email) — history, disconnection, detailed permissions
  - [Secret rotation](rotations) — the general principle behind API key rotation
  - [Secrets & categories](secrets) — how variables reach your environments
- Back to the start: [Create a project, connect it to GitHub and deploy it](tuto:first-github-deployment)
