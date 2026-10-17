# Security

Optionwise runs on your own computer and never places real orders. It does store broker credentials locally (encrypted with your Windows account in the Windows app) and updates itself from GitHub Releases, so security reports are welcome.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you saw, the version (shown in the footer) and steps to reproduce. You should get a reply within a week.

## What is in scope

- Broker credentials or tokens leaking to the page, the logs, another website or another user of the computer.
- The local server accepting requests from other websites or other computers.
- The updater installing something that is not an official release.
- Anything that could place a real order (the app must never do this).

## Good practice for users

- Use read-only market-data tokens. Optionwise only requests market data.
- Never paste a token into a GitHub issue. Revoke and regenerate any token you have shared by mistake.
- Download Optionwise only from this repository's Releases page. Each release includes a `version.json` file listing SHA-256 checksums for the app files, which you can compare with `Get-FileHash Optionwise.exe -Algorithm SHA256` in PowerShell.
