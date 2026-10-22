"""Run the egress-probe tests without pytest.

pytest is not installed in the Pier environment, and the probe is pure Python plus
one shell string, so a tiny runner is enough for the repo's own CI-free check.
"""

import importlib.util
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

spec = importlib.util.spec_from_file_location("test_egress_probe", HERE / "test_egress_probe.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

failures = 0
names = [name for name in dir(module) if name.startswith("test_")]
for name in sorted(names):
    try:
        getattr(module, name)()
        print(f"PASS {name}")
    except Exception:
        failures += 1
        print(f"FAIL {name}")
        traceback.print_exc()
print(f"{len(names) - failures}/{len(names)} passed")
sys.exit(1 if failures else 0)
