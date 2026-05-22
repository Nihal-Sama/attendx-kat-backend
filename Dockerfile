# 1. Use a specific, lightweight Alpine image for a minimal attack surface
FROM node:20-alpine

# 2. Set Node to production mode (optimizes Express performance)
ENV NODE_ENV=production

# 3. Create app directory and set it as the working directory
WORKDIR /usr/src/app

# 4. Copy package files first (Owned by the secure 'node' user)
# We do this before copying the rest of the code to cache the npm install step
COPY --chown=node:node package*.json ./

# 5. Install only production dependencies cleanly
RUN npm ci --only=production

# 6. Copy the rest of the application code securely
COPY --chown=node:node . .

# 7. Security: Switch from 'root' to the restricted 'node' user
USER node

# 8. Expose the port your Express server runs on (change if necessary)
EXPOSE 4001

# 9. Start the application
CMD ["node", "src/server.js"]