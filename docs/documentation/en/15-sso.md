---
title: SSO & external sign-in
order: 15
icon: RiShieldKeyholeLine
summary: Enterprise SSO (Google, GitHub, Microsoft, Okta, Keycloak, OIDC) and signing in with a personal account.
---

# SSO & external sign-in

Physalis offers two federated sign-in mechanisms, alongside the classic
password:

- **Enterprise SSO** — your members sign in through your organization's IdP
  (Google Workspace, GitHub, Microsoft Entra, Okta, Keycloak, or any standard
  OIDC provider). Configured by the workspace **owner**.
- **Sign in with a personal account** (social login) — a member links their
  personal Google / GitHub / Microsoft account and uses it to sign in, in
  addition to their password. Enabled by the member themselves.

> 🔒 **Security principle — no automatic account creation.** SSO only signs in
> members who have **already been invited** to the workspace. A federated
> identity that doesn't match an existing member is **rejected**, never
> created. To grant someone access, invite them first (see *Organizations &
> roles*); they can then sign in via SSO.

---

## Enterprise SSO

### What it's for

Your team signs in to Physalis with your identity provider's credentials, with
no dedicated Physalis password. You keep access control in your IdP (disabling
an account, MFA, etc.).

### Configure a provider

Restricted to the **owner of the workspace's primary organization**.

1. **My account → SSO tab**.
2. Pick the tab of the provider you want (Google, GitHub, Microsoft, Okta,
   Keycloak, OIDC). You can configure and enable **several**.
3. Fill in the fields (see the table below), set the **allowed domains**,
   tick **Enable**, then **Save**.
4. The **Test** button validates the OIDC discovery of the issuer.

The *client secret* is stored encrypted and never shown again: leave the field
empty when editing to keep the current one.

### Redirect URL (callback)

On the IdP side, register the redirect URL of **your subdomain**:

```
https://<your-workspace>.physalis.cloud/api/auth/callback/<provider>
```

where `<provider>` is `google`, `github`, `microsoft`, `okta`, `keycloak` or
`oidc`. Example for Google on the *acme* workspace:
`https://acme.physalis.cloud/api/auth/callback/google`.

### Fields per provider

| Provider | Required fields | Where to create the app |
|---|---|---|
| **Google** | Client ID + secret | Google Cloud Console → OAuth credentials |
| **GitHub** | Client ID + secret | GitHub → Settings → Developer settings → OAuth Apps |
| **Microsoft** | Client ID + secret (+ Tenant ID, `common` by default) | Azure → App registrations |
| **Okta** | Client ID + secret + **Issuer URL** | Okta Admin → Applications (OIDC Web) |
| **Keycloak** | Client ID + secret + **Issuer URL** | Keycloak console → Clients |
| **OIDC** (generic) | Client ID + secret + **Issuer URL** | Any OpenID Connect–compliant IdP |

> **Allowed domains**: restrict sign-in to verified emails from specific
> domains (e.g. `acme.com`). An identity outside those domains is rejected —
> useful to prevent a personal account on the same provider from getting in.

### Enforce SSO

The **Enforce SSO** option (tenant-wide) disables password sign-in for **all**
members: they can only sign in through the enabled SSO provider(s). An
anti-lockout safety net keeps the password as long as no provider is enabled.

### Enable / disable

Each provider is configured and enabled **independently**. Disabling a provider
simply removes its button from the sign-in page, without deleting its
configuration.

> ✅ **Availability**: Google, GitHub and Microsoft are validated in
> production. Okta, Keycloak and generic OIDC use the same standard OIDC flow
> and are available — validate them in your environment before a broad rollout.

---

## Sign in with a personal account (social login)

Handy for members who'd rather sign in with one click using their **personal**
Google, GitHub or Microsoft account, without relying on an enterprise IdP. It
uses Physalis's own OAuth apps: **nothing to configure** on the workspace side.

### Link your account

1. **My account → Security → Sign in with an external account**.
2. Click **Link** next to the provider you want.
3. Authenticate with the provider; the identity is attached to your Physalis
   account. You can **unlink** at any time.

Linking is **explicit**: it can only be done while signed in to your account.
No automatic linking.

### Sign in

Once linked, a button (“Google”, “GitHub”, “Microsoft”) appears on the sign-in
page, alongside the password. One click signs you in.

### Workspace-level control

The owner can globally enable/disable social login from **My account → SSO →
Social login tab**. When off: no social button, linking hidden. A provider
already configured as **enterprise SSO** is not offered twice as social.

---

## Browser extension

Whatever your sign-in method on the **web** (password, SSO or social), the
Physalis browser extension, if installed, **attaches automatically** to your
session — no extra input. The classic login (email + password + TOTP code)
remains available directly from the extension popup for password accounts.

---

## In short

- **Enterprise SSO** = your invited members sign in through your IdP;
  configured by the owner, multi-provider, callback on your subdomain,
  “enforce SSO” option.
- **Social login** = a member links their personal account and signs in with
  it; can be enabled/disabled by the workspace.
- **Never auto-provisioning**: you sign in, you don't create an account.
- **Extension**: any web sign-in attaches the extension automatically.
