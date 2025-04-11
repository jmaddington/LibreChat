echo "Removing node_modules"
rm -rf node_modules/

echo "Running ci"

npm ci

echo "Installing our fork-specific dependencies"
npm install cheerio @e2b/code-interpreter better-sqlite3 --save

echo "Running frontend"
npm run frontend

echo "Running backend"
npm run backend