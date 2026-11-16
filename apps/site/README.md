# shuttle.codes

The landing page (`public/`) and the desktop app downloads, as one small Worker.

```bash
bun run dev      # http://127.0.0.1:8791
bun run deploy   # to shuttle.codes
```

## Publishing a desktop build

Builds live in the `shuttle-releases` R2 bucket and are served from `/download/<file name>`.

```bash
# in apps/desktop, after `bun run package`
bun x wrangler r2 object put shuttle-releases/Shuttle-<version>-arm64.dmg \
  --file release/Shuttle-<version>-arm64.dmg \
  --content-type application/x-apple-diskimage --remote
```

Then set `LATEST_MAC` in `wrangler.jsonc` to the new file name, update the version and size
shown in `public/index.html`, and deploy. `/download/mac` always sends people to `LATEST_MAC`.
