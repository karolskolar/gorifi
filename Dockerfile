# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app

# Install backend dependencies
COPY backend/package*.json ./
RUN npm install --production

# Copy backend source
COPY backend/src/ ./src/

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist ./public/

# Create data directory for SQLite persistence
RUN mkdir -p /data

ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/data/database.sqlite
EXPOSE 3000

CMD ["node", "src/index.js"]
