#!/usr/bin/env bash
# ============================================================================
# Deterministic scratch repository used to verify the RAT metric engine.
#
# Usage: tools/make-scratch-repo.sh <dest-dir>      (dest must end in /scratch)
#
# Every commit has fixed identities and committer dates, so the expected
# metric values documented in tests/verify.js are hand-computable and stable.
#
# History (all 2024-01-xx 12:00:00 +0000):
#   c1  Alice          .mailmap (1 line) + a.txt (10 lines)      +11
#   c2  alice@other    a.txt: remove 2 lines, append 5           +5  -2
#   c3  Alice          pure rename a.txt -> b.txt                 0   0
#   c4  Bob            rename b.txt -> c.txt, -1 line, +3        +3  -1
#   c5  Bob            delete c.txt (15 lines)                    0 -15
#   c6  Bob            add dir1/file.txt (4) + dir2/file2.txt    +6
#   c7  Bob            add logo.bin (BINARY, must be excluded)    0   0
#   c8  Bob            dir1/file.txt append 1                    +1
#   c9  Bob            dir1/file.txt change 1 line               +1  -1
#   c10 Bob            git mv dir1/file.txt dir3/f3.txt, +2      +2
# ============================================================================
set -euo pipefail

DEST="${1:?usage: make-scratch-repo.sh <dest-dir>}"
case "$DEST" in
  */scratch) ;;
  *) echo "refusing: dest must end in /scratch" >&2; exit 1 ;;
esac

rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -q -b main

commit() { # name email isodate message
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" \
  GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" \
  GIT_AUTHOR_DATE="$3" GIT_COMMITTER_DATE="$3" \
  git -c commit.gpgsign=false commit -q -m "$4"
}

ALICE_NAME="Alice Adams";  ALICE_EMAIL="alice@example.com"
ALIAS_NAME="Alias Name";   ALIAS_EMAIL="alice@other.com"
BOB_NAME="Bob Brown";      BOB_EMAIL="bob@example.com"

# --- c1: .mailmap + a.txt (10 lines) ---------------------------------------
printf 'Alice A <alice@example.com> <alice@other.com>\n' > .mailmap
for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; done > a.txt
git add .mailmap a.txt
commit "$ALICE_NAME" "$ALICE_EMAIL" "2024-01-01T12:00:00+00:00" "c1: initial a.txt"

# --- c2: a.txt +5 -2 (authored under the alias email) -----------------------
sed -i '/^line 2$/d;/^line 9$/d' a.txt
for i in 11 12 13 14 15; do echo "line $i"; done >> a.txt
git add a.txt
commit "$ALIAS_NAME" "$ALIAS_EMAIL" "2024-01-02T12:00:00+00:00" "c2: edit a.txt"

# --- c3: pure rename (must contribute zero churn) ---------------------------
git mv a.txt b.txt
commit "$ALICE_NAME" "$ALICE_EMAIL" "2024-01-03T12:00:00+00:00" "c3: pure rename a.txt -> b.txt"

# --- c4: rename + edit (attributed to the new path) -------------------------
git mv b.txt c.txt
sed -i '/^line 4$/d' c.txt
printf 'line 16\nline 17\nline 18\n' >> c.txt
git add c.txt
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-04T12:00:00+00:00" "c4: rename+edit b.txt -> c.txt"

# --- c5: delete (15 removed lines on the old path) --------------------------
git rm -q c.txt
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-05T12:00:00+00:00" "c5: delete c.txt"

# --- c6: two files in two directories ---------------------------------------
mkdir -p dir1 dir2
for i in 1 2 3 4; do echo "f$i"; done > dir1/file.txt
printf 'g1\ng2\n' > dir2/file2.txt
git add dir1 dir2
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-06T12:00:00+00:00" "c6: add dir1 and dir2 files"

# --- c7: binary file (must be excluded from metrics) ------------------------
printf '\x00\x01BINARY\x00DATA\n' > logo.bin
git add logo.bin
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-07T12:00:00+00:00" "c7: add binary logo"

# --- c8: append one line ----------------------------------------------------
printf 'f5\n' >> dir1/file.txt
git add dir1/file.txt
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-08T12:00:00+00:00" "c8: append to dir1/file.txt"

# --- c9: modify one line ----------------------------------------------------
sed -i 's/^f1$/F1/' dir1/file.txt
git add dir1/file.txt
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-09T12:00:00+00:00" "c9: tweak dir1/file.txt"

# --- c10: rename across directories + append --------------------------------
mkdir -p dir3
git mv dir1/file.txt dir3/f3.txt
printf 'f6\nf7\n' >> dir3/f3.txt
git add dir3/f3.txt
commit "$BOB_NAME" "$BOB_EMAIL" "2024-01-10T12:00:00+00:00" "c10: move to dir3 and append"

echo "scratch repo ready at $DEST"
git log --oneline | cat
