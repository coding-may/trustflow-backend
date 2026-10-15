# Multi-stage build for TrustFlow Backend
# Produces lightweight, secure multi-architecture images (amd64/arm64)

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S trustflow -u 1001

WORKDIR /app

# Copy production dependencies and built code
COPY --from=builder --chown=trustflow:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=trustflow:nodejs /app/dist ./dist
COPY --from=builder --chown=trustflow:nodejs /app/package*.json ./

# Switch to non-root user
USER trustflow

# Expose application port
EXPOSE 3000

# Use dumb-init to handle signals properly (SIGTERM/SIGINT)
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/main.js"]
