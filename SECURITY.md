# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull
request or discussion for a security problem.

Use either channel:

- **GitHub private vulnerability reporting:** open the
  [Security tab](https://github.com/RayLabsHQ/gopaylocal/security) of this
  repository and choose **Report a vulnerability**
  ([direct link](https://github.com/RayLabsHQ/gopaylocal/security/advisories/new)).
- **Email:** security@gopaylocal.com

Helpful details to include:

- the affected component (see the scope below) and whether you found it on the
  hosted service, a self-hosted instance or a local checkout (with the commit);
- steps to reproduce or a proof of concept;
- the impact you believe it has;
- whether you would like to be credited, and under what name.

## Scope

In scope:

- the API Worker (`apps/api`), including authentication, webhooks and the
  banner endpoints;
- the merchant dashboard (`apps/dashboard`) and the admin dashboard
  (`apps/admin`);
- the banner script (`packages/banner`) and the JavaScript and React SDKs
  (`packages/js-sdk`, `packages/react-sdk`);
- the hosted GoPayLocal service at `gopaylocal.com` and its subdomains.

Out of scope:

- vulnerabilities in payment providers' own platforms (report those to the
  provider);
- vulnerabilities in third-party dependencies with no demonstrated impact on
  GoPayLocal (report them upstream, and tell us if GoPayLocal is affected);
- self-hosted instances run by other people (contact their operator);
- denial-of-service, load testing, spam and social engineering.

## Testing against the hosted service

GoPayLocal is open source, so the best place to test is a local or self-hosted
instance (see [CONTRIBUTING.md](CONTRIBUTING.md)). If you do test against the
hosted service:

- use only accounts, organizations and API keys that you created yourself;
- never access, modify or delete another customer's data. If you reach data that
  is not yours, stop, do not keep a copy, and tell us what you saw in your report;
- do not run automated scanners or traffic volumes that could degrade the
  service for other customers;
- do not connect payment-provider accounts that you do not own.

## What to expect

GoPayLocal is maintained by a very small team, so these are targets rather than
guarantees:

- acknowledgement of your report within **5 business days**;
- an initial assessment (whether we can reproduce it and how severe it is)
  within **10 business days**;
- status updates at least every **two weeks** until the issue is resolved.

Fixes ship to the hosted service and to the `main` branch. There are no
maintained release branches, so fixes are not backported to older commits.
Self-hosters should update to the latest `main`.

We ask that you keep the details private until a fix has been released, or for
90 days after your report, whichever comes first. We are happy to agree a
different timeline with you when a fix needs longer. With your permission, we
will credit you in the published advisory.

We do not currently run a paid bug bounty.
