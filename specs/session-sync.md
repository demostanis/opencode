# Session sync

Session sync transfers conversation histories through `~/.local/share/opencode-sync`.
It is not a worktree or Git snapshot backup.

## Subagents

Each exported conversation includes its regular descendant sessions, including
nested subagents and their complete messages and tool records. Imported children
retain parent relationships rather than becoming independent top-level chats.
Task references are translated to the receiving host's session IDs without
rewriting user text or saved source-file contents. Cross-conversation resumed
tasks retain their owning tree; forwarding them also publishes that dependency.
Teammate sessions remain excluded.

Changes to a child refresh its root archive. The first run after upgrading queues
existing histories again, including children the old implementation marked as
exported without transferring. This can recover old subagent histories only if
they still exist in a source host's database.

Local edits or activity in an imported tree are preserved: incoming conflicting
revisions create a separate tree. Missing or corrupt archive components do not
partially replace an imported conversation.

## Format and retention

- Small trees use version 2 inline archives. Version 3 manifests reference
  content-addressed session nodes when the combined tree exceeds 50 MB.
- Each serialized node and manifest is limited to 50 MB; this is not an aggregate
  tree-data limit. File attachments up to 5 MB can be inlined.
- The importer still accepts version 1 root-only archives. Older binaries do not
  understand the new formats; update both sending and receiving hosts.
- Two archive revisions are retained. Legacy child archives are preserved during
  the upgrade rather than deleted before a replacement is available.
- Content-addressed node garbage collection is not implemented. Unreferenced
  nodes remain on disk, so storage usage can grow.

Saved tool metadata can contain full edited-file contents and aid recovery, but
sync does not guarantee restoration of files, rendered outputs, or worktrees.
