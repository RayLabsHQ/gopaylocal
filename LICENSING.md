# Licensing

GoPayLocal uses two licenses, split by directory.

| Path | License | What it is |
|---|---|---|
| `apps/` (`api`, `dashboard`, `admin`, `web`, `docs`) | [AGPL-3.0-only](LICENSE) | The GoPayLocal service: API Worker, dashboards, marketing site and docs |
| `packages/` (`js-sdk`, `react-sdk`, `banner`, `shared`) | MIT (see the `LICENSE` file in each package) | Code that runs on merchants' websites, plus the shared types and constants the SDKs and the service use |

Files elsewhere in the repository (build configuration, CI, end-to-end tests)
are covered by the AGPL-3.0-only root [`LICENSE`](LICENSE) unless they say
otherwise. Each `package.json` carries the matching SPDX identifier
(`AGPL-3.0-only` or `MIT`).

Copyright (c) 2026 RayLabs.

This page is a plain-language summary to help you decide what applies to you. It
is not legal advice, and where it differs from the license texts, the license
texts govern.

## Why two licenses

Merchants put the banner script and the SDKs inside their own websites and
apps. Those packages are MIT so that embedding them never places any obligation
on the merchant's own code. The service itself is AGPL so that anyone who runs
a modified copy of it for other people shares their changes, the same way we
share ours.

## If you are a merchant embedding the banner or an SDK

This covers the `<script>` banner, `@gopaylocal/js` and `@gopaylocal/react`.

- You may use, copy, modify, bundle and ship them in any website or app,
  including closed-source and commercial ones.
- Your own code stays under whatever license you choose. The MIT License places
  no requirements on it.
- The one condition: copies of the package code you distribute (for example, a
  JavaScript bundle that includes the SDK) must keep the MIT copyright and
  license notice. Most bundlers can preserve license comments or emit a
  third-party notices file for this.
- Calling the hosted GoPayLocal API from your site does not bring your site
  under the AGPL. Use of the hosted service is governed by its
  [terms of service](https://gopaylocal.com/legal/terms), not by these licenses.

## If you run your own copy of the service

This covers everything under `apps/`.

- **Running it unmodified**, for yourself or for others, is allowed. The
  self-hosted mode (`SELF_HOSTED="true"`) exists for exactly this.
- **Modifying it for use only inside your organization** does not require you
  to publish your changes publicly.
- **Modifying it and letting other people use it over a network** (for example,
  offering it to customers as a hosted service) triggers section 13 of the
  AGPL: you must offer everyone who interacts with your modified version the
  complete corresponding source code of that version, under AGPL-3.0-only, at
  no charge. A link to a public repository with your changes, shown in the
  product, is the usual way to do this.
- **Distributing copies** (modified or not) means passing on the source code
  and the AGPL license with them, as with any GPL-family license.
- The AGPL parts include MIT code from `packages/` (for example, the API bundles
  `packages/shared`). That code stays available under MIT on its own; the
  combined service is distributed under the AGPL.

## Contributions

Contributions are accepted under the license of the files they change: AGPL-3.0-only
for `apps/`, MIT for `packages/`. There is no separate contributor license
agreement. See [CONTRIBUTING.md](CONTRIBUTING.md#licensing-of-contributions).

## Third-party code

Dependencies installed through pnpm are covered by their own licenses, listed
in each dependency's package.

Third-party data and assets that ship with the repository (the VPN and Tor
lists, including IPLocate data under CC BY-SA 4.0, and the bundled fonts) are
credited in [NOTICE](NOTICE).
