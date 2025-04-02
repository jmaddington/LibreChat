echo "Removing node_modules and package-lock.json"
rm -rf node_modules/
rm package-lock.json
echo "Installing cheerio and @e2b/code-interpreter"
cd api/
npm install cheerio @e2b/code-interpreter
cd ..
echo "Installing dependencies"
npm install
echo "Running ci"
npm ci
echo "Running frontend"
npm run frontend
echo "Running backend"
npm run backend