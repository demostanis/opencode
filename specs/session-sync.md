# Session sync

Session sync transfers conversation histories through `~/.local/share/opencode-sync`.
It is not a worktree or Git snapshot backup.

## Subagents

Each exported conversation includes its regular descendant sessions, including
nested subagents and their complete messages and tool records. Imported children
retain parent relationships rather than becoming independent top-level chats.
Older descendants created in another directory or project are legitimate tree
members. Each v4 node retains its own project ID, worktree and name; the receiver
creates missing projects and translates session and assistant paths against that
node's project, not its parent's. Existing receiver project locations take priority.
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
Source session mappings remain scoped to their sending host. A revision cannot
adopt an existing child belonging to another tree, even across projects. Graphs
must have unique session/message/part IDs and form one connected acyclic tree.

## Format and retention

- Small trees use version 2 inline archives. Version 3 manifests reference
  content-addressed session nodes when the combined tree exceeds 50 MB.
- Cross-project trees or any individual serialized node exceeding 50 MB use v4.
  Each node has its full serialized SHA-256 and byte size, plus an ordered list
  of content-addressed byte chunks with their own SHA-256 and sizes. Chunks live
  under `nodes/<sha>.bin`; v3 nodes remain `nodes/<sha>.json`.
- Every transported file, including manifests and chunks, is limited to
  50,000,000 bytes. Logical nodes may be much larger (including 370 MB histories);
  there is no aggregate tree-data cap. No messages, tool output or file
  afterimages are dropped, summarized or rewritten to fit. File attachments up
  to 5 MB can be inlined, as before.
- Export writes all immutable chunks before committing a manifest. Import
  validates each chunk's size/hash, ordered total and full-node hash before any
  transaction modifies the imported tree. It concatenates bytes before decoding
  UTF-8, so characters split between chunks remain intact. Missing/corrupt
  delivery leaves the previous revision available and is retried on later scans.
- Fingerprints stream individual nodes rather than stringify the whole tree.
  Individual node serialization/decoding still requires a JavaScript string;
  exceeding the runtime string or allocation limits fails explicitly with
  diagnostics rather than omitting data or acknowledging the export.
- The importer still accepts v1 root-only, v2 inline and v3 node archives. Older
  peers skip unsupported v4 revisions without importing partial trees; update
  both sending and receiving hosts to transfer v4 histories.
- New logical baselines include descendant project metadata. Legacy v1/v2/v3
  baseline hashes remain comparable for same-project trees, including children,
  preserving local IDs on unchanged upgrades. This comparison still checks all
  historical content; local edits or newly cross-project descendants do not
  qualify as unchanged. New baselines never ignore descendant project changes.
- Two archive revisions are retained. Legacy child archives are preserved during
  the upgrade rather than deleted before a replacement is available.
- Content-addressed node/chunk garbage collection is not implemented.
  Unreferenced data remains on disk, so storage usage can grow.

Saved tool metadata can contain full edited-file contents and aid recovery, but
sync does not guarantee restoration of files, rendered outputs, or worktrees.
