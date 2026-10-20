// UIKit must precede iSH headers: iSH defines macros used by Apple headers.
// clang-format off
#import <UIKit/UIKit.h>
#include <fcntl.h>
#include <unistd.h>
#include "kernel/task.h"
#include "kernel/calls.h"
#include "probe.h"
// clang-format on

/* Standalone controlled probe; never registered as a Moose native module. */
static NSString *results;
static NSString *guestRoot;
static void exited(struct task *task, int status) {
  if (task->parent)
    return;
  @autoreleasepool {
    [@{
      @"waitStatus" : @(status),
      @"exitCode" : @(status >> 8)
    } writeToFile:[results stringByAppendingPathComponent:@"exit.plist"]
        atomically:YES];
  }
}
static void *run_guest(void *unused) {
  @autoreleasepool {
    int input = open("/dev/null", O_RDONLY);
    int output = open([[results stringByAppendingPathComponent:@"stdout"]
                          fileSystemRepresentation],
                      O_WRONLY | O_CREAT | O_TRUNC, 0600);
    int errors = open([[results stringByAppendingPathComponent:@"stderr"]
                          fileSystemRepresentation],
                      O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (input < 0 || output < 0 || errors < 0)
      return NULL;
    dup2(input, 0);
    dup2(output, 1);
    dup2(errors, 2);
    close(input);
    close(output);
    close(errors);
    exit_hook = exited;
    const char *argv[] = {
        "/bin/sh", "-c",
        "printf 'cwd=%s env=%s arg=%s\\n' \"$PWD\" \"$PROBE\" \"$1\"; "
        "if test -f native-saved; then printf 'reopened='; cat native-saved; "
        "fi; "
        "printf persistent > native-saved; (printf 'pipeline\\n' | cat) & "
        "wait; "
        "printf 'stderr-probe\\n' >&2; exit 7",
        "probe", "literal; $(false)"};
    const char *env[] = {"PROBE=explicit"};
    int error =
        moose_ish_probe_boot([[guestRoot stringByAppendingPathComponent:@"data"]
                                 fileSystemRepresentation],
                             "/workspace", 5, argv, 1, env);
    [@(error).description
        writeToFile:[results stringByAppendingPathComponent:@"boot-error"]
         atomically:YES
           encoding:NSUTF8StringEncoding
              error:nil];
  }
  return NULL;
}
@interface ProbeDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation ProbeDelegate
- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *view = [UIViewController new];
  view.view.backgroundColor = UIColor.systemBackgroundColor;
  UILabel *label = [[UILabel alloc] initWithFrame:CGRectMake(20, 80, 350, 150)];
  label.text = @"iSH native feasibility probe\nResults in Documents/probe\nNo "
               @"model connection";
  label.numberOfLines = 0;
  [view.view addSubview:label];
  self.window.rootViewController = view;
  [self.window makeKeyAndVisible];
  NSString *documents = NSSearchPathForDirectoriesInDomains(
                            NSDocumentDirectory, NSUserDomainMask, YES)
                            .firstObject;
  results = [documents stringByAppendingPathComponent:@"probe"];
  NSFileManager *fm = NSFileManager.defaultManager;
  [fm createDirectoryAtPath:results
      withIntermediateDirectories:YES
                       attributes:nil
                            error:nil];
  [fm removeItemAtPath:[results stringByAppendingPathComponent:@"exit.plist"]
                 error:nil];
  NSString *root = [documents stringByAppendingPathComponent:@"root"];
  NSError *copyError = nil;
  if (![fm fileExistsAtPath:root] &&
      ![fm copyItemAtPath:[NSBundle.mainBundle.bundlePath
                              stringByAppendingPathComponent:@"root"]
                   toPath:root
                    error:&copyError]) {
    [copyError.description
        writeToFile:[results stringByAppendingPathComponent:@"boot-error"]
         atomically:YES
           encoding:NSUTF8StringEncoding
              error:nil];
    return YES;
  }
  guestRoot = root;
  pthread_t thread;
  int error = pthread_create(&thread, NULL, run_guest, NULL);
  if (!error)
    pthread_detach(thread);
  else
    [@(error).description
        writeToFile:[results stringByAppendingPathComponent:@"boot-error"]
         atomically:YES
           encoding:NSUTF8StringEncoding
              error:nil];
  return YES;
}
@end
int main(int argc, char **argv) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil,
                             NSStringFromClass(ProbeDelegate.class));
  }
}
