# Releasing Shuttle

The repository publishes two npm packages, versioned together:

- `@swirls/shuttle`: the React parts, the API contract and the run events. `packages/shuttle`
  assembles it from `@shuttle/react`, `@shuttle/api` and `@shuttle/core`, with module subpaths
  (`@swirls/shuttle/react`, `@swirls/shuttle/api`, `@swirls/shuttle/core/workspace`,
  `@swirls/shuttle/core/pulls`).
- `@swirls/shuttle-engine`: what a host runs sessions on. `packages/shuttle-engine` assembles it
  from `@shuttle/engine`, `@shuttle/sandbox`, `@shuttle/git` and `@shuttle/runner-protocol`. It
  depends on the exact `@swirls/shuttle` it was built with.

The `@shuttle/*` packages remain private build units, used as source by the apps here. A changeset
for either published package releases both at the same version.

## Version policy

Shuttle uses SemVer and Changesets.

- Before 1.0, use `patch` for compatible fixes and `minor` for features or breaking changes.
- From 1.0 onward, use `patch` for fixes, `minor` for compatible features, and `major` for breaking
  changes.
- Every user-visible package change needs a changeset. Internal refactors with no published effect
  do not.
- Stable releases use the npm `latest` tag. Preview releases use Changesets prerelease mode and the
  `next` tag.

The package's version is independent of the backend's. The parts talk to a Shuttle Worker through
the contract in `@swirls/shuttle/api` and the events in `@swirls/shuttle/core`; a change to either
that an older Worker or an older host cannot read is a breaking change, whatever else is in it.

## Normal release

1. Add a changeset on the feature branch:

   ```sh
   bun run changeset
   ```

2. Merge the feature PR after CI passes.
3. The Release workflow opens or updates the `Release @swirls/shuttle` PR.
4. Review its changelog and version. Merging it runs the full verification and packed-package smoke
   tests, publishes to npm, creates the `@swirls/shuttle@x.y.z` tag, and creates a GitHub release.
5. Approve the version on npmjs.com if npm holds it as a staged publish, confirm the npm page
   shows provenance, and install the released version in a clean project.

Do not run `changeset publish` from a developer checkout during the normal flow.

## Authentication

npm lets a package name its trusted publisher only once the package exists, so the first version
is published by hand by someone with rights to the `@swirls` scope, from a clean checkout of the
commit the version pull request produced:

```sh
bun run check:package
cd packages/shuttle && npm publish --access public
cd ../shuttle-engine && npm publish --access public
```

Then, on npmjs.com, add this repository's `release.yml` workflow and its `npm` environment as
each package's trusted publisher. This holds for each package by itself: `@swirls/shuttle-engine`
needs its own first publish by hand, after `@swirls/shuttle` of the same version is on npm. Every release after that goes through the workflow.

Publishing uses npm trusted publishing from `.github/workflows/release.yml` in the protected
`npm` GitHub environment. The workflow authenticates through GitHub OIDC and records npm
provenance. Maintainers do not need npm tokens for routine releases.

## Preview releases

Enter prerelease mode on a branch with `bun x changeset pre enter next`, add or update changesets,
and allow the release flow to publish with the `next` tag recorded by Changesets. Exit with
`bun x changeset pre exit` before preparing the next stable release. Never move `latest` to a
preview version.

## Verification and recovery

`bun run check:package` builds the internal packages, assembles `@swirls/shuttle`, inspects the npm
tarball, installs it into a temporary project outside the repository, loads what needs no browser
in Node, type-checks every entry point along with the declarations it ships, and bundles a page
built from the parts. It never publishes.

npm can hold a publish as a staged version that a maintainer approves on npmjs.com. While it
waits, the version does not answer at its own npm address. A push to main that arrives before the
approval finds the version absent, and npm refuses the publish of a second staged version. The
Release workflow ends successfully in that case and prints the version to approve, because the
staged version is what gets released. If the staged version is wrong, reject it on npmjs.com and
ship the correction as a new version: a rerun stages the same version again.

If a release fails before npm accepts it, fix the cause and rerun the workflow. If npm accepted the
version but tag or GitHub release creation failed, do not reuse or republish that version; create
the matching tag and release from the Version Packages commit. For a bad published version, ship a
fix and move `latest` to it. Use `npm deprecate` for a dangerous version. Avoid unpublishing except
when npm policy and incident response explicitly require it.

If the package published but `latest` points to the wrong version:

```sh
npm dist-tag add @swirls/shuttle@<good-version> latest
```
