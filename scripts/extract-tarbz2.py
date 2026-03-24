from __future__ import annotations

import sys
import tarfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-tarbz2.py <archive.tar.bz2> <dest_dir>")

    archive = Path(sys.argv[1]).resolve()
    dest_dir = Path(sys.argv[2]).resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    with tarfile.open(archive, "r:bz2") as tar:
        tar.extractall(dest_dir)

    print(dest_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
