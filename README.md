# About this Fork

This fork is a personal project to add a few features to LibreChat and integrate features from other forks.

[![ESLint Code Quality Checks](https://github.com/jmaddington/LibreChat/actions/workflows/eslint-ci.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/eslint-ci.yml)
[![Backend Unit Tests](https://github.com/jmaddington/LibreChat/actions/workflows/backend-review.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/backend-review.yml)
[![Frontend Unit Tests](https://github.com/jmaddington/LibreChat/actions/workflows/frontend-review.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/frontend-review.yml)
[![Accessibility Tests](https://github.com/jmaddington/LibreChat/actions/workflows/a11y.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/a11y.yml)
[![Docker Build and Push to GHCR](https://github.com/jmaddington/LibreChat/actions/workflows/deploy-jm.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/deploy-jm.yml)
<!-- Docker Build Only badge will appear after first workflow run -->
[![Docker Build Only](https://img.shields.io/badge/Docker%20Build%20Only-Ready-blue)](https://github.com/jmaddington/LibreChat/actions/workflows/deploy-jm-build-only.yml)

## Branches
`main` - The main branch for this fork for production use. Stable-ish, but has been at least minimally tested.
`main-upstream` - A clone of the upstream main branch.
`tracking/YYYY/MM/DD-XX` - Tracking branches for specific merges from upstream, with date and sequence number.
`new/feature/X` - Branches for new features, kept open until they are feature complete and merged.

## Known Changes from danny-avila/LibreChat
- E2B.dev code interpreter added to the tools list
- Web Navigator plugin added to the tools list.
- QuickChart plugin added to the tools list.
- TimeAPI.io plugin added to the tools list.
- ✅ MERGED UPSTREAM - OpenWeather - Weather plugin added to the tools list.
- ✅ MERGED UPSTREAM - Flux AI plugin added to the tools list.


## Merge Instructions

### Merging Upstream into Dev/Main

To properly merge changes from upstream (or any branch) while preserving commit history:

1. Update the reference branch (typically `main-upstream`) with upstream changes
2. Checkout the target branch (usually `dev/main` or `main`)
3. Directly merge the source branch into target: `git merge <source-branch>`
4. Resolve any conflicts
5. Push the result

**Important:** Avoid creating intermediate tracking branches that merge in the wrong direction. When you merge, make sure you're merging FROM the source branch INTO your target branch to preserve all commits.

### For Custom Merges with File Selection

If you need to selectively merge files:

1. Create a new tracking branch from the source branch: `tracking/YYYY/MM/DD-XX`
2. Cherry-pick specific files or changes
3. Open a PR from this tracking branch to your target branch

The following files should always be taken from our fork:

 - `.github/workflows/jm*.yml` - These are the CI/CD workflows for this fork.
 - `.devcontainer/*` - This is the devcontainer for this fork.
 - `api/app/clients/tools/structured/E2BCode.js`
 - `api/app/clients/tools/structured/E2BCode.md`
 - `api/app/clients/tools/structured/WebNavigator.js`
 - `api/app/clients/tools/structured/TimeAPI.js`
 - `api/app/clients/tools/structured/QuickChart.js`
 - `client/public/assets/*` related to the tools listed above.
- All `.sh` files.

These files need to be merged:

- `api/app/clients/tools/manifest.json`
- `api/app/clients/tools/index.js`
- `api/app/clients/tools/util/handleTools.js`
- `.gitignore` - This is the gitignore for this fork.

After you've merged but before you commit, run `./clean.sh` _from inside the devcontainer`

This will update the package and package lock files, so long as you properly took the files from upstream.


After the merge is complete, run `./build-local.sh` to ensure things build on your machine. After that, push the tracking branch
and open a PR from the tracking branch into `main` or `dev/main` as appropriate.

### Why E2B?
LibreChat recently introduced their own code interpreter service. It's affordable, integrates seamlessly with their platform, and provides a viable revenue stream. So why not use it?

For our internal needs, however, we require a code interpreter with network access—a feature not offered by LibreChat's interpreter for safety reasons. E2B.dev provides an excellent alternative that meets our specific requirements.

***WE STILL LOVE LIBRECHAT!*** In fact, we're proud to be monthly sponsors. Our choice to use E2B.dev is not about detracting from LibreChat's service; we simply need additional functionality to fulfill our unique needs.