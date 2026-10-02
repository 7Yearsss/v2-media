"""Set the deployment mode without replacing existing credentials."""
import argparse
import os
import stat
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--mode", required=True, choices=["production-worker"])
parser.add_argument("--file", type=Path, default=Path("apps/server/.env"))
args = parser.parse_args()
target = args.file.resolve(strict=True)
original = target.read_text(encoding="utf-8")
lines = original.splitlines(keepends=True)
updated = "".join(line for line in lines if line.strip().split("=", 1)[0].strip() != "V2MEDIA_RUNTIME_MODE")
if updated and not updated.endswith("\n"):
    updated += "\n"
updated += f"V2MEDIA_RUNTIME_MODE={args.mode}\n"
descriptor, temporary = tempfile.mkstemp(prefix=".runtime-", dir=target.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
        output.write(updated)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(f"Runtime configured: {args.mode}")
