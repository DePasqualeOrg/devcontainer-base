# Pinned by digest, so the Node.js base changes only when this line does; move it to a newer node:24
# release deliberately, reading the new digest from the registry. The apt packages and the npm
# globals below still resolve at each build, the npm globals subject to the release cooldown.
FROM node:24@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

ENV DEVCONTAINER=true
ENV NODE_ENV=development

ARG CLAUDE_CONFIG_DIR=/home/node/.claude
ENV CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR

ARG GEMINI_CONFIG_DIR=/home/node/.gemini

ARG CODEX_CONFIG_DIR=/home/node/.codex

ARG NPM_GLOBAL_DIR=/usr/local/share/npm-global

# Label for cleanup identification
LABEL image-name="devcontainer-base"

# Install additional tools needed for Claude Code (most basics already included)
RUN apt-get update && apt-get install -y --no-install-recommends \
  # Core tools
  git sudo procps dnsutils \
  # Shell tools
  fzf less man-db lsof bash-completion \
  # Utilities
  unzip gnupg2 jq aggregate \
  # Search and file tools
  ripgrep fd-find tree \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set up the npm global directory, and npm's supply-chain policy, which matches the host's: no
# version published less than 3 days ago, and no package install scripts.
RUN mkdir -p ${NPM_GLOBAL_DIR} && \
  chown -R node:node /usr/local/share && \
  printf 'prefix=%s\nmin-release-age=3\nignore-scripts=true\n' "${NPM_GLOBAL_DIR}" > /home/node/.npmrc

# Create workspace and config directories
RUN mkdir -p /workspace ${CLAUDE_CONFIG_DIR} ${GEMINI_CONFIG_DIR} ${CODEX_CONFIG_DIR} && \
  chown -R node:node /workspace ${CLAUDE_CONFIG_DIR} ${GEMINI_CONFIG_DIR} ${CODEX_CONFIG_DIR}

# Set up bash history persistence
RUN mkdir -p /commandhistory && \
  touch /commandhistory/.bash_history && \
  chown -R node:node /commandhistory
ENV PROMPT_COMMAND='history -a'
ENV HISTFILE=/commandhistory/.bash_history

# Copy custom bash configuration
COPY .bashrc_custom /home/node/.bashrc_custom
RUN chown node:node /home/node/.bashrc_custom

# Source custom bash configuration
RUN echo 'source ~/.bashrc_custom' >> /home/node/.bashrc

# Add the npm global dir, where the agent CLIs install, and the user-local bin to PATH, so they
# resolve in non-login shells too (e.g. `scripts/dx <cmd>`, which execs directly rather than via
# a login shell).
ENV PATH="${NPM_GLOBAL_DIR}/bin:/home/node/.local/bin:$PATH"

# Enable Corepack so the pnpm/yarn shims exist for every project, and never prompt to
# download a package manager at runtime. Each project fetches the version its package.json
# pins while its image builds (`RUN pnpm --version`), so throwaway dev containers don't
# depend on the network/DNS to provision pnpm on first use.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Brings a project's node_modules volume up to date with its manifests before each command;
# see the script. Projects on other bases copy it from this image (`COPY --from`).
COPY --chmod=755 sync-dependencies /usr/local/bin/sync-dependencies

# Install Claude Code, Gemini, Codex, and npm-check-updates as the node user, through npm, so the
# release cooldown above applies to every one of them. Claude Code's binary arrives as its platform
# package; its own install script, the one script run here, only links that binary into place.
# Its auto-updater is off: it reinstalls through npm, where scripts are disabled, so an update would
# leave the unlinked stub in place of the binary. A new version arrives with the next image.
ENV DISABLE_AUTOUPDATER=1
USER node
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex npm-check-updates \
  && node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs" \
  && claude --version \
  && npm cache clean --force

# Enforce the supply-chain "minimum release age" policy for pnpm in every container:
# don't resolve npm versions published less than 3 days ago (4320 minutes), matching the
# host and the projects. pnpm 11 reads this only from pnpm-workspace.yaml or the global pnpm config
# (config.yaml) — NOT from .npmrc — so write it to the node user's global pnpm config.
RUN mkdir -p /home/node/.config/pnpm \
  && printf 'minimumReleaseAge: 4320\n' > /home/node/.config/pnpm/config.yaml

WORKDIR /workspace
