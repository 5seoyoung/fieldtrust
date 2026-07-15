"""Make the python/ package importable when running pytest from the repo root
without installing it (CI installs it with `pip install -e python/`)."""

import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent.parent / "python"
if str(PKG_DIR) not in sys.path:
    sys.path.insert(0, str(PKG_DIR))
