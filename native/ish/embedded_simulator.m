/* Dedicated disposable UIKit test application for the real embedded core. */
#import <UIKit/UIKit.h>
#include <pthread.h>
extern int moose_ish_embedded_test_main(int, char **);
static NSString *directory;
static void *run_tests(void *unused) {
  @autoreleasepool {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *seed = [NSBundle.mainBundle.resourcePath
        stringByAppendingPathComponent:@"root"];
    NSMutableArray *paths = [NSMutableArray array];
    for (NSString *name in @[ @"a", @"b" ]) {
      NSString *path = [directory stringByAppendingPathComponent:name];
      [fm removeItemAtPath:path error:nil];
      NSError *error = nil;
      if (![fm copyItemAtPath:seed toPath:path error:&error]) {
        [error.description
            writeToFile:[directory stringByAppendingPathComponent:@"error"]
             atomically:YES
               encoding:NSUTF8StringEncoding
                  error:nil];
        return NULL;
      }
      [paths addObject:[path stringByAppendingPathComponent:@"data"]];
    }
    char *args[] = {"embedded-test",
                    (char *)[paths[0] fileSystemRepresentation],
                    (char *)[paths[1] fileSystemRepresentation]};
    int result = moose_ish_embedded_test_main(3, args);
    [@{
      @"exitCode" : @(result),
      @"hostAlive" : @YES
    } writeToFile:[directory stringByAppendingPathComponent:@"result.plist"]
        atomically:YES];
  }
  return NULL;
}
@interface EmbeddedDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation EmbeddedDelegate
- (BOOL)application:(UIApplication *)app
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *view = [UIViewController new];
  view.view.backgroundColor = UIColor.systemBackgroundColor;
  self.window.rootViewController = view;
  [self.window makeKeyAndVisible];
  directory = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                   NSUserDomainMask, YES)
                   .firstObject stringByAppendingPathComponent:@"embedded"];
  [NSFileManager.defaultManager createDirectoryAtPath:directory
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:nil];
  pthread_t thread;
  pthread_create(&thread, NULL, run_tests, NULL);
  pthread_detach(thread);
  return YES;
}
@end
int main(int argc, char **argv) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil,
                             NSStringFromClass(EmbeddedDelegate.class));
  }
}
