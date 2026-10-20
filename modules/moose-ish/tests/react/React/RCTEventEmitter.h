#import "RCTBridgeModule.h"
@interface RCTEventEmitter : NSObject
- (void)invalidate;
- (void)sendEventWithName:(NSString *)name body:(id)body;
@end
