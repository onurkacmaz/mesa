# Injected by pointing ZDOTDIR here before spawning the shell (see
# electron/main.js). Restores the user's real ZDOTDIR immediately so their
# own .zshenv/.zprofile/.zshrc/.zlogin load exactly as normal, then adds our
# own precmd/preexec hooks additively via add-zsh-hook so nothing the user's
# config does is overwritten.
#
# This emits OSC 133 (the same semantic-prompt convention VS Code and
# iTerm2 use) around each command so the terminal UI can draw a divider
# between one command's output and the next prompt.

if [[ -n "$WFTERM_REAL_ZDOTDIR" ]]; then
  export ZDOTDIR="$WFTERM_REAL_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset WFTERM_REAL_ZDOTDIR

_wfterm_real_zdotdir="${ZDOTDIR:-$HOME}"
[[ -f "$_wfterm_real_zdotdir/.zshenv" ]] && source "$_wfterm_real_zdotdir/.zshenv"
unset _wfterm_real_zdotdir

__wfterm_osc() {
  printf '\e]133;%s\a' "$1"
}

# A prompt worth reading: where you are, which branch, whether it is dirty,
# and when the command ran. Colours are named (yellow/cyan/red), never literal
# hex, so they resolve through the terminal's own palette and re-tint with the
# app's light and dark themes for free.
#
# This only ever replaces zsh's stock prompt. Anyone who has set their own —
# starship, p10k, a hand-rolled PROMPT in .zshrc — keeps it untouched.
__wfterm_setup_prompt() {
  case "$PROMPT" in
    '%n@%m %1~ %# '|'%n@%m %~ %# '|'%m%# '|'%# ') ;;
    *) return 0 ;;
  esac

  setopt prompt_subst
  autoload -Uz vcs_info
  zstyle ':vcs_info:*' enable git
  zstyle ':vcs_info:git:*' check-for-changes true
  zstyle ':vcs_info:git:*' unstagedstr '*'
  zstyle ':vcs_info:git:*' stagedstr '+'
  zstyle ':vcs_info:git:*' formats ' %F{cyan}%b%u%c%f'
  # Mid-rebase or mid-merge is the one state worth shouting about.
  zstyle ':vcs_info:git:*' actionformats ' %F{cyan}%b%u%c%f %F{red}%a%f'

  # vcs_info only counts tracked files, so a directory full of brand new ones
  # would look clean. Mark untracked work with a '?'.
  function +vi-git-untracked() {
    if [[ -n $(command git ls-files --others --exclude-standard 2>/dev/null | head -n 1) ]]; then
      hook_com[unstaged]+='?'
    fi
  }
  zstyle ':vcs_info:git*+set-message:*' hooks git-untracked

  __wfterm_vcs=1

  # The chevron is the app's own mark, so the prompt and the pane's glyph are
  # the same character. Time sits on the right, dim, and stays in the
  # scrollback so you can see when each command was run.
  PROMPT='%B%F{yellow}%1~%f%b${vcs_info_msg_0_} %F{yellow}❯%f '
  RPROMPT='%F{8}%*%f'
}

# Shift+Enter, for dropping to the next line. The terminal sends ESC+CR (see
# src/TerminalView.jsx): zsh has no such key of its own, because a terminal
# does not tell Shift+Enter and Enter apart. This widget leaves a real newline
# before the line buffer's cursor, so a second line can be started without the
# command running. A raw LF would not have worked: zsh counts that as a line
# ending too and would run the command.
__wfterm_insert_newline() {
  LBUFFER+=$'\n'
}

# Line-editing keys the app sends. zsh's emacs keymap already has most of
# these; its vi-insert keymap has almost none — there ^[b and ^[f are unbound
# and, worse, ^A and ^E are self-insert, so they would type a control
# character into the line instead of moving the cursor.
#
# Only gaps are filled. A binding the user has deliberately chosen is left
# exactly as it is; the case below matches only "undefined-key" and
# "self-insert", never a real widget.
__wfterm_setup_keys() {
  local km seq widget current
  zle -N __wfterm_insert_newline
  for km in emacs viins; do
    for seq widget in \
      '^[^M' __wfterm_insert_newline \
      '^[b'  backward-word \
      '^[f'  forward-word \
      '^[d'  kill-word \
      '^[^?' backward-kill-word \
      '^A'   beginning-of-line \
      '^E'   end-of-line
    do
      current=$(bindkey -M "$km" "$seq" 2>/dev/null)
      case "$current" in
        *undefined-key*|*self-insert*) bindkey -M "$km" "$seq" "$widget" ;;
      esac
    done
  done
}

__wfterm_precmd() {
  local __wfterm_ec=$?

  if [[ -z $__wfterm_prompt_ready ]]; then
    __wfterm_prompt_ready=1
    __wfterm_setup_prompt
    __wfterm_setup_keys
  fi
  [[ -n $__wfterm_vcs ]] && vcs_info

  # OSC 7 reports the working directory, so the pane's titlebar can show
  # where the session actually is instead of a static label.
  printf '\e]7;file://%s%s\a' "${HOST}" "${PWD}"

  # Blank rows above and below the block boundary. The divider is drawn on the
  # row the D marker lands on, so emitting a line either side leaves it sitting
  # in real whitespace instead of pressed between output and the next prompt.
  # Only after an actual command: a bare Enter should not push the prompt down.
  if [[ -n $__wfterm_ran ]]; then
    print ""
    __wfterm_osc "D;$__wfterm_ec"
    print ""
    unset __wfterm_ran
  else
    __wfterm_osc "D;$__wfterm_ec"
  fi

  __wfterm_osc "A"
}

__wfterm_preexec() {
  __wfterm_ran=1
  __wfterm_osc "C"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __wfterm_precmd
add-zsh-hook preexec __wfterm_preexec
