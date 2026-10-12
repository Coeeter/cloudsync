import base64
import hashlib
import pathlib
import sys
import zipfile

source, destination = map(pathlib.Path, sys.argv[1:])
info = zipfile.ZipInfo("zip.mjs", date_time=(2020, 1, 1, 0, 0, 0))
info.compress_type = zipfile.ZIP_DEFLATED
info.external_attr = 0o644 << 16
with zipfile.ZipFile(destination, "w") as archive:
    archive.writestr(info, source.read_bytes())
digest = base64.b64encode(hashlib.sha256(destination.read_bytes()).digest()).decode()
print(f"ZIP_SHA256={digest}")
print(f"TF_VAR_artifact_sha256={digest}")
