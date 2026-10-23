#!/usr/bin/env python3
"""Build reproducibly patched, pinned embedded iSH without modifying pristine source."""
import argparse
import hashlib
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
from build_probe import REVISION, ROOTFS_SHA256, REPO, NATIVE, run, capture


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache',required=True,type=Path)
    p.add_argument('--sdk',choices=['macosx','iphonesimulator','iphoneos'],default='macosx')
    p.add_argument('--output',required=True,type=Path)
    a=p.parse_args(); cache=a.cache.resolve(); output=a.output.resolve()
    if cache==REPO or REPO in cache.parents: p.error('--cache must be outside repository')
    source=cache/'ish'
    if not (cache/'root/data').exists():
        run(sys.executable,REPO/'scripts/ish/build_probe.py','--cache',cache)
    if capture('git','-C',source,'rev-parse','HEAD')!=REVISION: raise RuntimeError('Wrong upstream revision')
    if capture('git','-C',source,'status','--porcelain','--untracked-files=no'): raise RuntimeError('Modified pristine tree')
    patch=NATIVE/'embedded-policy.patch'
    identity=hashlib.sha256(patch.read_bytes()).hexdigest()
    embedded=cache/'embedded-source'
    stamp=embedded/'.moose-policy'
    if not stamp.exists() or stamp.read_text()!=identity:
        if embedded.exists(): shutil.rmtree(embedded)
        embedded.mkdir()
        archive=subprocess.check_output(['git','-C',str(source),'archive',REVISION])
        subprocess.run(['tar','-x','-C',str(embedded)],input=archive,check=True)
        with patch.open('rb') as stream:
            subprocess.run(['patch','-p1','-i',str(patch)],cwd=embedded,check=True)
        stamp.write_text(identity)
        for old in cache.glob('embedded-build-*'): shutil.rmtree(old)
    build=cache/f'embedded-build-{a.sdk}'
    flags=['-O2','-DENGINE_ASBESTOS=1',f'-I{embedded}',f'-I{build}',f'-I{NATIVE}']
    common=['-Dbuildtype=release','-Dno_crlf=true']
    if a.sdk!='macosx':
        sdk=capture('xcrun','--sdk',a.sdk,'--show-sdk-path')
        target='arm64-apple-ios15.0'+('-simulator' if a.sdk=='iphonesimulator' else '')
        flags+=['-target',target,'-isysroot',sdk]
        cross=cache/f'embedded-{a.sdk}.cross'
        cross.write_text("[binaries]\nc = "+repr(['/usr/bin/clang','-target',target,'-isysroot',sdk])+"\nar = '/usr/bin/ar'\nstrip = '/usr/bin/strip'\n[host_machine]\nsystem = 'darwin'\ncpu_family = 'aarch64'\ncpu = 'arm64'\nendian = 'little'\n")
        common+=['--cross-file',cross]
    if not (build/'build.ninja').exists(): run('meson','setup',build,embedded,*common)
    run('ninja','-C',build,'libish.a','libish_emu.a','libfakefs.a')
    output.mkdir(parents=True,exist_ok=True)
    obj=build/'moose-embedded.o'
    run('/usr/bin/clang',*flags,'-c',NATIVE/'embedded.c','-o',obj)
    run('libtool','-static','-o',output/'libMooseISHCore.a',obj,*[build/n for n in ['libish.a','libish_emu.a','libfakefs.a']])
    (output/'include').mkdir(exist_ok=True)
    shutil.copy2(NATIVE/'embedded.h',output/'include/embedded.h')
    seed=cache/'embedded-seed-v2'
    if not seed.exists():
        tarball=cache/'alpine.tar.gz'
        if hashlib.sha256(tarball.read_bytes()).hexdigest()!=ROOTFS_SHA256:
            raise RuntimeError('Rootfs SHA-256 mismatch')
        run(cache/'host/tools/fakefsify',tarball,seed)
    seed_stamp=output/'.moose-seed-version'
    if not seed_stamp.exists() or seed_stamp.read_text()!='2':
        if (output/'root').exists(): shutil.rmtree(output/'root')
        shutil.copytree(seed,output/'root')
        seed_stamp.write_text('2')
    if a.sdk in ('macosx','iphonesimulator'):
        guest=build/'moose-resource-test'
        run('/usr/bin/clang','--target=i386-linux-gnu','-O2','-fomit-frame-pointer',
            '-fno-stack-protector','-fno-pic','-ffreestanding','-nostdlib','-static',
            '-fuse-ld=lld','-Wl,-e,_start',NATIVE/'embedded_guest_test.c','-o',guest)
        data=guest.read_bytes()
        (build/'embedded_guest_bytes.h').write_text(
            'static const unsigned char guest_resource_test[] = {'+
            ','.join(map(str,data))+'};\n')
    if a.sdk=='macosx':
        for name,sourcefile in [('moose-ish-exec','embedded_host.c'),('moose-ish-core-test','embedded_test.c')]:
            run('/usr/bin/clang',*flags,NATIVE/sourcefile,output/'libMooseISHCore.a','-lsqlite3','-lpthread','-o',output/name)
    if a.sdk=='iphonesimulator':
        app=output/'MooseISHEmbeddedTest.app';app.mkdir(exist_ok=True)
        testobj=build/'moose-test.o'
        run('/usr/bin/clang',*flags,'-Dmain=moose_ish_embedded_test_main','-c',NATIVE/'embedded_test.c','-o',testobj)
        run('/usr/bin/clang',*flags,'-fobjc-arc',NATIVE/'embedded_simulator.m',testobj,output/'libMooseISHCore.a','-framework','UIKit','-framework','Foundation','-lsqlite3','-lpthread','-o',app/'MooseISHEmbeddedTest')
        with (app/'Info.plist').open('wb') as stream:
            plistlib.dump(dict(CFBundleExecutable='MooseISHEmbeddedTest',CFBundleIdentifier='dev.moose.ishembeddedtest',CFBundleName='Moose iSH Embedded Test',CFBundleVersion='1',CFBundleShortVersionString='0.1',CFBundlePackageType='APPL',LSRequiresIPhoneOS=True,MinimumOSVersion='15.0',UIDeviceFamily=[1,2],UILaunchScreen={}),stream)
        if (app/'root').exists(): shutil.rmtree(app/'root')
        shutil.copytree(output/'root',app/'root')
        run('codesign','--force','--sign','-',app)
    print(output)

if __name__=='__main__': main()
