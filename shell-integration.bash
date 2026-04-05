# bashpilot shell integration
# Injects OSC 633 escape sequences for command lifecycle tracking.
# Sourced automatically by bashpilot when launching bash.

# Guard against double-sourcing
if [[ "$__BASH_MCP_INJECTED" == "1" ]]; then
    return
fi
__BASH_MCP_INJECTED=1

# Save original PROMPT_COMMAND
__bash_mcp_original_prompt_command="$PROMPT_COMMAND"

# Track state to avoid duplicate emissions
__bash_mcp_in_command=0

# Emit OSC 633 sequence: \e]633;{code}[;{data}]\a
__bash_mcp_osc() {
    printf '\e]633;%s\a' "$1"
}

# Called before each prompt is displayed (precmd equivalent)
__bash_mcp_precmd() {
    local exit_code=$?

    # If we were in a command, emit CommandFinished with exit code
    if [[ "$__bash_mcp_in_command" == "1" ]]; then
        __bash_mcp_osc "D;$exit_code"
        __bash_mcp_in_command=0
    fi

    # Emit PromptStart
    __bash_mcp_osc "A"

    # Run original PROMPT_COMMAND
    if [[ -n "$__bash_mcp_original_prompt_command" ]]; then
        eval "$__bash_mcp_original_prompt_command"
    fi
}

# Called after prompt, before command execution (via DEBUG trap)
__bash_mcp_preexec() {
    # Skip if this is the PROMPT_COMMAND itself or a completion
    if [[ "$BASH_COMMAND" == "__bash_mcp_precmd" ]] || \
       [[ "$BASH_COMMAND" == "${PROMPT_COMMAND}"* ]]; then
        return
    fi

    # Emit CommandStart (user pressed Enter, about to execute)
    __bash_mcp_osc "C"
    __bash_mcp_in_command=1
}

# Install hooks
PROMPT_COMMAND="__bash_mcp_precmd"
trap '__bash_mcp_preexec' DEBUG

# Emit initial PromptStart + CommandStart marker so the first prompt is tracked
__bash_mcp_osc "B"
