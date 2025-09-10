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

# Add npm global directory to PATH
ENV PATH="${NPM_GLOBAL_DIR}/bin:$PATH"

# Install Claude Code, Gemini, Codex, and npm-check-updates as node user
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN npm install -g @google/gemini-cli @openai/codex npm-check-updates && npm cache clean --force

WORKDIR /workspace
