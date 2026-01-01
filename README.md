[![ESLint Code Quality Checks](https://github.com/jmaddington/LibreChat/actions/workflows/eslint-ci.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/eslint-ci.yml)
[![Backend Unit Tests](https://github.com/jmaddington/LibreChat/actions/workflows/backend-review.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/backend-review.yml)
[![Frontend Unit Tests](https://github.com/jmaddington/LibreChat/actions/workflows/frontend-review.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/frontend-review.yml)
[![Accessibility Tests](https://github.com/jmaddington/LibreChat/actions/workflows/a11y.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/a11y.yml)
[![Docker Build and Push to GHCR](https://github.com/jmaddington/LibreChat/actions/workflows/deploy-jm.yml/badge.svg)](https://github.com/jmaddington/LibreChat/actions/workflows/deploy-jm.yml)
<!-- Docker Build Only badge will appear after first workflow run -->
[![Docker Build Only](https://img.shields.io/badge/Docker%20Build%20Only-Ready-blue)](https://github.com/jmaddington/LibreChat/actions/workflows/deploy-jm-build-only.yml)

# About this Fork

This fork began as personal project to add a few features to LibreChat and integrate features from other forks, but is becoming a standalone fork to move faster.

## Branches

`main` - The main branch for this fork for production use. Stable-ish, but has been at least minimally tested.
`main-upstream` - A clone of the upstream main branch.
`new/feature/X` - Branches for new features, kept open until they are feature complete and merged.

## Known Changes from danny-avila/LibreChat

- E2B.dev code interpreter added to the tools list
- Web Navigator plugin added to the tools list.
- QuickChart plugin added to the tools list.
- TimeAPI.io plugin added to the tools list.
- Conversation pinning (based on [henricook's work](https://github.com/danny-avila/LibreChat/pull/7550))
- Left sidebar resize
- Collections Tool added
- ✅ MERGED UPSTREAM - OpenWeather - Weather plugin added to the tools list.
- ✅ MERGED UPSTREAM - Flux AI plugin added to the tools list.


## Merge Instructions

The following files should be taken from our fork (not in upstream):

**Workflows:**
- `.github/workflows/jm-assign-copilot-reviewer.yml`
- `.github/workflows/jm-backend-review.yml`
- `.github/workflows/jm-build-only.yml`
- `.github/workflows/jm-deploy-beta.yml`
- `.github/workflows/jm-deploy.yml`
- `.github/workflows/jm-eslint-ci.yml`
- `.github/workflows/jm-frontend-review.yml`
- `.github/workflows/jm-upstream-sync.yml`

**Tool files:**
- `api/app/clients/tools/structured/CollectionExport.js`
- `api/app/clients/tools/structured/Collections.js`
- `api/app/clients/tools/structured/E2BCode.js`
- `api/app/clients/tools/structured/E2BCode.md`
- `api/app/clients/tools/structured/QuickLCMemory.js` *(alpha, likely to be removed)*
- `api/app/clients/tools/structured/Quickchart.js`
- `api/app/clients/tools/structured/TimeAPI.js`
- `api/app/clients/tools/structured/WebNavigator.js`
- `api/app/clients/tools/structured/WordPress.js` *(alpha, likely to be removed)*

**Assets:**
- `client/public/assets/collections-tree.png`
- `client/public/assets/collections-trees-export.png`
- `client/public/assets/e2b_symbol.png`
- `client/public/assets/quickchart_bar_chart_logo.svg`
- `client/public/assets/quicklcmemory.png`
- `client/public/assets/timeapi.svg`
- `client/public/assets/webnavigator.png`

**Shell scripts (fork-only):**
- `build-local.sh`
- `clean.sh`
- `config/setup-embedding-cron.sh`

These files need to be merged:

- `api/app/clients/tools/manifest.json`
- `api/app/clients/tools/index.js`
- `api/app/clients/tools/util/handleTools.js`
- `.gitignore` - This is the gitignore for this fork.

After you've merged but before you commit, run `./clean.sh` _from inside the devcontainer`

This will update the package and package lock files, so long as you properly took the files from upstream.


After the merge is complete, run `./build-local.sh` to ensure things build on your machine. After that, push the tracking branch dnd open a PR from the tracking branch into `main` or `beta` as appropriate.