#!/usr/bin/env python3
"""Run production bridge/core tests in a disposable iOS simulator application."""
import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--core',type=Path,required=True,help='build_embedded.py --sdk iphonesimulator output')
p.add_argument('--output',type=Path,required=True,help='Disposable external app build directory')
a=p.parse_args();here=Path(__file__).resolve().parent;out=a.output.resolve();repo=here.parents[2]
if out==repo or repo in out.parents:p.error('--output must be outside repository')
out.mkdir(parents=True,exist_ok=True)
app=out/'MooseISHBridgeTest.app';app.mkdir(exist_ok=True)
source=(here/'bridge_harness.m').read_text().replace('int main(int argc,char **argv)', 'static int bridgeMain(int argc,char **argv)').replace('  dispatch_main();','  return 0;')
source+='''
#import <UIKit/UIKit.h>
@interface Delegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation Delegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
 self.window=[[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];self.window.rootViewController=[UIViewController new];[self.window makeKeyAndVisible];
 const char *seed=[NSBundle.mainBundle pathForResource:@"root" ofType:nil].fileSystemRepresentation;
 char *args[]={"bridge-test",(char *)seed};bridgeMain(2,args);return YES;
}
@end
int main(int argc,char **argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(Delegate.class));}}
'''
(out/'bridge_simulator.m').write_text(source)
sdk=subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],text=True).strip()
subprocess.run(['xcrun','--sdk','iphonesimulator','clang','-target','arm64-apple-ios15.1-simulator','-isysroot',sdk,'-fobjc-arc','-fblocks','-I'+str(here),'-I'+str(here/'react'),'-I'+str(a.core/'include'),str(out/'bridge_simulator.m'),str(a.core/'libMooseISHCore.a'),'-framework','Foundation','-framework','UIKit','-lsqlite3','-lpthread','-o',str(app/'MooseISHBridgeTest')],check=True)
if(app/'root').exists():shutil.rmtree(app/'root')
shutil.copytree(a.core/'root',app/'root')
with(app/'Info.plist').open('wb') as f:
 plistlib.dump(dict(CFBundleExecutable='MooseISHBridgeTest',CFBundleIdentifier='dev.moose.ishbridgetest',CFBundleName='Moose iSH Bridge Test',CFBundleVersion='1',CFBundleShortVersionString='0.1',CFBundlePackageType='APPL',LSRequiresIPhoneOS=True,MinimumOSVersion='15.1',UIDeviceFamily=[1,2],UILaunchScreen={}),f)
subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
subprocess.run(['xcrun','simctl','install','booted',str(app)],check=True)
result=subprocess.run(['xcrun','simctl','launch','--console','--terminate-running-process','booted','dev.moose.ishbridgetest'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
print(result.stdout)
if 'production native bridge:' not in result.stdout or 'cleanup passed' not in result.stdout:raise SystemExit('Simulator bridge tests did not complete successfully')
