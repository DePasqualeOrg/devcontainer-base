FROM node:24

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

# Set up npm global directory with proper permissions and config
RUN mkdir -p ${NPM_GLOBAL_DIR} && \
  chown -R node:node /usr/local/share && \
  echo "prefix=${NPM_GLOBAL_DIR}" > /home/node/.npmrc

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

# Add the npm global dir and the user-local bin to PATH. The Claude CLI installs to
# /home/node/.local/bin; including it here makes `claude` resolve in non-login shells
# too (e.g. `scripts/dx <cmd>`, which execs directly rather than via a login shell).
ENV PATH="${NPM_GLOBAL_DIR}/bin:/home/node/.local/bin:$PATH"

# Enable Corepack so the pnpm/yarn shims exist for every project, and never prompt to
# download a package manager at runtime. Each project pre-fetches its own pinned version
# in its Dockerfile (`corepack prepare pnpm@<version> --activate`), so throwaway dev
# containers don't depend on the network/DNS to provision pnpm on first use.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install Claude Code, Gemini, Codex, and npm-check-updates as node user. Scrub the
# Claude CLI's first-run state (an anonymous machineID/userID + backups it writes on
# install) in the same layer, so the published base carries no per-machine identifiers;
# each container regenerates them at runtime.
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && rm -rf /home/node/.claude/.claude.json /home/node/.claude/backups /home/node/.claude/downloads
RUN npm install -g @google/gemini-cli @openai/codex npm-check-updates && npm cache clean --force

# Enforce the supply-chain "minimum release age" policy for pnpm in every container:
# don't resolve npm versions published less than 7 days ago (10080 minutes), matching the
# host policy. pnpm 11 reads this only from pnpm-workspace.yaml or the global pnpm config
# (config.yaml) — NOT from .npmrc — so write it to the node user's global pnpm config.
RUN mkdir -p /home/node/.config/pnpm \
  && printf 'minimumReleaseAge: 10080\n' > /home/node/.config/pnpm/config.yaml

WORKDIR /workspace
