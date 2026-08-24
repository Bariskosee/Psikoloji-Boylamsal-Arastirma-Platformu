#!/usr/bin/env python3
"""Validate exact-destination, cost and residency approval fail-closed."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn


CONFIG_DIR = Path(os.environ.get("LPR_RESTIC_CONFIG_DIR", "/etc/lpr/restic"))
APPROVAL_FILE = CONFIG_DIR / "cost-residency-approval"
REPOSITORY_FILE = CONFIG_DIR / "repository"
LINE = re.compile(r"([A-Z][A-Z0-9_]*)=(.*)")
REQUIRED = {
    "APPROVED_AT",
    "DATA_RESIDENCY_APPROVED",
    "DESTINATION",
    "MAX_REPOSITORY_BYTES",
    "NO_BILLABLE_OVERAGE_ENFORCED",
    "OFF_VM",
    "REPOSITORY_SHA256",
    "STABLE_ORIGIN_CONFIRMED",
    "ZERO_RECURRING_COST_CONFIRMED",
}
MINIMUM_SAFETY_MARGIN_BYTES = 67_108_864


def fail(message: str) -> NoReturn:
    raise SystemExit(f"restic approval error: {message}")


def assert_private(path: Path, *, directory: bool) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"missing {path}")
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    expected_mode = 0o700 if directory else 0o600
    if stat.S_ISLNK(metadata.st_mode) or not expected_type(metadata.st_mode):
        fail(f"{path} must be a regular non-symlink {'directory' if directory else 'file'}")
    if metadata.st_uid != os.getuid():
        fail(f"{path} must be owned by uid {os.getuid()}")
    if stat.S_IMODE(metadata.st_mode) != expected_mode:
        fail(f"{path} must have mode {expected_mode:o}")
    if not directory and metadata.st_size == 0:
        fail(f"{path} must not be empty")


def read_approval() -> dict[str, str]:
    assert_private(CONFIG_DIR, directory=True)
    assert_private(APPROVAL_FILE, directory=False)
    assert_private(REPOSITORY_FILE, directory=False)
    values: dict[str, str] = {}
    for line_number, source in enumerate(
        APPROVAL_FILE.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = source.strip()
        if not line or line.startswith("#"):
            continue
        match = LINE.fullmatch(line)
        if match is None:
            fail(f"invalid KEY=VALUE line {line_number} in {APPROVAL_FILE}")
        key, value = match.groups()
        if key in values:
            fail(f"duplicate {key} in {APPROVAL_FILE}")
        values[key] = value
    missing = sorted(REQUIRED - values.keys())
    if missing:
        fail(f"missing {', '.join(missing)} in {APPROVAL_FILE}")
    return values


def validate(values: dict[str, str], *, require_stable_origin: bool) -> None:
    for key in (
        "OFF_VM",
        "ZERO_RECURRING_COST_CONFIRMED",
        "NO_BILLABLE_OVERAGE_ENFORCED",
        "DATA_RESIDENCY_APPROVED",
    ):
        if values[key] != "yes":
            fail(f"{key} must be yes before any off-site operation")
    if require_stable_origin and values["STABLE_ORIGIN_CONFIRMED"] != "yes":
        fail("STABLE_ORIGIN_CONFIRMED must be yes before enrolling participants")

    destination = values["DESTINATION"]
    if not destination or destination.startswith("replace_"):
        fail("DESTINATION must name the operator-approved bucket and region")

    approved_repository_hash = values["REPOSITORY_SHA256"]
    if re.fullmatch(r"[0-9a-f]{64}", approved_repository_hash) is None:
        fail("REPOSITORY_SHA256 must be the lowercase SHA-256 of the repository file")
    actual_repository_hash = hashlib.sha256(REPOSITORY_FILE.read_bytes()).hexdigest()
    if actual_repository_hash != approved_repository_hash:
        fail("repository file does not match the operator-approved REPOSITORY_SHA256")

    repository_limit = values["MAX_REPOSITORY_BYTES"]
    if not repository_limit.isascii() or not repository_limit.isdecimal():
        fail("MAX_REPOSITORY_BYTES must be a positive integer")
    if int(repository_limit) <= MINIMUM_SAFETY_MARGIN_BYTES:
        fail("MAX_REPOSITORY_BYTES must exceed the 64 MiB safety margin")

    maximum_age = os.environ.get("MAX_APPROVAL_AGE_SECONDS", "2592000")
    if not maximum_age.isascii() or not maximum_age.isdecimal():
        fail("MAX_APPROVAL_AGE_SECONDS must be a nonnegative integer")
    try:
        approved = datetime.strptime(values["APPROVED_AT"], "%Y-%m-%d").replace(
            tzinfo=timezone.utc
        )
    except ValueError as error:
        fail(f"APPROVED_AT must be YYYY-MM-DD: {error}")
    age = int((datetime.now(timezone.utc) - approved).total_seconds())
    if age < 0 or age > int(maximum_age):
        fail("APPROVED_AT is stale or from the future")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-stable-origin", action="store_true")
    parser.add_argument("--get", choices=["MAX_REPOSITORY_BYTES", "REPOSITORY_SHA256"])
    arguments = parser.parse_args()
    values = read_approval()
    validate(values, require_stable_origin=arguments.require_stable_origin)
    if arguments.get is not None:
        print(values[arguments.get])


if __name__ == "__main__":
    main()
