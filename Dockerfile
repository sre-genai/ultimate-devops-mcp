# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage (default: no browser — small image)
# For Playwright browser tools, build with:  --build-arg WITH_BROWSER=true
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ARG WITH_BROWSER=false
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Optional: install Chromium + system deps for the browser_* tools
RUN if [ "$WITH_BROWSER" = "true" ]; then \
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 npx playwright install --with-deps chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080
ENV MCP_HTTP_PORT=8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
