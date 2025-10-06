# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Install timezone data for proper cron operation and su-exec for entrypoint
RUN apk add --no-cache tzdata su-exec

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S smartthings -u 1001

# Change ownership of app directory
RUN chown -R smartthings:nodejs /app

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Note: We don't switch to USER smartthings here
# The entrypoint will fix volume permissions and then switch to smartthings user

# Expose port 3000 for web interface
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Set entrypoint to handle permissions
ENTRYPOINT ["docker-entrypoint.sh"]

# Start the application
CMD ["npm", "start"]