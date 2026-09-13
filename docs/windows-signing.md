# Windows code signing

The NSIS installer ships unsigned today: every download trips SmartScreen's
"unrecognized publisher" warning, and there is no config anywhere to sign it.
This sets up [Azure Trusted Signing][ats] rather than a classic PFX
certificate — new CA/Browser Forum rules already push OV/EV Authenticode keys
onto HSMs or cloud signing services, and Trusted Signing is Microsoft's own
answer to that: no physical token, ~$10/month, and `electron-builder` (^26)
speaks to it natively via `win.azureSignOptions`.

[ats]: https://learn.microsoft.com/en-us/azure/trusted-signing/overview

## Where the wiring lives

Nothing in `electron-builder.yml` — Windows signing config is *not* checked
in as a permanent block the way macOS signing is (`mac.hardenedRuntime`,
`dmg.sign`, …). Unlike macOS, which falls back to an ad-hoc self-signature
when no identity is configured, Azure Trusted Signing has no such fallback:
the moment `win.azureSignOptions` exists in config, `electron-builder` tries
to sign and hard-fails if it can't authenticate. So the whole thing lives in
`.github/workflows/ship.yml`'s `build` job instead, gated the same way the
macOS secrets are gated: the win leg of the matrix runs the ordinary unsigned
`electron-builder --win` command unless `AZURE_CLIENT_ID` is set, in which
case it appends `-c.win.azureSignOptions.*` flags built from the secrets
below. No secrets, no flags, no change in behavior — exactly today's build.

`ci.yml`'s `pack-win` job (a dry-run dir build, never published) and
`release.yml` (macOS-only; it has no Windows leg at all) are untouched —
`ship.yml` is the only workflow that ever produces a Windows installer.

## One-time Azure setup

1. **Trusted Signing account + certificate profile.** In the Azure portal,
   create a Trusted Signing resource, then a Certificate Profile under it.
   Public Trust profiles require a verified organization identity — this
   needs Microsoft's identity validation for **Dainami Pte Ltd** (the entity
   in `LICENSE`) before a profile can be issued. Note the account's region
   endpoint (e.g. `https://eus.codesigning.azure.net/`), the account name,
   and the certificate profile name — none of these three are secret, they
   just identify the resource, but they're passed as repo secrets below
   anyway for uniformity with the Apple side.
2. **A service principal to authenticate as.** Create a Microsoft Entra ID
   app registration with a client secret, then grant it the
   **Trusted Signing Certificate Profile Signer** role, scoped to the Trusted
   Signing account created above. This is what `electron-builder`
   authenticates with at build time (via Azure Identity's
   `EnvironmentCredential` — the three `AZURE_TENANT_ID` /
   `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` variables below, read directly
   from the environment, never from `electron-builder.yml`).

## GitHub secrets to add

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | The Entra ID tenant ID |
| `AZURE_CLIENT_ID` | The app registration's client (application) ID |
| `AZURE_CLIENT_SECRET` | The client secret's value |
| `AZURE_ENDPOINT` | The Trusted Signing account's region endpoint |
| `AZURE_CODE_SIGNING_ACCOUNT` | The Trusted Signing account name |
| `AZURE_CERT_PROFILE` | The certificate profile name |

`AZURE_CLIENT_ID` is the presence check `ship.yml` looks at — set all six or
none. The publisher name (`Dainami Pte Ltd`) is hardcoded in `ship.yml`
itself rather than added as a seventh secret, since it has to match the
certificate's subject exactly and isn't sensitive; update it there if the
legal entity signing the certificate ever changes.

Once all six secrets exist, the very next push to `main` ships a signed
Windows installer — nothing else to change.
