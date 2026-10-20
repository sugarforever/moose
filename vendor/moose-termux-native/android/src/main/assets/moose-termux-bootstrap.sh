set -eu
umask 077
# Arguments come only from native validation: loopback URL, pinned hash, public key.
url="$1"; expected="$2"; public_key="$3"
root="$HOME/.moose-termux"
mkdir -p "$root"
chmod 700 "$root"
# The package manager owns its own database locks; if two initial setups race,
# one can fail cleanly and retry. No mkdir lock can survive a killed process.
if ! command -v flock >/dev/null 2>&1; then
  if ! pkg install -y util-linux >/dev/null 2>&1; then
    echo 'Locking tools installation failed. Open Termux, install util-linux, then retry.' >&2; exit 24
  fi
fi
exec 8>"$root/.install.flock"
if ! flock -n 8; then
  echo 'Moose setup already in progress; retry after it finishes.' >&2; exit 21
fi
# Keep descriptor 9 exclusively owned through deployment and service lifetime.
# Persistent lock *files* are harmless: the kernel releases ownership on exit,
# SIGKILL, force-stop or reboot. Never delete these files while a holder exists.
exec 9>"$root/.service.flock"
if ! flock -n 9; then
  echo 'A Moose service launch is already active. Check the existing service before retrying.' >&2; exit 23
fi
tmp=''
cleanup() { [ -z "$tmp" ] || rm -f "$tmp"; }
trap cleanup EXIT
trap 'exit 22' HUP INT TERM
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1; }
if ! node_ok; then
  if ! pkg install -y nodejs-lts >/dev/null 2>&1; then echo 'Node installation failed. Open Termux and check pkg configuration.' >&2; exit 24; fi
fi
if ! node_ok; then echo 'Node 22.19 or newer is required.' >&2; exit 25; fi
tmp=$(mktemp "$root/.service.XXXXXXXX")
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 30 --max-filesize 33554432 "$url" -o "$tmp" 2>/dev/null; then
  echo 'Bundled service transfer failed or setup was cancelled.' >&2; exit 26
fi
if ! printf '%s  %s\n' "$expected" "$tmp" | sha256sum -c - >/dev/null 2>&1; then
  echo 'Bundled service checksum mismatch.' >&2; exit 27
fi
chmod 600 "$tmp"
mv -f "$tmp" "$root/service.mjs"
tmp=''
# Node inherits the service lock, but must not retain the installer lock.
nohup node "$root/service.mjs" "$public_key" 8>&- </dev/null >/dev/null 2>&1 &
# Service output is discarded: no growing logs or provider secrets on disk.
echo 'Moose service launched; waiting for the signed connection check.'
