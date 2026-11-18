# Production deployments

`.github/workflows/deploy.yml` runs on pushes to `main` (including merged pull requests). It can
also be rerun manually from `main`. It verifies the repository, builds the hosted session UI,
applies pending auth D1 migrations, and deploys the app Worker and `shuttle.codes` download Worker.
After that succeeds, an Apple Silicon macOS job packages a desktop release. By default this is
an ad hoc build for manual installation, without Apple Developer credentials. A final job uploads
the binaries to R2, then publishes the manual download pointer `latest-mac.json` last.

Hosted UI changes reach the desktop's next page load. Changes to Electron or the bundled runner
are available as new downloads; signed builds can also install them through the update prompt. A Cloudflare deployment alone cannot replace an
installed desktop binary.

## GitHub configuration

Set these in the repository's Actions settings before merging. Infrastructure must already exist:
the configured D1 auth database, `shuttle-local` media bucket, `shuttle-releases` release bucket,
Worker secrets, and the custom domains. The workflow keeps Worker secrets already stored in
Cloudflare; it does not copy local `.dev.vars` files or create infrastructure.

Repository variables:

`SHUTTLE_SIGN_DESKTOP` defaults to unset/false. Set it to `true` only after adding all Apple
signing and notarization secrets listed below. CI then signs and notarizes the app, enables its
automatic updater, and publishes `latest-mac.yml`. Unsigned builds show a manual download link
in the sidebar and never replace the signed update manifest.

| Name                    | Value                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHUTTLE_WEB_URL`       | The production HTTPS app URL, also embedded in desktop builds.                                                                                                                                                                              |
| `SHUTTLE_DEPLOY_VARS`   | JSON object containing the current production Worker vars, including sandbox configuration and preview hostname. These override development defaults; the workflow sets `SHUTTLE_WEB_URL` from the variable above. Do not put secrets here. |
| `SHUTTLE_DEPLOY_ROUTES` | Optional JSON array of Wrangler custom-domain routes; defaults to `[]`.                                                                                                                                                                     |
| `SHUTTLE_SANDBOX_IMAGE` | Optional fallback image embedded in desktop builds.                                                                                                                                                                                         |

Apple secrets below are optional until `SHUTTLE_SIGN_DESKTOP` is enabled.

Repository secrets:

| Name                                        | Value                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                      | Token allowed to deploy the Workers and assets, read/apply D1 migrations, and deploy configured container images when applicable. Include zone permissions if managing custom domains. |
| `CLOUDFLARE_ACCOUNT_ID`                     | Account holding the Workers, D1 databases, and R2 buckets.                                                                                                                             |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 credentials with object read/write access to `shuttle-releases`. Uploads use the account's S3 endpoint and multipart uploads for large bundles.                                  |
| `MAC_CSC_NAME`                              | Developer ID Application identity name, consistently used across releases.                                                                                                             |
| `MAC_CSC_LINK`                              | Base64-encoded exported Developer ID Application `.p12` certificate, including its private key.                                                                                        |
| `MAC_CSC_KEY_PASSWORD`                      | Password protecting that certificate.                                                                                                                                                  |
| `APPLE_ID`                                  | Apple account used for notarization.                                                                                                                                                   |
| `APPLE_APP_SPECIFIC_PASSWORD`               | App-specific notarization password for that account.                                                                                                                                   |
| `APPLE_TEAM_ID`                             | Apple Developer team ID matching the signing certificate.                                                                                                                              |

Cloudflare deployment fails clearly if its configuration is missing. When signing is explicitly
enabled, missing Apple credentials fail the desktop job rather than silently falling back. The hosted app may already have
deployed when a later desktop job fails; an incomplete desktop release never replaces the public
update manifest.

## Versions and retries

CI sets the desktop package version to `0.1.<workflow run number>` in its checkout, without
committing a version bump to `main`. Every new workflow run gets a higher version; rerunning a
failed run keeps that run's version. A rerun never moves `latest-mac.json` or `latest-mac.yml`
back to an older version than the one already published; it still uploads its binaries. Keep this workflow's run-number sequence when changing the
release process, and choose a higher major/minor version if starting a new sequence.

Release jobs run in a single concurrency group without canceling an in-flight publication.
GitHub may replace pending runs with newer pushes, so the newest queued revision is deployed
next. Uploaded artifacts are retained with the workflow run. The download button follows the
DMG in `latest-mac.json`. Signed installed apps discover new versions at their next background
check or a manual check. Ad hoc builds require downloading and replacing the app manually;
macOS may require Open Anyway in System Settings → Privacy & Security.

A manual upgrade to the first Developer ID build will be needed to enable automatic updates.
Signed Mac installation and the real Cloudflare deployment must be tested after the credentials
are configured; neither can run in the Linux development sandbox.
