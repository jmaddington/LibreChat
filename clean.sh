echo "Removing node_modules"
rm -rf node_modules/ packages/*/node_modules/ api/node_modules/ client/node_modules/

echo "Installing primary dependencies with package-lock"
npm ci || npm install

echo "Installing our fork-specific dependencies"
npm install cheerio @e2b/code-interpreter better-sqlite3 e2b --save-dev

echo "Building packages"
npm run build:data-provider
npm run build:data-schemas
npm run build:mcp

echo "Running frontend"
npm run frontend

echo "Running backend"
npm run backend