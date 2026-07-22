# Releasing Fauna

Fauna releases follow Semantic Versioning and use annotated Git tags in the form `vX.Y.Z`.

## Version contract

- `package.json` and `faunaMCP-main/package.json` must equal the tag without its `v` prefix.
- Each product's lockfile must carry the same version as its package manifest.
- `PATCH` is for backward-compatible fixes, `MINOR` is for backward-compatible features, and `MAJOR` is for incompatible behavior or data contracts.
- Relay, mobile, and browser-extension versions are independent unless they are intentionally part of the same coordinated release.
- A release tag is immutable. Correct a bad release with a new patch version rather than moving an existing tag.

The release workflow runs `npm run release:check -- vX.Y.Z` before building. A version mismatch prevents all installer jobs from starting.

## Release process

1. Update Fauna and FaunaMCP manifests and lockfiles to the intended version.
2. Run `npm run release:check -- vX.Y.Z`.
3. Run the test suite and commit the version change.
4. Create an annotated tag: `git tag -a vX.Y.Z -m "Fauna vX.Y.Z"`.
5. Push the commit and tag.

The `Release Installers` workflow builds signed macOS arm64/x64 DMGs and a Windows x64 installer for both Fauna products. It then creates a GitHub release with generated notes and uploads the installer assets.

Manual workflow dispatch accepts a tag and checks out that exact tag before building.

## Update channels

Packaged Fauna installs default to the `stable` channel. Stable selects the highest compatible SemVer from recent non-draft, non-prerelease GitHub releases, compares it with the installed app version, downloads the platform and architecture-specific Fauna installer, and installs it automatically. On macOS, Fauna verifies the staged app's strict code signature, bundle identifier, and Developer ID team before replacing the running bundle. The swap keeps a rollback copy until the new app is installed successfully.

Users can explicitly enable `beta` under **Settings > About > App Updates**. Beta tracks the GitHub `main` commit and retains the source-download, dependency-install, and local-build workflow. Stable users never receive raw `main` updates and do not need a local Node.js toolchain.

The selected channel is stored under Electron user data in `self-update/preferences.json`. Changing channels clears stale availability state before checking the newly selected feed.