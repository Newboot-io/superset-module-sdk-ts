# The sensor-sim sample module. Build from the repository root:
#   docker build --platform linux/amd64 -f samples/sensor-sim/Dockerfile -t sensor-sim .
FROM --platform=linux/amd64 node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /sdk
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# `npm ci` builds the SDK (its prepare script).
RUN npm ci --no-audit --no-fund
WORKDIR /sdk/samples/sensor-sim
COPY samples/sensor-sim/package.json samples/sensor-sim/package-lock.json samples/sensor-sim/tsconfig.json ./
COPY samples/sensor-sim/src ./src
RUN npm ci --no-audit --no-fund && npm run build
# Only runtime dependencies stay, in the sample and in the SDK it links to.
RUN npm prune --omit=dev && cd /sdk && npm prune --omit=dev --ignore-scripts

# Newboot runs the module as uid 10001 on a read-only file system.
FROM --platform=linux/amd64 node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /sdk
COPY --from=build /sdk/package.json ./
COPY --from=build /sdk/dist ./dist
COPY --from=build /sdk/node_modules ./node_modules
WORKDIR /sdk/samples/sensor-sim
COPY --from=build /sdk/samples/sensor-sim/package.json ./
COPY --from=build /sdk/samples/sensor-sim/node_modules ./node_modules
COPY --from=build /sdk/samples/sensor-sim/dist ./dist
USER 10001
EXPOSE 8080
CMD ["node", "dist/main.js"]
