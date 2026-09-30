# nvim-sidekick-references

Adds the **`read_reference` tool** to Pi. Run `/reload` or restart Pi to activate.

User prompts are never rewritten. There is no input hook, automatic file read, or
synthetic tool-call injection. A short tool guideline tells the model to read
references only when their contents are needed, not merely quoted as examples.
The model makes an ordinary tool call; file contents appear in its tool result.

```json
{
  "references": [
    "@src/my file.ts :L3:C2-L7:C4",
    "@hello.py :L21:C6"
  ]
}
```

Batch related references in one call to merge overlaps and avoid repeated reads.
Prefer ranges over whole files. Coordinate rules live in the tool definition, not
in every result; results use one short untrusted-data label and path/range headers.
Source whitespace and content remain unchanged; no automatic summaries or cache
suppression are used.

Already-available content need not be reread unless freshness matters. Like any
model-directed tool, using it is guided rather than guaranteed. It adds a model
round trip, and is not necessarily cheaper than injection for every request.

## Exact references, not prompt parsing

Each array element is one **complete reference**, without surrounding prose.
Paths can contain spaces or `@` characters. The range delimiter is the last
` :L`; no filesystem-based filename guessing or prompt scanning occurs.

If the original inline reference is ambiguous, the model should ask for
clarification instead of guessing which path to pass. A bare reference treats
all text after `@` as the filename; it never falls back to a shorter existing path.
Missing files produce errors, including unresolved bare references.

Paths are relative to Pi's working directory or absolute. No shell expansion is
performed (`~` and environment variables are literal). Newlines and NUL are
unsupported. To refer to a filename containing ` :L`, append an explicit range so
that its final delimiter is unambiguous.

## Selection semantics

| Reference | Returned content |
| --- | --- |
| `@path` | Whole file, subject to output budget |
| `@path :L5` | Line 5 |
| `@path :L5-L9` | Lines 5 through 9 |
| `@path :L12:C5` | Containing line, with cursor position identified separately |
| `@path :L3:C2-C9` | Inclusive byte selection on line 3 |
| `@path :L3:C2-L7:C4` | Inclusive multiline byte selection |

Cursor results clearly distinguish the cursor from its context:

```text
"hello.py" — cursor L21:C6; context: entire line 21
```

Lines and byte columns are 1-based. Columns past the line length clamp to the
final byte (empty lines stay empty). Cursor metadata retains the requested
position and reports clamping. It is not a visual screen-column measurement.

Selections preserve source bytes, including CRLF between selected lines.
Line selections exclude the final selected line's terminator; whole-file reads
preserve the final newline. A final newline does not create an extra line.
Invalid UTF-8 and ranges splitting multibyte characters are rejected rather than
silently rounded or replaced. Binary/NUL-containing files are unsupported.

Relative, dotted and absolute references resolving to the same lexical path share
one read per call. Overlapping, adjacent and contained intervals merge; disjoint
intervals stay separate. Cursor metadata survives merging. Individual selections
are validated before merging. Symlinks are followed, but different aliases are not
deduplicated. There is no cross-call content cache.

## Limits and errors

- 1–32 exact references per call; at most 4096 characters per reference.
- Source files at most 2 MiB. For larger files, use Pi's built-in `read` tool with
  offset/limit instead.
- Combined returned text, including headers, fences and errors: **~4096 estimated
  tokens**, implemented as a 12288-byte UTF-8 budget. The estimate is bytes / 3,
  not an exact tokenizer or a guaranteed token upper bound.
- Oversized selections are omitted whole, with an explicit notice. Retry with
  smaller ranges or fewer references. Smaller later selections may still fit.
- The former ~1024-token bare-file threshold is gone: these reads are explicitly
  requested, not automatic attachments.
- If no selection can be returned, the tool throws an error so Pi marks the call
  failed. Partial successes include error notices for failed references.
- Cancellation is checked before/between reads; open file handles are closed.

Source content is returned directly in fences that adapt to backticks in the
source. It is labeled as untrusted data, not instructions; this framing is not a
security sandbox against prompt injection. Tool details contain counts only,
not duplicate copies of file contents.

**Disk snapshots only:** the tool does not talk to Neovim or see unsaved buffers.
Structured metadata and selected buffer text from Sidekick would be needed to
remove that limitation.

**Privacy:** requested file contents are sent to the model. Absolute paths and
files outside the working directory are allowed. Only pass files you intend to
share. Pasted examples no longer trigger reads automatically, though the model
can still choose to call tools.

## Tests

```sh
node --test extensions/nvim-sidekick-references/*.test.mjs
```

The registration test resolves Pi's actual schema library through the installed
`pi` executable (or `PI_TEST_BINARY`). It verifies that registration exposes only
a tool, with no prompt-transforming hooks.
