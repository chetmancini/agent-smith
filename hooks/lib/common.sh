#!/bin/bash
# Common utilities for hook scripts

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_block() {
    echo -e "${RED}[BLOCKED]${NC} $1" >&2
}

log_debug() {
    if [ "${DEBUG:-0}" = "1" ]; then
        echo -e "${BLUE}[DEBUG]${NC} $1" >&2
    fi
}

# Check if a command exists
command_exists() {
    command -v "$1" &>/dev/null
}

# Get file extension
get_extension() {
    local file="$1"
    echo "${file##*.}"
}
