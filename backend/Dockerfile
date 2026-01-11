FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm install

COPY src ./src

RUN npm run build

EXPOSE 8000

CMD ["node", "dist/index.js"]









# # Multi-stage build for optimized production image

# # Stage 1: Build
# FROM node:18-alpine AS builder

# WORKDIR /app

# # Copy package files
# COPY package*.json ./
# COPY tsconfig.json ./

# # Install all dependencies (including dev dependencies for build)
# RUN npm ci

# # Copy source code
# COPY src ./src

# # Build TypeScript to JavaScript
# RUN npm run build

# # Stage 2: Production
# FROM node:18-alpine

# WORKDIR /app

# # Create non-root user for security
# RUN addgroup -g 1001 -S nodejs && \
#     adduser -S nodejs -u 1001

# # Copy package files
# COPY package*.json ./

# # Install only production dependencies
# RUN npm ci --only=production && \
#     npm cache clean --force

# # Copy built files from builder stage
# COPY --from=builder /app/dist ./dist

# # Change ownership to non-root user
# RUN chown -R nodejs:nodejs /app

# # Switch to non-root user
# USER nodejs

# # Expose the port your app runs on
# EXPOSE 8000


# # Start the application
# CMD ["node", "dist/index.js"]