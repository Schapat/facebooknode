# ============================================
# Facebook Automation Docker Service
# Multi-stage build (HTTP-only, no browser)
# ============================================

FROM node:20-slim AS builder

WORKDIR /app

# Copy shared types
COPY shared-types/package.json shared-types/tsconfig.json ./shared-types/
COPY shared-types/src ./shared-types/src

# Build shared types
WORKDIR /app/shared-types
RUN npm install && npm run build

# Copy docker service
WORKDIR /app
COPY docker-service/package.json docker-service/tsconfig.json ./docker-service/

# Install dependencies
WORKDIR /app/docker-service
RUN npm install

# Copy source and build
COPY docker-service/src ./src
RUN npm run build

# ============================================
# Production stage
# ============================================
FROM node:20-slim AS production

WORKDIR /app

# Copy built shared types
COPY --from=builder /app/shared-types/dist ./shared-types/dist
COPY --from=builder /app/shared-types/package.json ./shared-types/

# Copy built service
COPY --from=builder /app/docker-service/dist ./docker-service/dist
COPY --from=builder /app/docker-service/package.json ./docker-service/
COPY --from=builder /app/docker-service/node_modules ./docker-service/node_modules

WORKDIR /app/docker-service

# Create data directories
RUN mkdir -p /data

# Create non-root user
RUN groupadd -r automation && useradd -r -g automation automation \
    && chown -R automation:automation /app /data

# Install gosu for dropping privileges after fixing permissions
RUN apt-get update -qq && apt-get install -y -qq gosu --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Entrypoint script to fix volume permissions then drop to automation user
RUN printf '#!/bin/sh\nchown -R automation:automation /data 2>/dev/null || true\nexec gosu automation "$@"\n' > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const http = require('http'); const options = { hostname: 'localhost', port: 3000, path: '/health', timeout: 5000 }; const req = http.request(options, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.end();"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
