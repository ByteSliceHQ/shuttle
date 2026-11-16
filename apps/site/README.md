# shuttle.codes

The landing page (`public/`) and the desktop app downloads, as one small Worker.

```bash
bun run dev      # http://127.0.0.1:8791
bun run deploy   # to shuttle.codes
```

## Desktop releases

The [production workflow](../../.github/workflows/deploy.yml) uploads signed desktop builds and
`latest-mac.yml` into `shuttle-releases` after each deployment. See
[deployment setup](../../docs/deployments.md) for credentials and configuration.

The app updater reads `/download/latest-mac.yml`. This mutable manifest is served without caching;
versioned DMG, ZIP, and blockmap downloads can be cached. `/download/mac` resolves the DMG in the
same manifest, falling back to `LATEST_MAC` before the first automated release. Keep old versioned
files: an installed app may need a previous blockmap for differential downloads.

For a manual release, upload the versioned binaries first and the manifest last. Use the R2 S3
API for large files; Wrangler's single-object upload has a size limit. No GitHub credentials are
needed by desktop clients, even though the source repository is private.
