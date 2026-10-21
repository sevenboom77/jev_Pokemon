"""Download and verify the AGNES Arena demonstration and historical records."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def fetch(record: dict, manifest: dict) -> None:
    target = (ROOT / record["target"]).resolve()
    if not target.is_relative_to(ROOT):
        raise ValueError("Asset destination escapes repository")
    receipt = target / ".release-asset.json"
    if target.exists():
        if record["kind"] == "file" and target.is_file() and digest(target) == record["sha256"]:
            print(f"Verified existing: {record['target']}")
            return
        if record["kind"] == "tar.gz" and receipt.is_file():
            prior = json.loads(receipt.read_text(encoding="utf-8"))
            if prior.get("sha256") == record["sha256"]:
                print(f"Already restored: {record['target']}")
                return
        raise FileExistsError(f"Refusing to replace an existing target: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    url = (
        f"https://github.com/{manifest['repository']}/releases/download/"
        f"{manifest['release']}/{record['asset']}"
    )
    print(f"Downloading {record['asset']} ({record['bytes']:,} bytes)")
    with tempfile.TemporaryDirectory(prefix=".arena-download-", dir=target.parent) as folder:
        download = Path(folder) / "download"
        with urlopen(Request(url, headers={"User-Agent": "AGNES-Arena-assets"}), timeout=120) as response:
            with download.open("wb") as output:
                shutil.copyfileobj(response, output)
        if download.stat().st_size != record["bytes"] or digest(download) != record["sha256"]:
            raise ValueError(f"Asset size or SHA256 mismatch: {record['asset']}")
        if record["kind"] == "file":
            ready = download
        elif record["kind"] == "tar.gz":
            ready = Path(folder) / "restored"
            ready.mkdir()
            count = 0
            with tarfile.open(download, "r:gz") as archive:
                for member in archive:
                    destination = (ready / member.name).resolve()
                    if not destination.is_relative_to(ready.resolve()):
                        raise ValueError("Archive member escapes target")
                    if not member.isfile():
                        raise ValueError("Only regular files are accepted in the history archive")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output)
                    count += 1
            if count != record["extracted_files"]:
                raise ValueError("History archive file count mismatch")
            (ready / ".release-asset.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        else:
            raise ValueError("Unsupported asset kind")
        if target.exists():
            raise FileExistsError(f"Target appeared during download: {target}")
        ready.rename(target)
    print(f"Ready: {record['target']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--video", action="store_true")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "release-assets.json").read_text(encoding="utf-8"))
    if args.list:
        for record in manifest["assets"]:
            print(f"{record['id']:8} {record['target']:30} {record['bytes']:,} bytes")
        return
    selected = {name for name in ("history", "video") if args.all or getattr(args, name)}
    if not selected:
        parser.error("Choose --history, --video, --all or --list")
    for record in manifest["assets"]:
        if record["id"] in selected:
            fetch(record, manifest)


if __name__ == "__main__":
    main()
