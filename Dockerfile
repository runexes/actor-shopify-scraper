FROM apify/actor-node:20

COPY package*.json ./

RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" \
 && (npm list --omit=dev --omit=optional --all || true) \
 && echo "Node.js version:" \
 && node --version \
 && echo "NPM version:" \
 && npm --version

COPY . ./

ENV APIFY_DISABLE_OUTDATED_WARNING=1
ENV npm_config_loglevel=silent
