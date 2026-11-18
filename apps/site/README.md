# shuttle.codes

The landing page (`public/`) and the desktop app downloads, as one small Worker.

```bash
bun run dev      # http://127.0.0.1:8791
bun run deploy   # to shuttle.codes
```

Pages with code samples (the landing page and the docs) are written in `pages/` and copied into `public/`
with their code highlighted by Shiki (`scripts/build-pages.ts`). Wrangler does this before `dev`
and `deploy`; `bun run pages` does it on its own. Tag a block `<pre><code class="language-tsx">`.

## Desktop releases

The [production workflow](../../.github/workflows/deploy.yml) uploads desktop builds and
`latest-mac.json` into `shuttle-releases` after each deployment. See
[deployment setup](../../docs/deployments.md) for credentials and configuration.

Ad hoc builds are available for manual download without Apple credentials. Signing is optional
and explicitly enabled with `SHUTTLE_SIGN_DESKTOP=true` once Apple credentials are configured.
Only signed releases publish `latest-mac.yml`; ad hoc builds cannot replace that feed.

The signed app updater reads `/download/latest-mac.yml`. This mutable manifest is served without caching;
versioned DMG, ZIP, and blockmap downloads can be cached. `/download/mac` resolves the DMG in the
manual download pointer `latest-mac.json`, falling back to `LATEST_MAC` before the first automated release. Keep old versioned
files: an installed app may need a previous blockmap for differential downloads.

For a manual release, upload the versioned binaries first and the manifest last. Use the R2 S3
API for large files; Wrangler's single-object upload has a size limit. No GitHub credentials are
needed by desktop clients, even though the source repository is private.
