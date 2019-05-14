FROM atomist/sdm-base:0.2.0

LABEL maintainer="The Hoff <docker@atomist.com>"

COPY package.json package-lock.json ./

RUN npm ci \
    && npm cache clean --force

COPY . ./
