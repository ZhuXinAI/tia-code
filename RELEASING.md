# Releasing TIA Code

This repository is prepared for an initial `0.1.0` npm release. The package exposes `tia-code` as its executable, includes only the compiled `dist/` output and README, and rebuilds/tests itself through `prepack` before `npm pack` or `npm publish`.

## One-time release decisions

1. This project is released under the MIT License.
2. The canonical source repository is `https://github.com/ZhuXinAI/tia-code`; package metadata links to it for the npm page.
3. Keep the unscoped package name only if it remains available. Check it immediately before publishing:

   ```sh
   npm view tia-code name version
   ```

   An `E404` response means it is available; a returned package means choose another name. It was available in the npm registry when this checklist was prepared, but npm names can be claimed at any time.

## Publish `tia-code`

From the repository root, after the above decisions are complete:

```sh
# Confirm the intended release version and clean working tree.
npm pkg get name version
git status --short

# Authenticate the npm account that should own the unscoped package.
npm login
npm whoami

# Validate the exact artifact npm will receive. `prepack` runs build and tests.
npm pack --dry-run
npm pack
tar -tf tia-code-0.1.0.tgz

# Publish only after reviewing the tarball.
npm publish --access public
```

`npm publish` is the irreversible step. Run it yourself once the tarball and package metadata look right.

## Verify the public install

After publishing:

```sh
npm view tia-code version
npm install -g tia-code
tia-code --help

# First-time provider/model/API-key setup in the target workspace.
cd /path/to/project
tia-code

# Later, scriptable non-interactive use.
tia-code run "Summarize this repository."
```

For a later release, update the version with `npm version patch` (or `minor` / `major`), commit and tag the result, rerun the artifact checks above, then publish.
