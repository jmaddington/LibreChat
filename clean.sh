echo "Removing node_modules"
find ./ -type d -name node_modules -exec rm -rf {} \;

echo "Running ci"
npm ci

echo "Installing our fork-specific dependencies"
npm install cheerio @e2b/code-interpreter better-sqlite3 --save

echo "Running frontend"
npm run frontend

echo "Running backend"
npm run backend