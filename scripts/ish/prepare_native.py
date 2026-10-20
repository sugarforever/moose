#!/usr/bin/env python3
"""Prepare the optional iOS module's ignored, locally linked iSH artifacts.

Requires Xcode, Meson, Ninja, LLVM + LLD, libarchive and pkg-config. Does not
publish binaries or decide the whole-program redistribution license.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from build_probe import REVISION, ROOTFS_URL, ROOTFS_SHA256, REPO


def run(*args):
    subprocess.run([str(x) for x in args], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True, type=Path)
    args = parser.parse_args()
    cache = args.cache.resolve()
    if cache == REPO or REPO in cache.parents:
        parser.error('--cache must be outside the repository')
    vendor = REPO / 'modules/moose-ish/vendor'
    stage = cache / 'module-stage'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    outputs = []
    for sdk in ('iphoneos', 'iphonesimulator'):
        output = cache / ('module-' + sdk)
        run(sys.executable, REPO / 'scripts/ish/build_embedded.py', '--cache', cache,
            '--sdk', sdk, '--output', output)
        outputs.append(output)
    run('xcodebuild', '-create-xcframework',
        '-library', outputs[0] / 'libMooseISHCore.a', '-headers', outputs[0] / 'include',
        '-library', outputs[1] / 'libMooseISHCore.a', '-headers', outputs[1] / 'include',
        '-output', stage / 'MooseISHCore.xcframework')
    shutil.copytree(outputs[0] / 'root', stage / 'root')
    licenses = stage / 'licenses'
    licenses.mkdir()
    # Exact upstream license texts, not summaries.
    source = cache / 'ish'
    for name in ('LICENSE.md', 'LICENSE.IOS'):
        shutil.copy2(source / name, licenses / name)
    shutil.copy2(REPO / 'native/ish/NOTICE.md', licenses / 'MOOSE-ISH-NOTICE.md')
    tracked = subprocess.check_output(['git', '-C', str(REPO), 'ls-files',
        'native/ish', 'scripts/ish', 'modules/moose-ish'], text=True).splitlines()
    # Include uncommitted embedding files too: manifest describes this actual build.
    paths = set(tracked)
    for directory in ('native/ish', 'scripts/ish', 'modules/moose-ish/ios'):
        paths.update(str(path.relative_to(REPO)) for path in (REPO / directory).rglob('*')
                     if path.is_file() and '__pycache__' not in path.parts)
    manifest = {
        'ishRevision': REVISION,
        'ishSource': 'https://github.com/ish-app/ish',
        'rootfs': {'url': ROOTFS_URL, 'sha256': ROOTFS_SHA256,
                   'packages': 'Alpine 3.23.0 x86 minirootfs; inspect root/data/lib/apk/db/installed',
                   'sourceRepository': 'https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.23-stable'},
        'localSourceSHA256': {path: hashlib.sha256((REPO / path).read_bytes()).hexdigest()
                              for path in sorted(paths) if (REPO / path).is_file()},
        'rebuild': 'python3 scripts/ish/prepare_native.py --cache /absolute/external/cache',
        'redistribution': 'Local build only. Before redistribution supply exact corresponding whole-app source, build tools/instructions, iSH modifications, all package sources/licenses, and select a compatible whole-program license. This manifest is not corresponding source.'}
    (stage / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if vendor.exists():
        shutil.rmtree(vendor)
    shutil.copytree(stage, vendor)
    print(f'Prepared local module artifacts: {vendor}. Rebuild the iOS development client.')


if __name__ == '__main__':
    main()
