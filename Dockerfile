# One container serves the client and the WebSocket. Fly.io, Render, Railway and similar set PORT.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "packages/server/src/index.js"]
