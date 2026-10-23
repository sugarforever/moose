#!/usr/bin/env python3
"""Build pinned upstream iSH, not a host-shell replacement. macOS/Apple Silicon."""
import argparse
import hashlib
from pathlib import Path
import plistlib
import shutil
import subprocess
import urllib.request

REVISION = 'c5ebcabec14f1d8709e91e1905ce0edd7cb9c13c'
ROOTFS_URL = 'https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86/alpine-minirootfs-3.23.0-x86.tar.gz'
ROOTFS_SHA256 = '855408b4682ce72b098e87106a4456eea11b6b816b6bc0ea5910ac3a8bd50a8c'
REPO = Path(__file__).resolve().parents[2]
NATIVE = REPO / 'native' / 'ish'


def run(*argv, **kwargs):
    return subprocess.run([str(arg) for arg in argv], check=True, **kwargs)


def capture(*argv):
    return subprocess.check_output([str(arg) for arg in argv], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True, type=Path,
                        help='Dedicated disposable build directory outside the repository')
    parser.add_argument('--simulator', action='store_true')
    args = parser.parse_args()
    cache = args.cache.resolve()
    if cache == REPO or REPO in cache.parents:
        parser.error('--cache must be outside the repository')
    cache.mkdir(parents=True, exist_ok=True)
    source = cache / 'ish'
    if not source.exists():
        run('git', 'init', source)
        run('git', '-C', source, 'remote', 'add', 'origin', 'https://github.com/ish-app/ish.git')
        run('git', '-C', source, 'fetch', '--depth', '1', 'origin', REVISION)
        run('git', '-C', source, 'checkout', '--detach', REVISION)
    if capture('git', '-C', source, 'rev-parse', 'HEAD') != REVISION:
        raise RuntimeError('Unexpected upstream revision; use a fresh cache directory')
    if capture('git', '-C', source, 'status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('Refusing a modified upstream tree')
    host = cache / 'host'
    common = ['-Dbuildtype=release', '-Dno_crlf=true']
    if not (host / 'build.ninja').exists():
        run('meson', 'setup', host, source, *common)
    run('ninja', '-C', host, 'libish.a', 'libish_emu.a', 'libfakefs.a', 'tools/fakefsify')
    libraries = [host / name for name in ('libish.a', 'libish_emu.a', 'libfakefs.a')]
    compiler_flags = ['-O2', '-DENGINE_ASBESTOS=1', f'-I{source}', f'-I{host}', f'-I{NATIVE}']
    runner = host / 'moose-ish-probe'
    run('clang', *compiler_flags, NATIVE / 'host.c', NATIVE / 'probe.c',
        *libraries, '-lsqlite3', '-lpthread', '-o', runner)
    tarball = cache / 'alpine.tar.gz'
    if not tarball.exists():
        with urllib.request.urlopen(ROOTFS_URL, timeout=60) as response:
            # Reject oversized/error downloads before writing a rootfs.
            data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise RuntimeError('Rootfs download exceeds bound')
        tarball.write_bytes(data)
    if hashlib.sha256(tarball.read_bytes()).hexdigest() != ROOTFS_SHA256:
        raise RuntimeError('Rootfs SHA-256 mismatch')
    root = cache / 'root'
    if not root.exists():
        run(host / 'tools/fakefsify', tarball, root)
        run(runner, root / 'data', '/', '--', '/bin/mkdir', '-p', '/workspace')
    run('python3', REPO / 'scripts/ish/test_guest.py', '--runner', runner, '--root', root / 'data')
    if not args.simulator:
        return
    sdk = capture('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path')
    cross = cache / 'simulator.cross'
    # Meson's cross-file syntax is Python-like; repr preserves spaces in SDK paths.
    cross.write_text("[binaries]\nc = " + repr(['/usr/bin/clang', '-target',
        'arm64-apple-ios15.0-simulator', '-isysroot', sdk]) +
        "\nar = '/usr/bin/ar'\nstrip = '/usr/bin/strip'\n[host_machine]\n"
        "system = 'darwin'\ncpu_family = 'aarch64'\ncpu = 'arm64'\nendian = 'little'\n")
    sim = cache / 'simulator'
    if not (sim / 'build.ninja').exists():
        run('meson', 'setup', sim, source, '--cross-file', cross, *common)
    run('ninja', '-C', sim, 'libish.a', 'libish_emu.a', 'libfakefs.a')
    app = cache / 'MooseISHProbe.app'
    app.mkdir(exist_ok=True)
    run('xcrun', '--sdk', 'iphonesimulator', 'clang', '-target', 'arm64-apple-ios15.0-simulator',
        '-O2', '-fobjc-arc', '-DENGINE_ASBESTOS=1', f'-I{source}', f'-I{sim}', f'-I{NATIVE}',
        NATIVE / 'probe.c', NATIVE / 'simulator.m',
        *[sim / name for name in ('libish.a', 'libish_emu.a', 'libfakefs.a')],
        '-framework', 'UIKit', '-framework', 'Foundation', '-lsqlite3', '-lpthread',
        '-o', app / 'MooseISHProbe')
    with (app / 'Info.plist').open('wb') as output:
        plistlib.dump(dict(CFBundleExecutable='MooseISHProbe', CFBundleIdentifier='dev.moose.ishprobe',
            CFBundleName='Moose iSH Probe', CFBundleVersion='1', CFBundleShortVersionString='0.1',
            CFBundlePackageType='APPL', LSRequiresIPhoneOS=True, MinimumOSVersion='15.0',
            UIDeviceFamily=[1, 2], UILaunchScreen={}), output)
    if (app / 'root').exists():
        shutil.rmtree(app / 'root')
    shutil.copytree(root, app / 'root')
    # Local ad-hoc signing only. Does not publish or produce a distributable IPA.
    run('codesign', '--force', '--sign', '-', app)
    print(f'Simulator app built at {app}; install with xcrun simctl install booted <path>')


if __name__ == '__main__':
    main()
