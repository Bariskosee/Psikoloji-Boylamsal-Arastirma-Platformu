#!/usr/bin/env python3
"""Run Restic with validated, non-shell configuration.

The backend credential file is parsed as KEY=VALUE data; it is never sourced
as executable shell code. Repository initialization is intentionally a manual
operator action and this wrapper never performs it implicitly.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import sys
from pathlib import Path
from typing import NoReturn


CONFIG_DIR = Path(os.environ.get("LPR_RESTIC_CONFIG_DIR", "/etc/lpr/restic"))
REPOSITORY_FILE = CONFIG_DIR / "repository"
PASSWORD_FILE = CONFIG_DIR / "password"
BACKEND_ENV_FILE = CONFIG_DIR / "backend.env"
REMOTE_PREFIXES = ("azure:", "b2:", "gs:", "rclone:", "rest:", "s3:", "sftp:", "swift:")
ENVIRONMENT_LINE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)")
FIXED_RESTIC_ENVIRONMENT = {
    "RESTIC_PASSWORD",
    "RESTIC_PASSWORD_COMMAND",
    "RESTIC_PASSWORD_FILE",
    "RESTIC_REPOSITORY",
    "RESTIC_REPOSITORY_FILE",
}
FORBIDDEN_REPOSITORY_ARGUMENTS = {
    "--password-command",
    "--password-file",
    "--repo",
    "--repository-file",
    "-r",
}
FORBIDDEN_EXECUTION_ENVIRONMENT = {
    "BASH_ENV",
    "CDPATH",
    "ENV",
    "GCONV_PATH",
    "HOME",
    "IFS",
    "PATH",
    "PERL5OPT",
    "RUBYOPT",
    "SHELLOPTS",
}
FORBIDDEN_EXECUTION_PREFIXES = ("DYLD_", "LD_", "PYTHON")


def fail(message: str) -> NoReturn:
    raise SystemExit(f"restic configuration error: {message}")


def private_file(path: Path, *, required: bool = True) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        if required:
            fail(f"missing {path}")
        return False

    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        fail(f"{path} must be a regular non-symlink file")
    if metadata.st_uid != os.getuid():
        fail(f"{path} must be owned by uid {os.getuid()}")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        fail(f"{path} must have mode 600")
    if metadata.st_size == 0:
        fail(f"{path} must not be empty")
    return True


def private_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"missing {path}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        fail(f"{path} must be a regular non-symlink directory")
    if metadata.st_uid != os.getuid():
        fail(f"{path} must be owned by uid {os.getuid()}")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        fail(f"{path} must have mode 700")


def one_line(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) != 1 or not lines[0].strip():
        fail(f"{path} must contain exactly one nonempty line")
    return lines[0].strip()


def backend_environment(path: Path) -> dict[str, str]:
    if not private_file(path, required=False):
        return {}

    parsed: dict[str, str] = {}
    for line_number, source in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = source.strip()
        if not line or line.startswith("#"):
            continue
        match = ENVIRONMENT_LINE.fullmatch(line)
        if match is None:
            fail(f"invalid KEY=VALUE line {line_number} in {path}")
        key, value = match.groups()
        if key in FIXED_RESTIC_ENVIRONMENT:
            fail(f"{key} must not be set in {path}")
        if key in FORBIDDEN_EXECUTION_ENVIRONMENT or key.startswith(FORBIDDEN_EXECUTION_PREFIXES):
            fail(f"{key} may influence executable code and must not be set in {path}")
        if "\x00" in value or "\n" in value or "\r" in value:
            fail(f"invalid control character on line {line_number} in {path}")
        parsed[key] = value
    return parsed


def validated_arguments(arguments: list[str]) -> list[str]:
    """Prevent callers from bypassing the validated repository and password files."""

    forbidden_long_prefixes = tuple(
        f"{name}=" for name in FORBIDDEN_REPOSITORY_ARGUMENTS if name.startswith("--")
    )
    for argument in arguments:
        if argument in FORBIDDEN_REPOSITORY_ARGUMENTS or argument.startswith(
            forbidden_long_prefixes
        ):
            fail(f"{argument.split('=', 1)[0]} is managed by this wrapper")
        # Cobra accepts the short repository option as both ``-r value`` and
        # ``-rvalue``. Do not let the latter form evade the exact-match check.
        if argument.startswith("-r") and not argument.startswith("--"):
            fail("-r is managed by this wrapper")
    return arguments


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} <restic arguments...>")
    restic = shutil.which("restic")
    if restic is None:
        fail("restic is not installed")

    private_directory(CONFIG_DIR)
    private_file(REPOSITORY_FILE)
    private_file(PASSWORD_FILE)
    repository = one_line(REPOSITORY_FILE)
    if not repository.startswith(REMOTE_PREFIXES):
        fail("repository must use a recognized remote backend, not local disk")
    if repository.startswith("rest:") and not repository.startswith("rest:https://"):
        fail("REST server repositories must use HTTPS")

    environment = os.environ.copy()
    environment.update(backend_environment(BACKEND_ENV_FILE))
    for key in FIXED_RESTIC_ENVIRONMENT:
        environment.pop(key, None)
    environment["RESTIC_REPOSITORY"] = repository
    environment["RESTIC_PASSWORD_FILE"] = str(PASSWORD_FILE)
    # Execute the already resolved binary as a second line of defence. The
    # backend data may select credentials, but cannot select executable code.
    os.execve(restic, [restic, *validated_arguments(sys.argv[1:])], environment)


if __name__ == "__main__":
    main()
