# ============================================
# Facebook Automation Docker Service
# Multi-stage build for Playwright + Chromium
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

# Install Playwright system dependencies + Chromium
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-symbola \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built shared types
COPY --from=builder /app/shared-types/dist ./shared-types/dist
COPY --from=builder /app/shared-types/package.json ./shared-types/

# Copy built service
COPY --from=builder /app/docker-service/dist ./docker-service/dist
COPY --from=builder /app/docker-service/package.json ./docker-service/
COPY --from=builder /app/docker-service/node_modules ./docker-service/node_modules

WORKDIR /app/docker-service

# Install Playwright browsers
RUN npx playwright install chromium

# Create data directories
RUN mkdir -p /data/contexts /data/screenshots /data/html-dumps

# Create non-root user
RUN groupadd -r automation && useradd -r -g automation -G audio,video automation \
    && chown -R automation:automation /app /data

USER automation

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
ENV BROWSER_HEADLESS=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const http = require('http'); const options = { hostname: 'localhost', port: 3000, path: '/health', timeout: 5000 }; const req = http.request(options, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.end();"

CMD ["node", "dist/index.js"]
