# v0.7.7

# Base node image
FROM node:20-alpine AS node

RUN apk --no-cache add curl g++ make python3

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

USER node

COPY --chown=node:node . .

RUN \
    # Allow mounting of these files, which have no default
    touch .env ; \
    # Create directories for the volumes to inherit the correct permissions
    mkdir -p /app/client/public/images /app/api/logs ; \
    npm config set fetch-retry-maxtimeout 600000 ; \
    npm config set fetch-retries 5 ; \
    npm config set fetch-retry-mintimeout 15000 ; \
    npm install --no-audit; \
    # Explicitly install rollup for Alpine Linux
    npm install @rollup/rollup-linux-x64-musl; \
    # Build the packages separately first
    npm run build:data-provider && \
    npm run build:mcp && \
    npm run build:data-schemas && \
    # Then build the client
    cd client && NODE_OPTIONS="--max-old-space-size=2048" npm run build && cd .. && \
    # Verify client dist directory is properly created
    ls -la /app/client/dist && \
    # Cleanup
    npm prune --production && \
    npm cache clean --force

RUN mkdir -p /app/client/public/images /app/api/logs

# Node API setup
EXPOSE 3080
ENV HOST=0.0.0.0
CMD ["npm", "run", "backend"]

# Optional: for client with nginx routing
# FROM nginx:stable-alpine AS nginx-client
# WORKDIR /usr/share/nginx/html
# COPY --from=node /app/client/dist /usr/share/nginx/html
# COPY client/nginx.conf /etc/nginx/conf.d/default.conf
# ENTRYPOINT ["nginx", "-g", "daemon off;"]