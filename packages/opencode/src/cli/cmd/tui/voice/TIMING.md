# Voice latency diagnostics

Enabled at the normal INFO log level. Search OpenCode logs for `voice.timing`
(normally `~/.local/share/opencode/log/`; respects XDG_DATA_HOME).
Logs use OpenCode's existing retention policy; report the approximate incident
time promptly so the relevant log can be preserved. No audio, transcript,
prompt, result text, or authentication headers are included in these records.

- `at`: local wall-clock milliseconds, for matching an incident to the log.
- `ms`: monotonic elapsed milliseconds within a voice connection, routing call,
  or delegation handler. Do not subtract `ms` from different scopes.
- `trace` and `pid`: voice connection and TUI process; `id`: delegation or turn ID.
  Turn IDs and delegation IDs are distinct; use timestamps to align them.
- `remote.*`: bridge receipt of remote turn/delegation events, with `source_at`
  and `delivery_ms` to distinguish bridge-to-TUI delay from earlier latency.
- `routing.begin/auth.done/headers/item.done/done`: additional stop-intent model
  call. `routing.skip` means no additional model request was needed.
- `prompt.submit/receipt`: submission and acceptance, not completion of work.
- `command.result`: progress/final delivery back to the voice bridge.
- `receive.state state=speaking`: playback state, not a guaranteed first audible
  sample for a particular request.
- `delegate.rejected.*`, `delegate.failed/aborted/timeout`: failed handoffs.

These timings do not measure physical microphone speech onset/end, server-side
VAD, or network latency separately. A remote turn event is not a microphone
timestamp. The 15-second routing deadline is a maximum, not an intentional wait.

Both the TUI binary and packaged Python voice helpers must be updated together
and restarted for all instrumentation to be active. Clients opt in using
`timing: true` in their start command; older clients do not receive timing events.
